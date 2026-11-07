import { GlideRecord } from '@servicenow/glide'

/**
 * Purchase orders through the Procurement plugin (proc_po / proc_po_item). Created in the
 * "requested" status for a buyer to complete; field names follow the base Procurement data model.
 */
export function requestPurchase(input: {
    modelId: string
    quantity: number
    shipToStockroomId: string
    description: string
}): string {
    const po = new GlideRecord('proc_po')
    po.initialize()
    po.setValue('short_description', input.description)
    po.setValue('status', 'requested')
    if (input.shipToStockroomId) po.setValue('ship_to', input.shipToStockroomId)
    const poId = po.insert() ?? ''

    const item = new GlideRecord('proc_po_item')
    item.initialize()
    item.setValue('purchase_order', poId)
    item.setValue('model', input.modelId)
    item.setValue('ordered_quantity', input.quantity)
    item.setValue('status', 'requested')
    item.insert()
    return poId
}

/** Units of a model on purchase orders (by description prefix) that are not yet received or cancelled. */
export function openPurchaseQuantity(descriptionPrefix: string, modelId: string): number {
    const item = new GlideRecord('proc_po_item')
    item.addQuery('model', modelId)
    item.addQuery('purchase_order.short_description', 'STARTSWITH', descriptionPrefix)
    item.addQuery('purchase_order.status', 'NOT IN', 'received,canceled,cancelled')
    item.query()
    let open = 0
    while (item.next()) open += Math.max(0, Number(item.getValue('ordered_quantity')) - Number(item.getValue('received_quantity') || 0))
    return open
}
