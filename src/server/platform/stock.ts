import { GlideRecord, gs } from '@servicenow/glide'
import { stagesQuery, type Stage } from '../domain/lifecycle'
import type { StockCandidate, StockroomType } from '../domain/sourcing'
import { moveAsset, readStage } from './assets'
import { withLock, type HeldLock } from './locks'
import { str } from './records'

/** Stock that can serve an Order line, and claiming it for one. */

/** Free stock and spare-pool stock of `modelId` on no Order line: a hot spare linked to a line stays in the pool but is taken. */
export function stockCandidates(modelId: string, limit: number): StockCandidate[] {
    const asset = new GlideRecord('alm_hardware')
    asset.addEncodedQuery(stagesQuery(['available', 'spare_pool'], `model=${modelId}^x_daas_ham_order_lineISEMPTY`))
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
 * free or the save is refused (see `claim`).
 */
export function reserveAsset(assetId: string, reservation: Reservation): GlideRecord | null {
    return claim(assetId, 'reserved', reservation)
}

/**
 * Link a hot spare in a customer-site stockroom (that Customer's Spare pool by definition) to an Order line: it stays
 * in the pool and is installed from where it is. Null when it is no longer free or the save is refused (see `claim`).
 */
export function linkHotSpare(assetId: string, reservation: Reservation): GlideRecord | null {
    return claim(assetId, 'spare_pool', reservation)
}

/**
 * Put an in-stock Asset on an Order line in stage `to`. Two sourcing runs may pick the same Asset, so the claim is made
 * under a lock on that Asset and checks a fresh read: still available or in a spare pool, and on no Order line. A run
 * that finds the lock held (or cannot take it, when the holder lets go mid-take) leaves the Asset to the other one.
 */
function claim(assetId: string, to: Stage, reservation: Reservation): GlideRecord | null {
    let claimed: GlideRecord | null = null
    let started = false
    try {
        withLock(`reserve_asset_${assetId}`, (lock) => {
            started = true
            claimed = claimHolding(lock, assetId, to, reservation)
        })
    } catch (error) {
        // An error from the claim itself is the claim's to report; one from taking the lock only means not now.
        if (started) throw error
        gs.warn(`[x_daas_ham] Asset ${assetId} not claimed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return claimed
}

/**
 * The claim, made holding `lock`. A holder that outlasts the lock (ADR 0013) may overlap the next one, so it saves only
 * while it still holds the lock, and one that lost it during the save keeps the claim only if a fresh read still shows
 * the Asset on this line.
 */
function claimHolding(lock: HeldLock, assetId: string, to: Stage, reservation: Reservation): GlideRecord | null {
    const asset = new GlideRecord('alm_hardware')
    if (!asset.get(assetId) || !isUnclaimed(asset) || !moveAsset(asset, to).allowed) return null
    asset.setValue('x_daas_ham_order_line', reservation.orderLineId)
    asset.setValue('company', reservation.customerId)
    asset.setValue('x_daas_ham_agreement', reservation.agreementId)
    if (!lock.held()) return lockLost(assetId)
    if (!asset.update()) return null
    if (lock.held()) return asset
    const fresh = new GlideRecord('alm_hardware')
    return fresh.get(assetId) && str(fresh, 'x_daas_ham_order_line') === reservation.orderLineId ? fresh : lockLost(assetId)
}

/** Still free stock or spare-pool stock, and on no Order line. */
function isUnclaimed(asset: GlideRecord): boolean {
    const stage = readStage(asset)
    return (stage === 'available' || stage === 'spare_pool') && !str(asset, 'x_daas_ham_order_line')
}

function lockLost(assetId: string): null {
    gs.warn(`[x_daas_ham] Asset ${assetId} not claimed: its lock was lost while claiming it`)
    return null
}
