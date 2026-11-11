import { GlideRecord } from '@servicenow/glide'
import { LINE_STAGE, type LineStage } from '../domain/vocabulary.ts'
import { num, refusal, str } from './records.ts'

/**
 * Order lines (x_daas_ham_order_line). Every write of a line is made here: its insert, its stage (cancelled, as
 * sourcing left it, derived from its Assets), its on-order count, and the purchase and transfer orders it lists. Each
 * write says whether the platform took it and logs nothing: the caller holds the locks it needs (ADR 0013) and answers
 * a refusal.
 */

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

/** Cancel the line; false when the platform refuses the save. */
export function cancelLine(line: GlideRecord): boolean {
    return saveLineStage(line, LINE_STAGE.cancelled)
}

/** Save the line at the `stage` derived from its Assets (platform/fulfilment); false when the platform refuses. */
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
