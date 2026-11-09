import { GlideRecord, gs } from '@servicenow/glide'
import {
    followsLines,
    leftInTransit,
    lineStageFor,
    orderStageFor,
    refillsLine,
    siteRecoveryLineQuery,
    type LineStage,
    type OrderShipment,
} from '../domain/fulfilment.ts'
import type { Stage } from '../domain/lifecycle.ts'
import { readStage } from './assets.ts'
import { beyondVisibility } from './beyond-visibility.ts'
import { fire } from './events.ts'
import { bool, exists, findById, num, refusal, str } from './records.ts'

/** Keeps Order-line and Order stages in step with their Assets (derived, see domain/fulfilment). */

/**
 * The stages of every Asset on a line, read past the user's before-query rules (ADR 0005): an inventory tech closing a
 * Staging task sees only the Assets in their stockrooms, so a hot spare at the customer site would go uncounted.
 */
export function lineAssetStages(lineId: string): Array<Stage | null> {
    return assetStages('x_daas_ham_order_line', lineId)
}

/** The stages of the Order's lines and of every Asset on them, read past the user's before-query rules (as above). */
export function orderShipment(orderId: string): OrderShipment {
    const line = new GlideRecord('x_daas_ham_order_line')
    // Only read, never saved, so the rules need not be turned back on.
    line.setWorkflow(false)
    line.addQuery('order', orderId)
    line.query()
    const lineStages: LineStage[] = []
    while (line.next()) lineStages.push(str(line, 'line_stage') as LineStage)
    return { lineStages, unitStages: assetStages('x_daas_ham_order_line.order', orderId) }
}

function assetStages(field: string, id: string): Array<Stage | null> {
    const asset = new GlideRecord('alm_hardware')
    asset.addQuery(field, id)
    beyondVisibility(asset, () => asset.query())
    const stages: Array<Stage | null> = []
    while (asset.next()) stages.push(readStage(asset))
    return stages
}

export function recomputeLine(lineId: string): void {
    const line = findById('x_daas_ham_order_line', lineId)
    if (line) deriveLine(line, false)
}

/**
 * An Asset on `lineId` moved `from` -> `to` (the after-update rule on alm_hardware): the line's stage is derived again.
 * A unit that left it in transit while still owed to it (domain/fulfilment `leftInTransit`, `refillsLine`) is first
 * taken off it, and the line is derived as filled again, back to awaiting stock: then the id of its Order, to source
 * again, else ''.
 *
 * No lock is taken. The unit comes off the line before the line is saved as awaiting stock, so a sourcing pass or a
 * receipt counting the reopened line never counts it (each counts only a line awaiting stock). The sourcing is left to
 * the caller to queue (entry/orders `resourceOrder`), not run in this save: it takes the Order's sourcing lock and
 * saves other Assets, and this save's own after rule takes the Asset's service-interval lock (ADR 0013).
 */
export function onLineAssetMoved(asset: GlideRecord, lineId: string, from: Stage | null, to: Stage | null): string {
    // Read past the user's rules: unlike a derived stage, a line not filled again now never is.
    const line = leftInTransit(from, to) ? readPastRules('x_daas_ham_order_line', lineId) : null
    if (!line) {
        recomputeLine(lineId)
        return ''
    }
    const stage = str(line, 'line_stage') as LineStage
    const siteRecovery = exists('x_daas_ham_return_order_line', siteRecoveryLineQuery(asset.getUniqueValue()))
    if (!refillsLine({ stage, siteRecovery }) || !takeOffLine(asset.getUniqueValue(), line, to as Stage)) {
        deriveLine(line, false)
        return ''
    }
    const next = deriveLine(line, true)
    // Left at its stage, the line is not sourced again, and a later change no longer fills it again.
    if (next === null) gs.warn(`[x_daas_ham] ${str(line, 'number')} lost a unit in transit but is not sourced again`)
    return next === 'awaiting_stock' ? str(line, 'order') : ''
}

/**
 * The record, read past the app's before-query visibility rules (platform/beyond-visibility), the only before-query
 * rules on an app table (the platform refuses another scope's); its saves run every rule (null when not found).
 */
function readPastRules(table: string, sysId: string): GlideRecord | null {
    const record = new GlideRecord(table)
    return beyondVisibility(record, () => record.get(sysId)) ? record : null
}

