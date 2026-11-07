import { GlideRecord, gs } from '@servicenow/glide'
import type { TransferResult } from '../domain/sourcing'
import { deleteWhere, str } from './records'

/**
 * Transfer orders (alm_transfer_order) moving reserved stock to the staging centre, one line per Asset. A
 * transfer order is only good with all its lines: when Inventory does not create the header or one of the
 * lines, what was created is removed (or, if it cannot be, named in the reason for cancelling), a warning is
 * logged and the result says why.
 */
export function requestTransfer(input: {
    fromStockroomId: string
    toStockroomId: string
    assets: ReadonlyArray<{ assetId: string; modelId: string }>
}): TransferResult {
    const transfer = new GlideRecord('alm_transfer_order')
    transfer.initialize()
    transfer.setValue('from_stockroom', input.fromStockroomId)
    transfer.setValue('to_stockroom', input.toStockroomId)
    const transferId = transfer.insert()
    if (!transferId) return noTransfer(input.fromStockroomId, 'Inventory did not create it')
    for (const { assetId, modelId } of input.assets) {
        const line = new GlideRecord('alm_transfer_order_line')
        line.initialize()
        line.setValue('transfer_order', transferId)
        line.setValue('model', modelId)
        line.setValue('asset', assetId)
        line.setValue('quantity_requested', 1)
        if (line.insert()) continue
        deleteWhere('alm_transfer_order_line', `transfer_order=${transferId}`)
        const removed = transfer.deleteRecord()
        return noTransfer(
            input.fromStockroomId,
            removed ? 'Inventory did not create all its lines' : `Inventory did not create all the lines of ${str(transfer, 'number')}; cancel it`,
        )
    }
    return { ok: true, transferId }
}

function noTransfer(fromStockroomId: string, reason: string): TransferResult {
    gs.warn(`[x_daas_ham] No transfer order from stockroom ${fromStockroomId} (${reason})`)
    return { ok: false, reason }
}
