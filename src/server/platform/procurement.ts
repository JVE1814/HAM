import { GlideRecord, gs } from '@servicenow/glide'
import type { PurchaseResult } from '../domain/sourcing.ts'
import { PROPERTY, stagingStockroom } from './properties.ts'
import { str } from './records.ts'

/**
 * Purchase orders through the Procurement plugin (proc_po / proc_po_item), shipped to the staging
 * stockroom. Created in the "requested" status for a buyer to complete; field names follow the base
 * Procurement data model. Ship to is mandatory on a purchase order, so none is requested while no
 * staging stockroom is set; then, or when the PO or its line item is not inserted, a warning is logged and the
 * result says why. A PO without its line item is removed (or, if it cannot be, named in the reason for cancelling).
 */
export function requestPurchase(input: { modelId: string; quantity: number; description: string }): PurchaseResult {
    const shipTo = stagingStockroom()
    if (!shipTo) return noPurchase(input.description, `set ${PROPERTY.stagingStockroom}`)
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
    const removed = po.deleteRecord()
    return noPurchase(input.description, removed ? 'Procurement did not create its line item' : `Procurement created ${str(po, 'number')} without its line item; cancel it`)
}

/** The sys_id of the purchase order numbered `number` (as an ASN or a received unit names it), or ''. */
export function purchaseOrderId(number: string): string {
    const po = new GlideRecord('proc_po')
    return number && po.get('number', number) ? po.getUniqueValue() : ''
}

/** Statuses after which a PO, or a single line item, no longer counts as open. */
const CLOSED_PURCHASE_STATUSES = 'received,canceled,cancelled'

/**
 * Units of a model on purchase orders (by description prefix) that are not yet received or
 * cancelled. A line item can be received or canceled on its own under a PO that is still open,
 * so both the PO status and the line status are checked.
 */
export function openPurchaseQuantity(descriptionPrefix: string, modelId: string): number {
    const item = new GlideRecord('proc_po_item')
    item.addQuery('model', modelId)
    item.addQuery('purchase_order.short_description', 'STARTSWITH', descriptionPrefix)
    item.addQuery('purchase_order.status', 'NOT IN', CLOSED_PURCHASE_STATUSES)
    item.addQuery('status', 'NOT IN', CLOSED_PURCHASE_STATUSES)
    item.query()
    let open = 0
    while (item.next()) open += Math.max(0, Number(item.getValue('ordered_quantity')) - Number(item.getValue('received_quantity') || 0))
    return open
}

function noPurchase(description: string, reason: string): PurchaseResult {
    gs.warn(`[x_daas_ham] No purchase order (${reason}): ${description}`)
    return { ok: false, reason }
}
