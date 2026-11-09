import { GlideAggregate, gs } from '@servicenow/glide'
import { andEachClause } from '../domain/encoded-query.ts'
import { fleetStagesQuery } from '../domain/fleet.ts'
import { DEPLOYED_STAGES } from '../domain/lifecycle.ts'
import { freeStockOf, pickForSparePool, reservedSparesQuery, sparePoolShortfall } from '../domain/sourcing.ts'
import { runTableJob } from '../platform/chunked.ts'
import { withLockTries, type HeldLock } from '../platform/locks.ts'
import { openPurchaseQuantity, requestPurchase } from '../platform/procurement.ts'
import { boolProperty, PROPERTY, stagingStockroom } from '../platform/properties.ts'
import { num, str } from '../platform/records.ts'
import { moveToSparePool, stockCandidates } from '../platform/stock.ts'

/**
 * Daily job: keep every Customer's Spare pool at its Agreement's spare-pool ratio (P1.4), counting and moving fleet
 * assets only (ADR 0016): the pool, the deployed units it is sized by, and the free stock it is filled from.
 */
export function topUpSparePools(): void {
    const autoPurchase = boolProperty(PROPERTY.autoPurchaseSpares, false) && canPurchase()
    runTableJob({
        job: 'spare_pool_top_up',
        table: 'x_daas_ham_agreement',
        query: 'state=active^spare_pool_ratio>0',
        read: (agreement) => ({ customerId: str(agreement, 'customer'), ratio: num(agreement, 'spare_pool_ratio') }),
        handle: (agreement, agreementId) => topUpAgreement(agreementId, agreement.customerId, agreement.ratio, autoPurchase),
    })
}

function countByModel(query: string): Map<string, number> {
    const ga = new GlideAggregate('alm_hardware')
    ga.addEncodedQuery(query)
    ga.addAggregate('COUNT', '')
    ga.groupBy('model')
    ga.query()
    const counts = new Map<string, number>()
    while (ga.next()) counts.set(String(ga.getValue('model') ?? ''), Number(ga.getAggregate('COUNT', '')))
    return counts
}

/** Purchased spares ship to the staging stockroom: without one, the run buys none and says so once. */
function canPurchase(): boolean {
    if (stagingStockroom()) return true
    gs.warn(`[x_daas_ham] Spare-pool top-up buys no spares: set ${PROPERTY.stagingStockroom}`)
    return false
}

/**
 * Tries at a Spare pool's lock (`spare_pool_<Customer sys_id>_<Model sys_id>`, ADR 0013), back to back. Two runs at once
 * (the scheduled job and an *Execute now*) would both count the same shortfall and no open purchase, and each buy all
 * of it, so a pool is counted, filled and bought for holding its lock. One held through every try is left to the run
 * holding it, which counted it afresh.
 */
const POOL_LOCK_TRIES = 5

/**
 * Move free central stock into the Customer's Spare pool, and buy what is still missing when `autoPurchase`, one Model
 * at a time under that pool's lock. Taking it throws only when an insert is refused with no lock row (platform/locks):
 * that error escapes, and the Agreement fails as a record of the run.
 */
function topUpAgreement(agreementId: string, customerId: string, ratio: number, autoPurchase: boolean): void {
    const deployed = countByModel(fleetStagesQuery(DEPLOYED_STAGES, `x_daas_ham_agreement=${agreementId}`))
    const reserved = countByModel(reservedSparesQuery(customerId))
    for (const [modelId, deployedCount] of deployed) {
        // A pool these counts show full is left without its lock: another run's top-up meanwhile only fills it.
        if (sparePoolShortfall({ deployed: deployedCount, reserved: reserved.get(modelId) ?? 0, ratio }) === 0) continue
        const pool = { agreementId, customerId, modelId, deployed: deployedCount, ratio }
        const lockName = `spare_pool_${customerId}_${modelId}`
        if (withLockTries(lockName, POOL_LOCK_TRIES, (lock) => topUpPool(pool, autoPurchase, lock))) continue
        gs.info(`[x_daas_ham] Spare pool of ${customerId} for ${modelId} not topped up: another run holds the ${lockName} lock and tops it up`)
    }
}

interface Pool {
    agreementId: string
    customerId: string
    modelId: string
    deployed: number
    ratio: number
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
    const picked = pickForSparePool(stockCandidates(freeStockOf(modelId), shortfall * 5 + 50), modelId, shortfall)
    // A unit sourcing claimed in the meantime (or whose save was refused) is not moved and stays in the shortfall.
    const moved = picked.filter((assetId) => moveToSparePool(assetId, customerId, agreementId)).length
    if (!autoPurchase) return
    if (!lock.held()) {
        gs.warn(`[x_daas_ham] Spare pool of ${customerId} for ${modelId}: nothing bought, its lock was lost to the run that took it over`)
        return
    }
    const prefix = `Spare-pool top-up ${agreementId}:`
    const missing = shortfall - moved - openPurchaseQuantity(prefix, modelId)
    if (missing > 0) requestPurchase({ modelId, quantity: missing, description: `${prefix} ${missing} unit(s)` })
}
