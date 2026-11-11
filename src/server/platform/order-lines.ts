import { GlideRecord } from '@servicenow/glide'
import { LONG_HOLD_LOCK_TRIES, type HeldLock } from '../domain/job-lock.ts'
import { LOCK } from '../domain/lock-names.ts'
import type { LineStage } from '../domain/vocabulary.ts'
import { withLockTries, type LockRun } from './locks.ts'
import { num, refusal, str } from './records.ts'

/**
 * Order lines (x_daas_ham_order_line). Every write of a line is made here: its insert, its stage (cancelled, as
 * sourcing left it, derived from its Assets), its on-order count, and the purchase and transfer orders it lists. Each
 * write says whether the platform took it and logs nothing: the caller holds the locks it needs (ADR 0013, the line's
 * own through `withOrderLineLock`) and answers a refusal.
 */

/**
 * Run `work` holding the Order line's lock and give what it returned, or `ran: false` when other holders kept it through
 * every try: a holder keeps it for a receipt (the Asset, the line, the reservation and the move into staging saved),
 * for sourcing's read of the line or its purchase and save, or for a cancel or rejection of its Order
 * (`withOrderLineLocks`). Taking the lock throws only when an insert is refused with no lock row (platform/locks
 * `withLockTries` tries again, and that error escapes only when every try threw), as does an error from `work`.
 */
export function withOrderLineLock<T>(lineId: string, work: (lock: HeldLock) => T): LockRun<T> {
    return withLockTries(LOCK.orderLine(lineId), work, LONG_HOLD_LOCK_TRIES)
}

/**
 * Run `work` holding the lock of every line in `lineIds`, taken one under another in sys_id order (ADR 0013), and give
 * what it returned, or `ran: false`, with nothing run, when one stayed held through its tries.
 */
export function withOrderLineLocks<T>(lineIds: readonly string[], work: (locks: HeldLock[]) => T): LockRun<T> {
    const ids = [...lineIds].sort()
    const holdFrom = (next: number, held: HeldLock[]): LockRun<T> => {
        if (next === ids.length) return { ran: true, value: work(held) }
        const under = withOrderLineLock(ids[next], (lock) => holdFrom(next + 1, [...held, lock]))
        return under.ran ? under.value : { ran: false }
    }
    return holdFrom(0, [])
}

/** A line to add to an Order. */
export interface NewLine {
    modelId: string
    quantity: number
    /** It came from the Order's Site template; left unset, the column's default (false) stands. */
    fromSiteTemplate?: boolean
    /** The Asset it replaces like-for-like (break-fix, refresh). */
    replacesAssetId?: string
}

/** A line the platform refused to save, and why. */
export interface RefusedLine {
    line: NewLine
    reason: string
}

/** Add `lines` to `order`, in order; those the platform refused (for the caller to report). */
export function addOrderLines(order: GlideRecord, lines: readonly NewLine[]): RefusedLine[] {
    const refused: RefusedLine[] = []
    for (const line of lines) {
        const record = new GlideRecord('x_daas_ham_order_line')
        record.initialize()
        record.setValue('order', order.getUniqueValue())
        record.setValue('model', line.modelId)
        record.setValue('quantity', line.quantity)
        if (line.fromSiteTemplate !== undefined) record.setValue('from_site_template', line.fromSiteTemplate)
        if (line.replacesAssetId) record.setValue('replaces_asset', line.replacesAssetId)
        if (!record.insert()) refused.push({ line, reason: refusal(record) })
    }
    return refused
}

/** Save the line at `stage`, cancelled or derived from its Assets (platform/fulfilment); false when the platform refuses. */
export function saveLineStage(line: GlideRecord, stage: LineStage): boolean {
    line.setValue('line_stage', stage)
    return !!line.update()
}

/** How a sourcing pass left a line (platform/sourcing `settleHolding`). */
export interface LineSourcing {
    /** The transfer orders the pass requested for it, added to those it lists. */
    transfers: readonly string[]
    /** The purchase order the pass raised for it, added to those it lists. */
    purchaseOrder?: string
    /** The units on the line, counted again by the pass. */
    allocated: number
    /** The units the pass bought, added to its on-order count. */
    purchased: number
    summary: string
    stage: LineStage
}

/**
 * Save the line as a sourcing pass left it; false when the platform refuses. Every purchase order stays listed, so
 * units of an earlier one are still allocated to the line on receipt.
 */
export function saveLineSourcing(line: GlideRecord, sourcing: LineSourcing): boolean {
    if (sourcing.transfers.length > 0) {
        line.setValue('transfer_orders', [str(line, 'transfer_orders'), ...sourcing.transfers].filter(Boolean).join(','))
    }
    if (sourcing.purchaseOrder) {
        const listed = [str(line, 'purchase_orders'), sourcing.purchaseOrder].filter(Boolean)
        line.setValue('purchase_order', sourcing.purchaseOrder)
        line.setValue('purchase_orders', listed.join(','))
    }
    line.setValue('quantity_allocated', sourcing.allocated)
    line.setValue('quantity_to_purchase', num(line, 'quantity_to_purchase') + sourcing.purchased)
    line.setValue('sourcing_summary', sourcing.summary)
    line.setValue('line_stage', sourcing.stage)
    return !!line.update()
}

/** Take one received unit off the line's on-order count; false when the platform refuses the save. */
export function takeUnitOffOrder(line: GlideRecord): boolean {
    line.setValue('quantity_to_purchase', Math.max(0, num(line, 'quantity_to_purchase') - 1))
    return !!line.update()
}
