import { GlideRecord, gs } from '@servicenow/glide'
import type { Stage } from '../domain/lifecycle'
import {
    isClaimable,
    stockQueries,
    type StockCandidate,
    type StockroomType,
    type StockScope,
    type StockUnit,
} from '../domain/sourcing'
import { moveAsset, readStage } from './assets'
import { withLockTries, type HeldLock } from './locks'
import { bool, str } from './records'

/** Stock that can serve an Order line, claiming it for one, and changing it where a claim could race. */

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
 * made under the Asset's stock lock (`underStockLock`) and checks a fresh read: still in one of the `from` stages, on
 * no Order line, and not bound for its Lessor (domain/sourcing `isClaimable`). A run that finds the lock held leaves
 * the Asset to the other one, so it tries once.
 */
function claim(assetId: string, wanted: Claim): GlideRecord | null {
    let claimed: GlideRecord | null = null
    underStockLock(assetId, 1, 'claimed', (asset, lock) => {
        claimed = asset && claimHolding(lock, asset, wanted)
    })
    return claimed
}

/**
 * Tries at an Asset's stock lock for a change someone waits on (a put-away scan, a lease return): a claim holds it for
 * one read and one save.
 */
const CHANGE_TRIES = 5

/**
 * Change an in-stock Asset that a claim could take meanwhile (withdrawing it for its Lessor, putting it away), under
 * the lock claims take, so a claim lands wholly before `change` reads the Asset or after it saves. `change` gets the
 * Asset read afresh there (null when it is gone), to check again before it saves; a holder that outlasts the lock (ADR
 * 0013) may overlap a claim, so it saves only while `lock.held()`. False when other holders kept the lock through every
 * try, or it could not be taken (logged with `what`): `change` did not run. Its own errors escape.
 */
export function changeStock(assetId: string, what: string, change: StockWork): boolean {
    return underStockLock(assetId, CHANGE_TRIES, what, change)
}

/** Work on an Asset read afresh holding its stock `lock`; null when the Asset is gone. */
type StockWork = (asset: GlideRecord | null, lock: HeldLock) => void

/**
 * Run `work` holding the Asset's stock lock (`reserve_asset_<sys_id>`), which every claim and every change a claim
 * could race takes. Taking the lock throws only when an insert is refused with no lock row (platform/locks); that is
 * logged as the Asset not `what`, and it is left as it is.
 */
function underStockLock(assetId: string, tries: number, what: string, work: StockWork): boolean {
    let started = false
    try {
        return withLockTries(`reserve_asset_${assetId}`, tries, (lock) => {
            started = true
            const asset = new GlideRecord('alm_hardware')
            work(asset.get(assetId) ? asset : null, lock)
        })
    } catch (error) {
        // An error from the work itself is the caller's to report; one from taking the lock leaves the Asset as it is.
        if (started) throw error
        gs.warn(`[x_daas_ham] Asset ${assetId} not ${what}: ${error instanceof Error ? error.message : String(error)}`)
        return false
    }
}

/**
 * The claim, made holding `lock` on the Asset's fresh read. A holder that outlasts the lock (ADR 0013) may overlap the
 * next one, so it saves only while it still holds the lock, and one that lost it during the save keeps the claim only
 * if a fresh read still shows the Asset in the stage and with the values claimed.
 */
function claimHolding(lock: HeldLock, asset: GlideRecord, wanted: Claim): GlideRecord | null {
    const assetId = asset.getUniqueValue()
    if (!isClaimable(stockUnit(asset), wanted.from)) return null
    if (!moveAsset(asset, wanted.to).allowed) return null
    for (const [field, value] of Object.entries(wanted.values)) asset.setValue(field, value)
    if (!lock.held()) return lockLost(assetId)
    if (!asset.update()) return null
    if (lock.held()) return asset
    const fresh = new GlideRecord('alm_hardware')
    return fresh.get(assetId) && shows(fresh, wanted) ? fresh : lockLost(assetId)
}

/** The Asset as domain/sourcing judges whether it is still free stock (`isFree`, `isClaimable`). */
export function stockUnit(asset: GlideRecord): StockUnit {
    return {
        stage: readStage(asset),
        orderLineId: str(asset, 'x_daas_ham_order_line'),
        leaseEndAction: str(asset, 'x_daas_ham_lease.end_action') as StockUnit['leaseEndAction'],
    }
}

function shows(asset: GlideRecord, wanted: Claim): boolean {
    return readStage(asset) === wanted.to && Object.entries(wanted.values).every(([field, value]) => str(asset, field) === value)
}

function lockLost(assetId: string): null {
    gs.warn(`[x_daas_ham] Asset ${assetId} not claimed: its lock was lost while claiming it`)
    return null
}
