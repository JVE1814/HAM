import { GlideRecord } from '@servicenow/glide'
import { EVENT } from '../domain/events.ts'
import {
    closedStateFor,
    endedUnfulfilled,
    followsLines,
    leftInTransit,
    lineStageFor,
    ORDER_TASK_STATE,
    orderStageFor,
    refillsLine,
    type OrderShipment,
} from '../domain/fulfilment.ts'
import type { Stage } from '../domain/lifecycle.ts'
import { deploymentEndLineQuery } from '../domain/returns.ts'
import { LINE_STAGE, ORDER_STAGE, type LineStage, type OrderStage } from '../domain/vocabulary.ts'
import { readStage } from './assets.ts'
import { beyondVisibility } from './beyond-visibility.ts'
import { fire } from './events.ts'
import { log } from './log.ts'
import { saveLineStage } from './order-lines.ts'
import { exists, findById, num, str, warnRefused, type ForeignRecord } from './records.ts'
import { queueSourcing } from './sourcing-requests.ts'
import { leaveOrderLine } from './stock.ts'

/**
 * Keeps Order-line and Order stages in step with their Assets (derived, see domain/fulfilment), and has a line that
 * lost a unit filled again.
 */

/**
 * The stages of every Asset on a line, read past the user's before-query rules (ADR 0005): an inventory tech closing a
 * Staging task sees only the Assets in their stockrooms, so a hot spare at the customer site would go uncounted.
 */
export function lineAssetStages(lineId: string): Array<Stage | null> {
    return assetStages('x_daas_ham_order_line', lineId)
}

/**
 * How many Assets are on a line, in any stage: what sourcing counts as allocated and what a receipt checks the line
 * still has room beside. Counted as the line's stage is derived, past the user's rules.
 */
export function unitsOnLine(lineId: string): number {
    return lineAssetStages(lineId).length
}

/** The stages of the Order's lines and of every Asset on them, read past the user's before-query rules (as above). */
export function orderShipment(orderId: string): OrderShipment {
    return { lineStages: lineStagesOf(orderId), unitStages: assetStages('x_daas_ham_order_line.order', orderId) }
}

/**
 * The stage of each of the Order's lines: the one read of them, for what the Order has shipped and for the stage it
 * derives from them. Read past the user's before-query rules, the way the Assets on the lines are
 * (platform/beyond-visibility). The rules scope a line by its Order's Customer and Site (domain/visibility), so
 * whoever sees the Order sees each of its lines anyway: a stage is never derived from some of them.
 */
