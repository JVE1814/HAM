import { GlideAggregate, GlideRecord, gs } from '@servicenow/glide'
import { andEachClause } from '../domain/encoded-query.ts'
import { fleetStagesQuery } from '../domain/fleet.ts'
import { DEPLOYED_STAGES } from '../domain/lifecycle.ts'
import {
    freeStockOf,
    pickForSparePool,
    reservedSparesQuery,
    sparePoolLead,
    sparePools,
    sparePoolShortfall,
    type DeployedShare,
    type SparePool,
} from '../domain/sourcing.ts'
import { runTableJob } from '../platform/chunked.ts'
import { withLockTries, type HeldLock } from '../platform/locks.ts'
import { openPurchaseQuantity, requestPurchase } from '../platform/procurement.ts'
import { boolProperty, PROPERTY, stagingStockroom } from '../platform/properties.ts'
import { num, str } from '../platform/records.ts'
import { moveToSparePool, stockCandidates } from '../platform/stock.ts'

/** The Agreements whose deployed units size their Customer's Spare pools (P1.4). */
const POOL_AGREEMENTS = 'state=active^spare_pool_ratio>0'

/**
 * Daily job: keep each Customer's Spare pool of each Model at the size their Agreements' spare-pool ratios give
 * (domain/sourcing `sparePools`), counting and moving fleet assets only (ADR 0016): the pool, the deployed units it is
 * sized by, and the free stock it is filled from. The pass runs over the Agreements; a Customer's pools are topped up
 * from the row of their lead Agreement (`sparePoolLead`) and the rows of their other Agreements are passed over.
 */
export function topUpSparePools(): void {
    const autoPurchase = boolProperty(PROPERTY.autoPurchaseSpares, false) && canPurchase()
    runTableJob({
        job: 'spare_pool_top_up',
        table: 'x_daas_ham_agreement',
        query: POOL_AGREEMENTS,
        read: (agreement) => str(agreement, 'customer'),
        handle: (customerId, agreementId) => topUpCustomer(customerId, agreementId, autoPurchase),
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

/** The Customer's Agreements the top-up runs over, with their spare-pool ratios. */
function poolAgreements(customerId: string): Map<string, number> {
    const agreement = new GlideRecord('x_daas_ham_agreement')
    agreement.addEncodedQuery(`${POOL_AGREEMENTS}^customer=${customerId}`)
    agreement.query()
    const ratios = new Map<string, number>()
    while (agreement.next()) ratios.set(agreement.getUniqueValue(), num(agreement, 'spare_pool_ratio'))
    return ratios
}

/** The deployed fleet units (ADR 0016) of each of the Agreements, by Model, each with its Agreement's ratio. */
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
        // A unit with no Model has no pool: no stock is free for it.
        if (modelId) shares.push({ agreementId, modelId, deployed: Number(ga.getAggregate('COUNT', '')), ratio: ratios.get(agreementId) ?? 0 })
    }
    return shares
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
 * From the row of the Customer's lead Agreement only: move free central stock into each of the Customer's Spare pools,
 * and buy what is still missing when `autoPurchase`, one Model at a time under that pool's lock. Taking it throws only
 * when an insert is refused with no lock row (platform/locks): that error escapes, and the Agreement fails as a record
 * of the run.
 */
function topUpCustomer(customerId: string, agreementId: string, autoPurchase: boolean): void {
    if (!customerId) return
    const ratios = poolAgreements(customerId)
    if (sparePoolLead([...ratios.keys()]) !== agreementId) return
    const reserved = countByModel(reservedSparesQuery(customerId))
    for (const pool of sparePools(deployedShares(ratios))) {
        // A pool these counts show full is left without its lock: another run's top-up meanwhile only fills it.
        if (sparePoolShortfall(pool.size, reserved.get(pool.modelId) ?? 0) === 0) continue
        const lockName = `spare_pool_${customerId}_${pool.modelId}`
        if (withLockTries(lockName, POOL_LOCK_TRIES, (lock) => topUpPool(customerId, pool, autoPurchase, lock))) continue
        gs.info(`[x_daas_ham] Spare pool of ${customerId} for ${pool.modelId} not topped up: another run holds the ${lockName} lock and tops it up`)
    }
}

/**
 * Count the pool afresh, move free central stock into it and, when `autoPurchase`, buy what is still missing, holding
 * its `lock`. A run that outlasts the lock (ADR 0013) buys nothing once it has lost it: the run that took it over
 * counted the pool afresh and buys for it, though it may have counted before this run's moves were saved.
 */
function topUpPool(customerId: string, pool: SparePool, autoPurchase: boolean, lock: HeldLock): void {
    const { modelId } = pool
    const reserved = countByModel(andEachClause(reservedSparesQuery(customerId), `model=${modelId}`)).get(modelId) ?? 0
    const shortfall = sparePoolShortfall(pool.size, reserved)
    if (shortfall === 0) return
    const picked = pickForSparePool(stockCandidates(freeStockOf(modelId), shortfall * 5 + 50), modelId, shortfall)
    // A unit sourcing claimed in the meantime (or whose save was refused) is not moved and stays in the shortfall.
    const moved = picked.filter((assetId) => moveToSparePool(assetId, customerId, pool.agreementId)).length
    if (!autoPurchase) return
    if (!lock.held()) {
        gs.warn(`[x_daas_ham] Spare pool of ${customerId} for ${modelId}: nothing bought, its lock was lost to the run that took it over`)
        return
    }
    const prefix = `Spare-pool top-up ${customerId}:`
    const missing = shortfall - moved - openPurchaseQuantity(prefix, modelId)
    if (missing > 0) requestPurchase({ modelId, quantity: missing, description: `${prefix} ${missing} unit(s)` })
}
