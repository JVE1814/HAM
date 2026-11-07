import { GlideRecord, gs } from '@servicenow/glide'
import type { Stage } from '../domain/lifecycle'
import { stockQueries, type StockCandidate, type StockroomType, type StockScope } from '../domain/sourcing'
import { moveAsset, readStage } from './assets'
import { withLock, type HeldLock } from './locks'
import { bool, str } from './records'

/** Stock that can serve an Order line, and claiming it for one. */

/**
 * Stock on no Order line that may serve `scope` (domain/sourcing `stockQueries`): up to `limit` per Source, by
 * stockroom then sys_id so the limit cuts the same way each run. A hot spare linked to a line stays in the pool but
 * is taken.
 */
export function stockCandidates(scope: StockScope, limit: number): StockCandidate[] {
    const candidates: StockCandidate[] = []
    for (const query of stockQueries(scope)) {
        const asset = new GlideRecord('alm_hardware')
        asset.addEncodedQuery(query)
        asset.orderBy('stockroom')
        asset.orderBy('sys_id')
        asset.setLimit(limit)
        asset.query()
        while (asset.next()) {
            const candidate = candidateOf(asset, scope.modelId)
            if (candidate) candidates.push(candidate)
        }
    }
    return candidates
}

function candidateOf(asset: GlideRecord, modelId: string): StockCandidate | null {
    const stage = readStage(asset)
    if (stage !== 'available' && stage !== 'spare_pool') return null
    const stockroomType = (str(asset, 'stockroom.x_daas_ham_stockroom_type') || 'central_depot') as StockroomType
    const atCustomerSite = stockroomType === 'customer_site'
    const pooledFor = stage === 'spare_pool' ? str(asset, 'company') : ''
    return {
        assetId: asset.getUniqueValue(),
        modelId,
        stage,
        stockroomId: str(asset, 'stockroom'),
        stockroomType,
        reservedFor: atCustomerSite ? str(asset, 'stockroom.x_daas_ham_customer') : pooledFor,
        siteId: atCustomerSite ? stockroomSite(asset) : '',
    }
}

/** The Site the Asset's stockroom stands at: its location when that is a Site, else the Site of the Room it is in. */
function stockroomSite(asset: GlideRecord): string {
    const location = str(asset, 'stockroom.location')
    return bool(asset, 'stockroom.location.x_daas_ham_is_site') ? location : str(asset, 'stockroom.location.parent')
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
    return claim(assetId, { from: ['available', 'spare_pool'], to: 'reserved', values: lineValues(reservation) })
}

/**
 * Link a hot spare in a customer-site stockroom (that Customer's Spare pool by definition) to an Order line: it stays
 * in the pool and is installed from where it is. Null when it is no longer free or the save is refused (see `claim`).
 */
export function linkHotSpare(assetId: string, reservation: Reservation): GlideRecord | null {
    return claim(assetId, { from: ['available', 'spare_pool'], to: 'spare_pool', values: lineValues(reservation) })
}

/**
 * Move free stock into a Customer's Spare pool (the daily top-up), or null when it is no longer free stock on no Order
 * line or the save is refused (see `claim`).
 */
export function moveToSparePool(assetId: string, customerId: string, agreementId: string): GlideRecord | null {
    const values = { company: customerId, x_daas_ham_agreement: agreementId, x_daas_ham_order_line: '' }
    return claim(assetId, { from: ['available'], to: 'spare_pool', values })
}

function lineValues(reservation: Reservation): Record<string, string> {
    return {
        x_daas_ham_order_line: reservation.orderLineId,
        company: reservation.customerId,
        x_daas_ham_agreement: reservation.agreementId,
    }
}

/** A claim: the stages the Asset may be in, the stage it moves to, and the values it takes. */
interface Claim {
    from: readonly Stage[]
    to: Stage
    values: Readonly<Record<string, string>>
}

/**
 * Make `wanted` on an in-stock Asset. Sourcing runs and the spare-pool top-up may pick the same Asset, so the claim is
 * made under a lock on that Asset and checks a fresh read: still in one of the `from` stages, and on no Order line. A
 * run that finds the lock held (or cannot take it, when the holder lets go mid-take) leaves the Asset to the other one.
 */
function claim(assetId: string, wanted: Claim): GlideRecord | null {
    let claimed: GlideRecord | null = null
    let started = false
    try {
        withLock(`reserve_asset_${assetId}`, (lock) => {
            started = true
            claimed = claimHolding(lock, assetId, wanted)
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
 * the Asset in the stage and with the values claimed.
 */
function claimHolding(lock: HeldLock, assetId: string, wanted: Claim): GlideRecord | null {
    const asset = new GlideRecord('alm_hardware')
    if (!asset.get(assetId) || !isFree(asset, wanted.from) || !moveAsset(asset, wanted.to).allowed) return null
    for (const [field, value] of Object.entries(wanted.values)) asset.setValue(field, value)
    if (!lock.held()) return lockLost(assetId)
    if (!asset.update()) return null
    if (lock.held()) return asset
    const fresh = new GlideRecord('alm_hardware')
    return fresh.get(assetId) && shows(fresh, wanted) ? fresh : lockLost(assetId)
}

/** In one of the `from` stages, and on no Order line. */
function isFree(asset: GlideRecord, from: readonly Stage[]): boolean {
    const stage = readStage(asset)
    return stage !== null && from.includes(stage) && !str(asset, 'x_daas_ham_order_line')
}

function shows(asset: GlideRecord, wanted: Claim): boolean {
    return readStage(asset) === wanted.to && Object.entries(wanted.values).every(([field, value]) => str(asset, field) === value)
}

function lockLost(assetId: string): null {
    gs.warn(`[x_daas_ham] Asset ${assetId} not claimed: its lock was lost while claiming it`)
    return null
}
