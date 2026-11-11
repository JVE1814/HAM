import { GlideRecord } from '@servicenow/glide'
import { messageOf } from '../domain/errors.ts'
import { LOCK_TRIES, type HeldLock } from '../domain/job-lock.ts'
import type { Stage } from '../domain/lifecycle.ts'
import { LOCK } from '../domain/lock-names.ts'
import {
    candidateLimit,
    isClaimable,
    stockQueries,
    type StockCandidate,
    type StockScope,
    type StockUnit,
} from '../domain/sourcing.ts'
import { moveAsset, readStage } from './assets.ts'
import { attemptLock, type LockRun } from './locks.ts'
import { stringProperty } from './properties.ts'
import { PROPERTY } from '../domain/properties.ts'
import { refusal, str } from './records.ts'
import { STOCK_STAGES } from '../domain/lifecycle.ts'
import { log } from './log.ts'

/** Stock that can serve an Order line, claiming it for one, giving it back, and changing it where a claim could race. */

/**
 * Stock on no Order line that may serve `scope` for a `shortfall`, each unit under the Source whose query found it
 * (domain/sourcing `stockQueries`): a bounded number per Source (`candidateLimit`), by stockroom then sys_id so the
 * limit cuts the same way each run. A hot spare linked to a line stays in the pool but is taken.
 */
export function stockCandidates(scope: StockScope, shortfall: number): StockCandidate[] {
    const limit = candidateLimit(shortfall)
    const candidates: StockCandidate[] = []
    for (const { source, query } of stockQueries(scope)) {
        const asset = new GlideRecord('alm_hardware')
        asset.addEncodedQuery(query)
        asset.orderBy('stockroom')
        asset.orderBy('sys_id')
        asset.setLimit(limit)
        asset.query()
        while (asset.next()) {
            candidates.push({ assetId: asset.getUniqueValue(), modelId: scope.modelId, stockroomId: str(asset, 'stockroom'), source })
        }
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
    return claim(assetId, { from: STOCK_STAGES, to: 'reserved', values: lineValues(reservation) })
}

/**
 * Link a hot spare in a customer-site stockroom (that Customer's Spare pool by definition) to an Order line: it stays
 * in the pool and is installed from where it is. Null when it is no longer free or the save is refused (see `claim`).
 */
export function linkHotSpare(assetId: string, reservation: Reservation): GlideRecord | null {
    return claim(assetId, { from: STOCK_STAGES, to: 'spare_pool', values: lineValues(reservation) })
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

/**
 * Take a unit off its Order line and no more (the caller saves): one that stays its Customer's (a hot spare, a unit
 * that failed staging or left in transit). Every unit that leaves a line is taken off it here or by
 * `releaseToProviderStock`.
 */
export function takeOffOrderLine(asset: GlideRecord): void {
    asset.setValue('x_daas_ham_order_line', '')
}

/**
 * Give a unit back to Provider stock, the inverse of a reservation (`lineValues`): it is the Provider's own again
 * (its company, ADR 0006), under no Agreement and on no Order line. Sets the fields only: the caller moves the Asset to
 * the stage it goes back to and saves it, each with its own answer to a refusal.
 */
export function releaseToProviderStock(asset: GlideRecord): void {
    takeOffOrderLine(asset)
    asset.setValue('company', stringProperty(PROPERTY.providerCompany))
    asset.setValue('x_daas_ham_agreement', '')
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
 * the Asset, so it tries once: the holder is another claim taking it, or a change (`changeStock`) holding it for one
 * read and one save, and the unit then counts as short just as one another run claimed.
 */
function claim(assetId: string, wanted: Claim): GlideRecord | null {
    const claimed = underStockLock(assetId, 1, 'claimed', (asset, lock) => asset && claimHolding(lock, asset, wanted))
    return claimed.ran ? claimed.value : null
}

/**
 * Change an in-stock Asset that a claim could take meanwhile (withdrawing it for its Lessor, putting it away), under
 * the lock claims take, so a claim lands wholly before `change` reads the Asset or after it saves. `change` gets the
 * Asset read afresh there (null when it is gone), to check again before it saves; a holder that outlasts the lock (ADR
 * 0013) may overlap a claim, so it saves through `lock`. What `change` returned, or `ran: false` when other holders
 * kept the lock through every try (a claim holds it for one read and one save, and someone waits on the change), or
 * it could not be taken (logged with `what`): `change` did not run. Its own errors escape.
 */
export function changeStock<T>(assetId: string, what: string, change: StockWork<T>): LockRun<T> {
    return underStockLock(assetId, LOCK_TRIES, what, change)
}

/** Work on an Asset read afresh holding its stock `lock`; null when the Asset is gone. */
type StockWork<T> = (asset: GlideRecord | null, lock: HeldLock) => T

/**
 * Run `work` holding the Asset's stock lock, which every claim and every change a claim could race takes. A lock that
 * cannot be taken (the insert is refused with no lock row, platform/locks) is logged as the Asset not `what`, and it is
 * left as it is.
 */
function underStockLock<T>(assetId: string, tries: number, what: string, work: StockWork<T>): LockRun<T> {
    const attempt = attemptLock(
        LOCK.reserveAsset(assetId),
        (lock) => {
            const asset = new GlideRecord('alm_hardware')
            return work(asset.get(assetId) ? asset : null, lock)
        },
        tries,
    )
    if (!attempt.ran && !attempt.held) log.warn(`Asset ${assetId} not ${what}: ${messageOf(attempt.error)}`)
    return attempt
}

/**
 * The claim, made holding `lock` on the Asset's fresh read. A holder that outlasts the lock (ADR 0013) may overlap the
 * next one, so it saves only while it still holds the lock, and one that lost it during the save keeps the claim only
 * if a fresh read still shows the Asset in the stage and with the values claimed. A save the platform refuses is
 * logged: the Asset stays as it was, and the caller counts it as not claimed.
 */
function claimHolding(lock: HeldLock, asset: GlideRecord, wanted: Claim): GlideRecord | null {
    const assetId = asset.getUniqueValue()
    if (!isClaimable(stockUnit(asset), wanted.from)) return null
    if (!moveAsset(asset, wanted.to).allowed) return null
    for (const [field, value] of Object.entries(wanted.values)) asset.setValue(field, value)
    const saved = lock.write(() => asset.update())
    if (!saved.written) return lockLost(assetId)
    if (!saved.value) {
        log.warn(`Asset ${str(asset, 'serial_number') || assetId} not claimed as ${wanted.to}: ${refusal(asset)}`)
        return null
    }
    if (!saved.lockLost) return asset
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
    log.warn(`Asset ${assetId} not claimed: its lock was lost while claiming it`)
    return null
}
