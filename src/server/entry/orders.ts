import { gs, type GlideRecord } from '@servicenow/glide'
import { approvalAwaited } from '../domain/approvals.ts'
import type { NewLine } from '../platform/order-lines.ts'
import { cancelOrder, rollUpOrderApprovals, submitOrder, submitProducedOrder, type Submission } from '../platform/orders.ts'
import { timesRequeued } from '../platform/events.ts'
import { str } from '../platform/records.ts'
import { runSourcingPass } from '../platform/sourcing.ts'

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
    const devices: NewLine[] = []
    for (const row of parseRows(producer.devices)) {
        if (row.model) devices.push({ modelId: String(row.model), quantity: Math.max(1, Number(row.quantity) || 1), fromSiteTemplate: false })
    }
    tellUnlessSubmitted(submitProducedOrder(current as GlideRecord, devices))
}

function parseRows(value: unknown): DeviceRow[] {
    try {
        const rows = JSON.parse(String(value ?? '[]'))
        return Array.isArray(rows) ? rows : []
    } catch {
        return []
    }
}

function tellUnlessSubmitted(submission: Submission): void {
    if (!submission.submitted) gs.addErrorMessage(submission.message)
}

/** UI action "Submit" on a draft Order. */
export function uiSubmitOrder(current: GlideRecord): void {
    // Submit assesses the Order as the form holds it and may ask approvers to decide it: never on values not saved.
    if (!current.update()) return
    tellUnlessSubmitted(submitOrder(current))
}

/** After-update rule on sysapproval_approver: roll the decisions up to the Order. */
export function onOrderApprovalDecision(current: GlideRecord): void {
    rollUpOrderApprovals(str(current, 'document_id'))
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
        const why = approvalAwaited(rollup.required, rollup.decisions)
        return void gs.addErrorMessage(`Order still awaiting approval: ${why}`)
    }
    if (rollup.refused) return void gs.addErrorMessage(`Order not saved as ${rollup.outcome}: ${rollup.refused}`)
    gs.addInfoMessage(rollup.outcome === 'approved' ? 'Order approved: sourcing has started' : 'Order rejected')
}

/** Script action on x_daas_ham.order.source (parm2: how many times this request was queued again). */
export function sourceOrder(event: GlideRecord, current: GlideRecord): void {
    runSourcingPass(current, timesRequeued(event))
}

/** UI action "Cancel order" (platform/orders `cancelOrder`). */
export function uiCancelOrder(current: GlideRecord): void {
    // Cancel saves this same record again: going on after a refused save could store the values just refused.
    if (!current.update()) return
    const cancellation = cancelOrder(current)
    if (!cancellation.cancelled) return void gs.addErrorMessage(`Order not cancelled: ${cancellation.reason}`)
    if (!cancellation.complete) {
        gs.addErrorMessage('Order cancelled; some lines, stock or staging tasks were left as they were (see the log)')
    }
}