function lineStagesOf(orderId: string): LineStage[] {
    const line = new GlideRecord('x_daas_ham_order_line')
    line.addQuery('order', orderId)
    beyondVisibility(line, () => line.query())
    const stages: LineStage[] = []
    while (line.next()) stages.push(str(line, 'line_stage') as LineStage)
    return stages
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
 * A unit left the Order line, already taken off it (a failed staging, a transfer to the staging centre fallen
 * through): the line's stage is derived again, back to awaiting stock while it is short, and its Order is sourced
 * again, queued (platform/sourcing-requests `queueSourcing`). The one sequence for a unit that leaves its line; one lost in transit differs
 * only in how the line is derived (`onLineAssetMoved`).
 */
export function lineLostUnit(lineId: string): void {
    const line = findById('x_daas_ham_order_line', lineId)
    if (!line) return
    deriveLine(line, false)
    queueSourcing(str(line, 'order'))
}

/**
 * An Asset on `lineId` moved `from` -> `to` (the after-update rule on alm_hardware): the line's stage is derived again.
 * A unit that left it in transit while still owed to it (domain/fulfilment `leftInTransit`, `refillsLine`) is first
 * taken off it, and the line is derived as filled again, back to awaiting stock: its Order is then sourced again,
 * queued (platform/sourcing-requests `queueSourcing`).
 *
 * No lock is taken. The unit comes off the line before the line is saved as awaiting stock, so a sourcing pass or a
 * receipt counting the reopened line never counts it (each counts only a line awaiting stock). The sourcing is queued,
 * not run in this save, whose own after rule takes the Asset's service-interval lock (ADR 0013).
 */
export function onLineAssetMoved(asset: ForeignRecord, lineId: string, from: Stage | null, to: Stage | null): void {
    // Read past the user's rules: unlike a derived stage, a line not filled again now never is.
    const line = leftInTransit(from, to) ? findById('x_daas_ham_order_line', lineId, { beyondVisibility: true }) : null
    if (!line) return recomputeLine(lineId)
    const stage = str(line, 'line_stage') as LineStage
    const deploymentEnds = exists('x_daas_ham_return_order_line', deploymentEndLineQuery(asset.getUniqueValue()))
    if (!refillsLine({ stage, deploymentEnds }) || !takeOffLine(asset.getUniqueValue(), line, to as Stage)) {
        return void deriveLine(line, false)
    }
    const next = deriveLine(line, true)
    // Left at its stage, the line is not sourced again, and a later change no longer fills it again.
    if (next === null) log.warn(`${str(line, 'number')} lost a unit in transit but is not sourced again`)
    if (next === 'awaiting_stock') queueSourcing(str(line, 'order'))
}

/** Take a unit that left `line` in transit off it (logged); false when the platform refuses (logged): it stays on. */
function takeOffLine(assetId: string, line: GlideRecord, to: Stage): boolean {
    // A fresh record, read past the user's rules: saving `current` again from its own after rule would run its rules twice.
    const asset = findById('alm_hardware', assetId, { beyondVisibility: true })
    if (!asset) return false
    const what = `${str(asset, 'serial_number')} left ${str(line, 'number')} in transit (${to})`
    if (!leaveOrderLine(asset, { keeps: 'customer', to: null }, `${what} but stays on it, which is not sourced again`)) return false
    log.info(`${what}: taken off the line, which is filled again`)
    return true
}

/**
 * Derive `line`'s stage again (`refill`: domain/fulfilment `LineFacts`), save it and move its Order on: the stage it
 * now has, or null when the platform refused the save (logged).
 *
 * A cancel or rejection saves its Order before it cancels the lines, under their locks, but a derive takes no lock: one
 * that read the line before the cancel could save its stage after, reopening the line. So a line read afresh as
 * cancelled, or on an Order that ended unfulfilled (domain/fulfilment `endedUnfulfilled`), is not moved on, and one
 * whose Order ended while its stage was saved is cancelled again: either the cancel's save came after this one, or the
 * Order was cancelled before this save and the line with it.
 */
function deriveLine(line: GlideRecord, refill: boolean): LineStage | null {
    const current = str(line, 'line_stage') as LineStage
    if (current === 'new') return current // not sourced yet
    const assetStages = lineAssetStages(line.getUniqueValue())
    const next = lineStageFor({ current, quantity: num(line, 'quantity'), assetStages, refill })
    if (next !== current) {
        if (closedNow(line)) return LINE_STAGE.cancelled
        if (!saveLineStage(line, next)) {
            notMoved(line, next)
            return null
        }
        if (next !== LINE_STAGE.cancelled && closedNow(line)) {
            if (!saveLineStage(line, LINE_STAGE.cancelled)) warnRefused(line, `${str(line, 'number')} moved to ${next} beside its Order's cancel, not cancelled again`)
            return LINE_STAGE.cancelled
        }
    }
    recomputeOrder(str(line, 'order'))
    return next
}

/** Whether the line, read afresh past the user's rules, is cancelled or on an Order cancelled or rejected. */
function closedNow(line: GlideRecord): boolean {
    const fresh = findById('x_daas_ham_order_line', line.getUniqueValue(), { beyondVisibility: true })
    return !!fresh && (str(fresh, 'line_stage') === LINE_STAGE.cancelled || endedUnfulfilled(str(fresh, 'order.stage')))
}

export function recomputeOrder(orderId: string): void {
    const order = findById('x_daas_ham_order', orderId)
    if (!order || !followsLines(str(order, 'stage'))) return
    const stages = lineStagesOf(orderId)
    if (stages.length === 0) return
    const next = orderStageFor(stages)
    if (next === str(order, 'stage')) return
    order.setValue('stage', next)
    const closed = closedStateFor(next)
    if (closed !== undefined) order.setValue('state', closed)
    if (!order.update()) return notMoved(order, next)
    if (cancelledWhileMoved(orderId, next)) return
    // Its case is saved by the event's script action (platform/breakfix `noteReplacementComplete`), not in this save.
    if (next === ORDER_STAGE.complete && str(order, 'case')) fire(EVENT.replacementComplete, order)
}

/**
 * Cancel order saves the Order cancelled under locks a derive does not take, so a derive that read the Order before the
 * cancel and saved its stage after leaves the cancel's Closed Skipped state beside a live stage (a save writes only the
 * fields it changed). That Order is saved cancelled again, read afresh: true when it was found so.
 */
function cancelledWhileMoved(orderId: string, next: OrderStage): boolean {
    const fresh = findById('x_daas_ham_order', orderId)
    if (!fresh || num(fresh, 'state') !== ORDER_TASK_STATE.cancelled || str(fresh, 'stage') === ORDER_STAGE.cancelled) return false
    fresh.setValue('stage', ORDER_STAGE.cancelled)
    if (!fresh.update()) warnRefused(fresh, `${str(fresh, 'number')} moved to ${next} beside its cancel, not cancelled again`)
    return true
}

/**
 * Stages are derived again only when an Asset next changes, so a refused save is logged: it can hold a line, and the
 * Order with the actions offered at its stage (Ship, Confirm installed), where they are.
 */
function notMoved(record: GlideRecord, to: string): void {
    warnRefused(record, `${str(record, 'number')} not moved to ${to}`)
}
