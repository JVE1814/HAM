import { GlideRecord } from '@servicenow/glide'

/** Transfer orders (alm_transfer_order) moving reserved stock to the staging centre. */
export function requestTransfer(input: {
    fromStockroomId: string
    toStockroomId: string
    assets: ReadonlyArray<{ assetId: string; modelId: string }>
}): string {
    const transfer = new GlideRecord('alm_transfer_order')
    transfer.initialize()
    transfer.setValue('from_stockroom', input.fromStockroomId)
    transfer.setValue('to_stockroom', input.toStockroomId)
    const transferId = transfer.insert() ?? ''
    for (const { assetId, modelId } of input.assets) {
        const line = new GlideRecord('alm_transfer_order_line')
        line.initialize()
        line.setValue('transfer_order', transferId)
        line.setValue('model', modelId)
        line.setValue('asset', assetId)
        line.setValue('quantity_requested', 1)
        line.insert()
    }
    return transferId
}
