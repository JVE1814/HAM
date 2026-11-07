import { GlideRecord } from '@servicenow/glide'
import { stagesQuery } from '../domain/lifecycle'
import type { StockCandidate, StockroomType } from '../domain/sourcing'
import { moveAsset, readStage } from './assets'
import { withLock } from './locks'
import { str } from './records'

/** Stock that can serve an Order line, and reserving it. */

export function stockCandidates(modelId: string, limit: number): StockCandidate[] {
    const asset = new GlideRecord('alm_hardware')
    asset.addEncodedQuery(stagesQuery(['available', 'spare_pool'], `model=${modelId}`))
    asset.setLimit(limit)
    asset.query()
    const candidates: StockCandidate[] = []
    while (asset.next()) {
        const stage = readStage(asset)
        if (stage !== 'available' && stage !== 'spare_pool') continue
        const stockroomType = (str(asset, 'stockroom.x_daas_ham_stockroom_type') || 'central_depot') as StockroomType
        candidates.push({
            assetId: asset.getUniqueValue(),
            modelId,
            stage,
            stockroomId: str(asset, 'stockroom'),
            stockroomType,
            reservedFor:
                stockroomType === 'customer_site'
                    ? str(asset, 'stockroom.x_daas_ham_customer')
                    : stage === 'spare_pool'
                      ? str(asset, 'company')
                      : '',
        })
    }
    return candidates
}

export interface Reservation {
    orderLineId: string
    customerId: string
    agreementId: string
}

/**
 * Reserve an in-stock Asset for an Order line (company becomes the Customer, ADR 0006), or null when it is no longer
 * free or the save is refused. Two sourcing runs may pick the same Asset, so the claim is made under a lock on that
 * Asset and checks a fresh read: still available or in a spare pool, and on no Order line. A run that finds the lock
 * held leaves the Asset to the other one.
 */
export function reserveAsset(assetId: string, reservation: Reservation): GlideRecord | null {
    let reserved: GlideRecord | null = null
    withLock(`reserve_asset_${assetId}`, () => {
        const asset = new GlideRecord('alm_hardware')
        if (!asset.get(assetId)) return
        const stage = readStage(asset)
        if ((stage !== 'available' && stage !== 'spare_pool') || str(asset, 'x_daas_ham_order_line')) return
        if (!moveAsset(asset, 'reserved').allowed) return
        asset.setValue('x_daas_ham_order_line', reservation.orderLineId)
        asset.setValue('company', reservation.customerId)
        asset.setValue('x_daas_ham_agreement', reservation.agreementId)
        if (asset.update()) reserved = asset
    })
    return reserved
}
