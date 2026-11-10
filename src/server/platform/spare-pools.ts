import { gs } from '@servicenow/glide'
import { andEachClause } from '../domain/encoded-query.ts'
import { fleetStagesQuery } from '../domain/fleet.ts'
import type { HeldLock } from '../domain/job-lock.ts'
import { DEPLOYED_STAGES } from '../domain/lifecycle.ts'
import { LOCK } from '../domain/lock-names.ts'
import { freeStockOf, pickForSparePool, reservedSparesQuery, sparePoolShortfall } from '../domain/sourcing.ts'
import { ACTIVE_AGREEMENTS } from './agreements.ts'
import { runTableJob } from './chunked.ts'
import { withLockTries } from './locks.ts'
import { openSparePurchaseQuantity, requestSparePurchase } from './procurement.ts'
import { boolProperty, PROPERTY, stagingStockroom } from './properties.ts'
import { countBy, num, str } from './records.ts'
import { moveToSparePool, stockCandidates } from './stock.ts'

/**
 * Keeping a Customer's Spare pool at its Agreement's spare-pool ratio (P1.4), counting and moving fleet assets only
 * (ADR 0016): the pool, the deployed units it is sized by, and the free stock it is filled from.
 */

/** One chunk of the daily top-up (a scheduled chunked job): each active Agreement that keeps spares, its pools topped up. */
export function runSparePoolTopUp(): void {
    const autoPurchase = sparePurchasesEnabled()
    runTableJob({
        job: 'spare_pool_top_up',
        table: 'x_daas_ham_agreement',
        query: `${ACTIVE_AGREEMENTS}^spare_pool_ratio>0`,
        read: (agreement) => ({ customerId: str(agreement, 'customer'), ratio: num(agreement, 'spare_pool_ratio') }),
        handle: (agreement, agreementId) => topUpAgreementPools({ agreementId, ...agreement }, autoPurchase),
    })
}

/**
 * Whether a top-up run buys the spares it cannot find in stock: when the auto-purchase property is on and there is a
 * staging stockroom for them to ship to. Without one, the run buys none and says so, once.
 */
function sparePurchasesEnabled(): boolean {
    if (!boolProperty(PROPERTY.autoPurchaseSpares)) return false
    if (stagingStockroom()) return true
    gs.warn(`[x_daas_ham] Spare-pool top-up buys no spares: set ${PROPERTY.stagingStockroom.name}`)
    return false
}

function countByModel(query: string): Map<string, number> {
    return countBy('alm_hardware', query, 'model')
}

/** An Agreement whose Spare pools a run tops up: its Customer and the share of deployed units it keeps as spares. */
interface PooledAgreement {
    agreementId: string
    customerId: string
    ratio: number
}

/**
 * Move free central stock into the Customer's Spare pool, and buy what is still missing when `autoPurchase`, one Model
 * at a time under that pool's lock (ADR 0013). Two runs at once (the scheduled job and an *Execute now*) would both
 * count the same shortfall and no open purchase, and each buy all of it, so a pool is counted, filled and bought for
 * holding its lock. One held through every try, back to back, is left to the run holding it, which counted it afresh.
 * Taking it throws only when an insert is refused with no lock row (platform/locks): that error escapes, and the
 * Agreement fails as a record of the run.
 */
function topUpAgreementPools({ agreementId, customerId, ratio }: PooledAgreement, autoPurchase: boolean): void {
    const deployed = countByModel(fleetStagesQuery(DEPLOYED_STAGES, `x_daas_ham_agreement=${agreementId}`))
    const reserved = countByModel(reservedSparesQuery(customerId))
    for (const [modelId, deployedCount] of deployed) {
        // A pool these counts show full is left without its lock: another run's top-up meanwhile only fills it.
        if (sparePoolShortfall({ deployed: deployedCount, reserved: reserved.get(modelId) ?? 0, ratio }) === 0) continue
        const pool = { agreementId, customerId, modelId, deployed: deployedCount, ratio }
        const lockName = LOCK.sparePool(customerId, modelId)
        if (withLockTries(lockName, (lock) => topUpPool(pool, autoPurchase, lock)).ran) continue
        gs.info(`[x_daas_ham] Spare pool of ${customerId} for ${modelId} not topped up: another run holds the ${lockName} lock and tops it up`)
    }
}

interface Pool extends PooledAgreement {
    modelId: string
    deployed: number
}

/**
 * Count the pool afresh, move free central stock into it and, when `autoPurchase`, buy what is still missing, holding
 * its `lock`. A run that outlasts the lock (ADR 0013) buys nothing once it has lost it: the run that took it over
 * counted the pool afresh and buys for it, though it may have counted before this run's moves were saved.
 */
function topUpPool(pool: Pool, autoPurchase: boolean, lock: HeldLock): void {
    const { agreementId, customerId, modelId } = pool
    const reserved = countByModel(andEachClause(reservedSparesQuery(customerId), `model=${modelId}`)).get(modelId) ?? 0
    const shortfall = sparePoolShortfall({ deployed: pool.deployed, reserved, ratio: pool.ratio })
    if (shortfall === 0) return
    const picked = pickForSparePool(stockCandidates(freeStockOf(modelId), shortfall), modelId, shortfall)
    // A unit sourcing claimed in the meantime (or whose save was refused) is not moved and stays in the shortfall.
    const moved = picked.filter((assetId) => moveToSparePool(assetId, customerId, agreementId)).length
    if (!autoPurchase) return
    if (!lock.held()) {
        gs.warn(`[x_daas_ham] Spare pool of ${customerId} for ${modelId}: nothing bought, its lock was lost to the run that took it over`)
        return
    }
    const missing = shortfall - moved - openSparePurchaseQuantity(agreementId, modelId)
    if (missing > 0) requestSparePurchase(agreementId, modelId, missing)
}
