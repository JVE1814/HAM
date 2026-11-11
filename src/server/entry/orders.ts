import { gs, type GlideRecord } from '@servicenow/glide'
import { approvalAwaited, APPROVER, type Approver } from '../domain/approvals.ts'
import { messageOf } from '../domain/errors.ts'
import { readStage } from '../platform/assets.ts'
import { onLineAssetMoved } from '../platform/fulfilment.ts'
import type { NewLine } from '../platform/order-lines.ts'
import {
    cancelOrder,
    rollUpOrderApprovals,
    submitOrder,
    submitProducedOrder,
    submitQueuedOrder,
    type Submission,
} from '../platform/orders.ts'
import { str, type ForeignRecord } from '../platform/records.ts'
import { putBackUntransferred, runSourcingPass } from '../platform/sourcing.ts'
import { sourcingRequestOf } from '../platform/sourcing-requests.ts'
import { fellShortOfStagingCentre } from '../platform/transfers.ts'

/*
 * Order orchestration (ADR 0004):
 * submit -> entitlement -> approvals -> sourcing (event) -> staging -> ship -> install -> in service.
 * Stages after sourcing are derived from Asset stages (platform/fulfilment).
 *
 * The form buttons save the form before they act, so values typed before clicking are not lost, and stop when that
 * save is refused (the platform says why).
 */

interface DeviceRow {
    model?: string
    quantity?: string | number
}

/**
 * Record producer post-insert script: give the Order its lines and submit it (platform/orders `submitProducedOrder`).
 * (`current` is typed unknown because the SDK passes its own GlideRecord type here.)
 */
export function afterOrderProduced(producer: Record<string, unknown>, current: unknown): void {
    const asked = deviceRows(producer.devices)
    const devices: NewLine[] = []
    for (const row of asked.rows) {
        if (row.model) devices.push({ modelId: String(row.model), quantity: Math.max(1, Number(row.quantity) || 1) })
    }
    const order = current as GlideRecord
    const submission = submitProducedOrder(order, devices, asked.unread)
    if (submission.submitted || !submission.queued) return tellSubmission(submission)
    // Its raiser, often a Customer admin, has no Submit action to try again with.
    const saved = `Order ${str(order, 'number')} is saved and is submitted within a few minutes: another order of the same agreement was being submitted at that moment`
    gs.addInfoMessage(`${saved}. There is no need to raise it again`)
}

/**
 * The device rows of the producer's multi-row variable, which arrives as JSON text; none when it is blank. Rows that
 * were sent but cannot be read are not taken for none: `unread` says why ('' when they were read), and the Order then
 * stays a draft rather than go ahead without the devices asked for.
 */
function deviceRows(value: unknown): { rows: DeviceRow[]; unread: string } {
    const text = String(value ?? '').trim()
    if (!text) return { rows: [], unread: '' }
    try {
        const rows: unknown = JSON.parse(text)
        if (rows === null) return { rows: [], unread: '' }
        return Array.isArray(rows) ? { rows, unread: '' } : { rows: [], unread: 'they are not a list of rows' }
    } catch (error) {
        return { rows: [], unread: messageOf(error) }
    }
}

function tellSubmission(submission: Submission): void {
    if (submission.submitted) {
        if (submission.already) gs.addInfoMessage(submission.already)
    } else gs.addErrorMessage(submission.message)
}

export function uiSubmitOrder(current: GlideRecord): void {
    // Submit assesses the Order as the form holds it and may ask approvers to decide it: never on values not saved.
    if (!current.update()) return
    tellSubmission(submitOrder(current))
}

export function onOrderApprovalDecision(current: ForeignRecord): void {
    rollUpOrderApprovals(str(current, 'document_id'))
}

/** An Order's approver groups as Re-check approvals names them: its provider side asks the account manager first. */
const ORDER_APPROVER_NAMES: Readonly<Record<Approver, string>> = {
    [APPROVER.customerAdmin]: 'a Customer admin',
    [APPROVER.provider]: 'the account manager (or the asset managers)',
}

/**
 * UI action "Re-check approvals": roll an Order's approvals up again, as a decision does, for one whose last decision
 * could not be saved and that no request is left to move on; the user is told the outcome, or why there is none yet.
 */
export function uiRecheckApprovals(current: GlideRecord): void {
    // A refused form save (the platform says why) re-checks nothing: the rollup reads the Order afresh, so it would
    // decide without what the form did not save.
    if (!current.update()) return
    const rollup = rollUpOrderApprovals(current.getUniqueValue())
    if (!rollup) return void gs.addErrorMessage('The Order is no longer awaiting approval')
    if (rollup.outcome === 'requested') {
        const why = approvalAwaited(rollup.required, rollup.decisions, ORDER_APPROVER_NAMES)
        return void gs.addErrorMessage(`Order still awaiting approval: ${why}`)
    }
    if (rollup.refused) return void gs.addErrorMessage(`Order not saved as ${rollup.outcome}: ${rollup.refused}`)
    gs.addInfoMessage(rollup.outcome === 'approved' ? 'Order approved: sourcing has started' : 'Order rejected')
}

export function sourceOrder(event: GlideRecord, current: GlideRecord): void {
    const { request, tries } = sourcingRequestOf(event)
    if (request === 'submission') return submitQueuedOrder(current.getUniqueValue(), tries)
    runSourcingPass(current, tries)
}

export function uiCancelOrder(current: GlideRecord): void {
    // Cancel saves this same record again: going on after a refused save could store the values just refused.
    if (!current.update()) return
    const cancellation = cancelOrder(current)
    if (!cancellation.cancelled) return void gs.addErrorMessage(`Order not cancelled: ${cancellation.reason}`)
    if (!cancellation.complete) {
        gs.addErrorMessage('Order cancelled; some lines, stock or staging tasks were left as they were (see the log)')
    }
}

export function onAllocatedAssetStageChange(current: ForeignRecord, previous: ForeignRecord): void {
    const lineId = str(current, 'x_daas_ham_order_line')
    if (!lineId) return
    const from = readStage(previous)
    if (from === 'in_transfer' && fellShortOfStagingCentre(current)) return void putBackUntransferred(current, lineId)
    onLineAssetMoved(current, lineId, from, readStage(current))
}