/** Take a unit that left `line` in transit off it (logged); false when the platform refuses (logged): it stays on. */
function takeOffLine(assetId: string, line: GlideRecord, to: Stage): boolean {
    // A fresh record: saving `current` again from its own after rule would run its rules twice.
    const asset = readPastRules('alm_hardware', assetId)
    if (!asset) return false
    asset.setValue('x_daas_ham_order_line', '')
    const what = `${str(asset, 'serial_number')} left ${str(line, 'number')} in transit (${to})`
    if (asset.update()) {
        gs.info(`[x_daas_ham] ${what}: taken off the line, which is filled again`)
        return true
    }
    gs.warn(`[x_daas_ham] ${what} but stays on it, which is not sourced again: ${refusal(asset)}`)
    return false
}

/**
 * Derive `line`'s stage again (`refill`: domain/fulfilment `LineFacts`), save it and move its Order on: the stage it
 * now has, or null when the platform refused the save (logged).
 */
function deriveLine(line: GlideRecord, refill: boolean): LineStage | null {
    const current = str(line, 'line_stage') as LineStage
    if (current === 'new') return current // not sourced yet
    const assetStages = lineAssetStages(line.getUniqueValue())
    const next = lineStageFor({ current, quantity: num(line, 'quantity'), assetStages, refill })
    if (next !== current) {
        line.setValue('line_stage', next)
        if (!line.update()) {
            warnNotMoved(line, `${str(line, 'number')} not moved to ${next}`)
            return null
        }
    }
    recomputeOrder(str(line, 'order'))
    return next
}

/**
 * Queued on a replacement Order once it is complete (registered in logic/aftersales.now.ts, whose script action calls
 * noteReplacementComplete with the Order's sys_id).
 */
export const REPLACEMENT_COMPLETE_EVENT = 'x_daas_ham.replacement.complete'

export function recomputeOrder(orderId: string): void {
    const order = findById('x_daas_ham_order', orderId)
    if (!order || !followsLines(str(order, 'stage'))) return
    const line = new GlideRecord('x_daas_ham_order_line')
    line.addQuery('order', orderId)
    line.query()
    const stages: LineStage[] = []
    while (line.next()) stages.push(str(line, 'line_stage') as LineStage)
    if (stages.length === 0) return
    const next = orderStageFor(stages)
    if (next === str(order, 'stage')) return
    order.setValue('stage', next)
    if (next === 'complete') order.setValue('state', 3)
    if (next === 'cancelled') order.setValue('state', 7)
    if (!order.update()) return warnNotMoved(order, `${str(order, 'number')} not moved to ${next}`)
    // Its case is saved by the event's script action (noteReplacementComplete), not in this save.
    if (next === 'complete' && str(order, 'case')) fire(REPLACEMENT_COMPLETE_EVENT, order)
}

/**
 * A replacement Order completed: its case is saved with a work note. The replacement SLAs on the case stop once the Order
 * it links is complete (logic/aftersales.now.ts), but the SLA engine weighs a case's SLAs only when the case is saved,
 * and completing the Order does not save it. Only an open case that still links this Order, now complete, is saved. A
 * case not found, or a refused save, leaves the SLA running, to breach: that is logged, to save the case by hand.
 *
 * Run from the event queue (REPLACEMENT_COMPLETE_EVENT), never in the save that completes the Order: that save is often
 * made in a user's interactive session (an asset manager moving the unit to in service on the form, a customer contact
 * confirming the install), where Customer Service's before-query rule 'Case query rules' narrows every read of a case to
 * the CSM query rules of a user without case_admin: one whose rules do not grant them the case would not find it. A
 * script action runs as system outside any interactive session, where that rule does not apply (it requires
 * gs.isInteractive()).
 */
export function noteReplacementComplete(orderId: string): void {
    const order = readPastRules('x_daas_ham_order', orderId)
    if (!order || str(order, 'stage') !== 'complete') return
    const caseId = str(order, 'case')
    if (!caseId) return
    const kase = findById('sn_customerservice_case', caseId)
    if (!kase) return void gs.warn(`[x_daas_ham] ${str(order, 'number')} complete, but its case ${caseId} was not found: save the case to stop its SLA`)
    if (!bool(kase, 'active') || str(kase, 'x_daas_ham_replacement_order') !== order.getUniqueValue()) return
    kase.setValue('work_notes', `Replacement order ${str(order, 'number')} is complete: the replacement is installed.`)
    if (kase.update()) return
    gs.warn(`[x_daas_ham] ${str(kase, 'number')}: replacement SLA not stopped, the case save was refused: ${refusal(kase)}; save the case`)
}

/**
 * Stages are derived again only when an Asset next changes, so a refused save is logged: it can hold a line, and the
 * Order with the actions offered at its stage (Ship, Confirm installed), where they are.
 */
function warnNotMoved(record: GlideRecord, what: string): void {
    gs.warn(`[x_daas_ham] ${what}: ${refusal(record)}`)
}
