import { GlideAggregate, GlideRecord } from '@servicenow/glide'
import { andEachClause } from '../domain/encoded-query.ts'
import { fleetStagesQuery } from '../domain/fleet.ts'
import type { HeldLock } from '../domain/job-lock.ts'
import { DEPLOYED_STAGES } from '../domain/lifecycle.ts'
import { LOCK } from '../domain/lock-names.ts'
import {
    reservedSparesQuery,
    sparePoolLead,
    sparePools,
    sparePoolShortfall,
    type DeployedShare,
    type SparePool,
} from '../domain/spare-pools.ts'
import { ACTIVE_AGREEMENTS } from './agreements.ts'
import { runTableJob } from './chunked.ts'
import { withLockTries } from './locks.ts'
import { openSparePurchaseQuantity, requestSparePurchase } from './procurement.ts'
import { boolProperty } from './properties.ts'
import { stagingStockroom } from './staging-tasks.ts'
import { PROPERTY } from '../domain/properties.ts'
import { countBy, num, str } from './records.ts'
import { freeStock, moveToSparePool } from './stock.ts'
import { log } from './log.ts'

/**
 * Keeping each Customer's Spare pool of each Model at the size their Agreements' spare-pool ratios give (P1.4,
 * domain/spare-pools `sparePools`), counting and moving fleet assets only (ADR 0016): the pool, the deployed units it is
 * sized by, and the free stock it is filled from.
 */

const POOL_AGREEMENTS = `${ACTIVE_AGREEMENTS}^spare_pool_ratio>0`

/**
 * One chunk of the daily top-up (a scheduled chunked job). The pass runs over the Agreements that keep spares; a
 * Customer's pools are topped up from the row of their lead Agreement (`sparePoolLead`) and the rows of their other
 * Agreements are passed over.
 */
export function runSparePoolTopUp(): void {
    const autoPurchase = sparePurchasesEnabled()
    runTableJob({
        job: 'spare_pool_top_up',
        table: 'x_daas_ham_agreement',
        query: POOL_AGREEMENTS,
        read: (agreement) => str(agreement, 'customer'),
        handle: (customerId, agreementId) => topUpCustomerPools(customerId, agreementId, autoPurchase),
    })
}

/**
 * Whether a top-up run buys the spares it cannot find in stock: when the auto-purchase property is on and there is a
 * staging stockroom for them to ship to. Without one, the run buys none and says so, once.
 */
function sparePurchasesEnabled(): boolean {
    if (!boolProperty(PROPERTY.autoPurchaseSpares)) return false
    if (stagingStockroom()) return true
    log.warn(`Spare-pool top-up buys no spares: set ${PROPERTY.stagingStockroom.name}`)
    return false
}

function poolAgreements(customerId: string): Map<string, number> {
    const agreement = new GlideRecord('x_daas_ham_agreement')
    agreement.addEncodedQuery(`${POOL_AGREEMENTS}^customer=${customerId}`)
    agreement.query()
    const ratios = new Map<string, number>()
    while (agreement.next()) ratios.set(agreement.getUniqueValue(), num(agreement, 'spare_pool_ratio'))
    return ratios
}

function deployedShares(ratios: ReadonlyMap<string, number>): DeployedShare[] {
    const ga = new GlideAggregate('alm_hardware')
    ga.addEncodedQuery(fleetStagesQuery(DEPLOYED_STAGES, `x_daas_ham_agreementIN${[...ratios.keys()].join(',')}`))
    ga.addAggregate('COUNT', '')
    ga.groupBy('x_daas_ham_agreement')
    ga.groupBy('model')
    ga.query()
    const shares: DeployedShare[] = []
    while (ga.next()) {
        const agreementId = String(ga.getValue('x_daas_ham_agreement') ?? '')
        const modelId = String(ga.getValue('model') ?? '')
        if (modelId) shares.push({ agreementId, modelId, deployed: Number(ga.getAggregate('COUNT', '')), ratio: ratios.get(agreementId) ?? 0 })
    }
    return shares
}

/**
 * From the row of the Customer's lead Agreement only: move free central stock into each of the Customer's Spare pools,
 * and buy what is still missing when `autoPurchase`, one Model at a time under that pool's lock (ADR 0013). Two runs at once (the scheduled job and an *Execute now*) would both
 * count the same shortfall and no open purchase, and each buy all of it, so a pool is counted, filled and bought for
 * holding its lock. One held through every try, back to back, is left to the run holding it, which counted it afresh.
 * Taking it throws only when an insert is refused with no lock row (platform/locks): that error escapes, and the
 * Agreement fails as a record of the run.
 */
function topUpCustomerPools(customerId: string, agreementId: string, autoPurchase: boolean): void {
    if (!customerId) return
    const ratios = poolAgreements(customerId)
    if (sparePoolLead([...ratios.keys()]) !== agreementId) return
    const reserved = countBy('alm_hardware', reservedSparesQuery(customerId), 'model')
    for (const pool of sparePools(deployedShares(ratios))) {
        // A pool these counts show full is left without its lock: another run's top-up meanwhile only fills it.
        if (sparePoolShortfall(pool.size, reserved.get(pool.modelId) ?? 0) === 0) continue
        const lockName = LOCK.sparePool(customerId, pool.modelId)
        if (withLockTries(lockName, (lock) => topUpPool(customerId, pool, autoPurchase, lock)).ran) continue
        log.info(`Spare pool of ${customerId} for ${pool.modelId} not topped up: another run holds the ${lockName} lock and tops it up`)
    }
}

/**
 * Count the pool afresh, move free central stock into it and, when `autoPurchase`, buy what is still missing, holding
 * its `lock`. A run that outlasts the lock (ADR 0013) buys nothing once it has lost it: the run that took it over
 * counted the pool afresh and buys for it, though it may have counted before this run's moves were saved.
 */
function topUpPool(customerId: string, pool: SparePool, autoPurchase: boolean, lock: HeldLock): void {
    const { modelId } = pool
    const reserved = countBy('alm_hardware', andEachClause(reservedSparesQuery(customerId), `model=${modelId}`), 'model').get(modelId) ?? 0
    const shortfall = sparePoolShortfall(pool.size, reserved)
    if (shortfall === 0) return
    const picked = freeStock(modelId, shortfall)
    // A unit sourcing claimed in the meantime (or whose save was refused) is not moved and stays in the shortfall.
    const moved = picked.filter((assetId) => moveToSparePool(assetId, customerId, pool.agreementId)).length
    if (!autoPurchase) return
    if (!lock.held()) {
        log.warn(`Spare pool of ${customerId} for ${modelId}: nothing bought, its lock was lost to the run that took it over`)
        return
    }
    const missing = shortfall - moved - openSparePurchaseQuantity(customerId, modelId)
    if (missing > 0) requestSparePurchase(customerId, modelId, missing)
}
