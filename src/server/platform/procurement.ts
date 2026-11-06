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
