import { GlideRecord } from '@servicenow/glide'
import type { PurchaseResult } from '../domain/sourcing.ts'
import { stagingStockroom } from './staging-tasks.ts'
import { PROPERTY } from '../domain/properties.ts'
import { findById, refusal, str } from './records.ts'
import { log } from './log.ts'

/**
 * Purchase orders through the Procurement plugin (proc_po / proc_po_item), shipped to the staging
 * stockroom. Created in the "requested" status for a buyer to complete; field names follow the base
 * Procurement data model. Ship to is mandatory on a purchase order, so none is requested while no
 * staging stockroom is set; nor for a Model without a Model category, whose line item Procurement refuses (its rule
 * "Model Category of Model not empty"). Then, or when the PO or its line item is not inserted, a warning is logged and
 * the result says why. Procurement lets no other scope delete a PO (its table's application access), so a PO saved
 * without its line item is cancelled, or, if it cannot be, named in the reason for cancelling it by hand.
 */
export function requestPurchase(input: { modelId: string; quantity: number; description: string }): PurchaseResult {
    const shipTo = stagingStockroom()
    if (!shipTo) return noPurchase(input.description, `set ${PROPERTY.stagingStockroom.name}`)
    const model = findById('cmdb_model', input.modelId)
    if (model && !str(model, 'cmdb_model_category')) {
        return noPurchase(input.description, `give Model ${str(model, 'name')} a Model category: Procurement refuses a line item without one`)
    }
    const po = new GlideRecord('proc_po')
    po.initialize()
    po.setValue('short_description', input.description)
    po.setValue('status', 'requested')
    po.setValue('ship_to', shipTo)
    const poId = po.insert()
    if (!poId) return noPurchase(input.description, 'Procurement did not create it')

    const item = new GlideRecord('proc_po_item')
    item.initialize()
    item.setValue('purchase_order', poId)
    item.setValue('model', input.modelId)
    item.setValue('ordered_quantity', input.quantity)
    item.setValue('status', 'requested')
    if (item.insert()) return { ok: true, poId }
    const why = `Procurement created ${str(po, 'number')} without its line item (${refusal(item)})`
    po.setValue('status', 'canceled')
    return noPurchase(input.description, po.update() ? `${why}; it is cancelled` : `${why}; cancel it`)
}

/** The sys_id of the purchase order numbered `number` (as an ASN or a received unit names it), or ''. */
export function purchaseOrderId(number: string): string {
    const po = new GlideRecord('proc_po')
    return number && po.get('number', number) ? po.getUniqueValue() : ''
}

/** Statuses after which a PO, or a single line item, no longer counts as open. */
const CLOSED_PURCHASE_STATUSES = 'received,canceled,cancelled'

/**
 * How the purchase orders of the top-up of a Customer's Spare pools begin their description. Procurement's purchase
 * order has no field for what a purchase is for, so the top-up's are told from an Order line's by this prefix: it is
 * how the open ones are found again.
 */
function sparePurchasePrefix(customerId: string): string {
    return `Spare-pool top-up ${customerId}:`
}

/** Request the purchase of `quantity` spares of a Model for a Customer's Spare pool (the daily top-up). */
export function requestSparePurchase(customerId: string, modelId: string, quantity: number): PurchaseResult {
    return requestPurchase({ modelId, quantity, description: `${sparePurchasePrefix(customerId)} ${quantity} unit(s)` })
}

/**
 * Units of a Model the spare-pool top-up bought for a Customer that are not yet received or cancelled. A line item
 * can be received or canceled on its own under a PO that is still open, so both the PO status and the line status are
 * checked.
 */
export function openSparePurchaseQuantity(customerId: string, modelId: string): number {
    const item = new GlideRecord('proc_po_item')
    item.addQuery('model', modelId)
    item.addQuery('purchase_order.short_description', 'STARTSWITH', sparePurchasePrefix(customerId))
    item.addQuery('purchase_order.status', 'NOT IN', CLOSED_PURCHASE_STATUSES)
    item.addQuery('status', 'NOT IN', CLOSED_PURCHASE_STATUSES)
    item.query()
    let open = 0
    while (item.next()) open += Math.max(0, Number(item.getValue('ordered_quantity')) - Number(item.getValue('received_quantity') || 0))
    return open
}

function noPurchase(description: string, reason: string): PurchaseResult {
    log.warn(`No purchase order (${reason}): ${description}`)
    return { ok: false, reason }
}
