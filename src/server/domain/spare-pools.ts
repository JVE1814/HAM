import { fleetStagesQuery } from './fleet.ts'
import { NOT_LESSOR_BOUND } from './stock.ts'

/** Spare pools (P1.4): how large each Customer's pool of a Model is kept, and the spares it already holds. */

/**
 * An encoded alm_hardware query for the Customer's Spare pool as the top-up counts it: its fleet assets (ADR 0016) in
 * the pool, and those of its spares on a transfer order line. In transfer and on no Order line, a unit held for the
 * Customer (its company) goes back to the pool once Inventory lets it go, received or not (domain/lifecycle
 * `stageAfterTransfer`, ADR 0002): it is still the Customer's spare, and left out the top-up would fill the pool again
 * meanwhile. One in transfer on an Order line is sourcing's, on its way to staging for that line, and no spare. Units
 * bound for their Lessor are left out: sourcing can no longer claim them (domain/stock `isClaimable`), so counted they
 * would keep the pool short.
 */
export function reservedSparesQuery(customerId: string): string {
    const held = `company=${customerId}^${NOT_LESSOR_BOUND}`
    return [fleetStagesQuery(['spare_pool'], held), fleetStagesQuery(['in_transfer'], `${held}^x_daas_ham_order_lineISEMPTY`)].join('^NQ')
}

/** One Agreement's deployed fleet units of a Model, and that Agreement's spare-pool ratio. */
export interface DeployedShare {
    agreementId: string
    modelId: string
    deployed: number
    ratio: number
}

/** A Customer's Spare pool of one Model: the spares it holds when full, and the Agreement the spares moved into it carry. */
export interface SparePool {
    modelId: string
    size: number
    agreementId: string
}

/**
 * A Customer's Spare pools, from their Agreements' deployed fleet units (owner decision): one pool per Model, sized from
 * all of the Customer's deployed units of that Model across their Agreements, each Agreement's ratio applied to its own
 * units, `ceil(Σ deployed × ratio)`, rounded up once for the pool. Spares moved into it carry the Agreement with the
 * largest share (the first by sys_id on a tie): sourcing gives a unit its line's Agreement when it is used.
 */
export function sparePools(shares: readonly DeployedShare[]): SparePool[] {
    const byModel = new Map<string, { spares: number; lead: DeployedShare }>()
    for (const share of shares) {
        const spares = share.deployed * share.ratio
        const pool = byModel.get(share.modelId)
        if (!pool) {
            byModel.set(share.modelId, { spares, lead: share })
            continue
        }
        pool.spares += spares
        const leadSpares = pool.lead.deployed * pool.lead.ratio
        if (spares > leadSpares || (spares === leadSpares && share.agreementId < pool.lead.agreementId)) pool.lead = share
    }
    return [...byModel].map(([modelId, pool]) => ({ modelId, size: Math.max(0, Math.ceil(pool.spares - 1e-9)), agreementId: pool.lead.agreementId }))
}

/** Spares a Spare pool of `size` still needs, holding `reserved` (`reservedSparesQuery`). */
export function sparePoolShortfall(size: number, reserved: number): number {
    return Math.max(0, size - reserved)
}

/**
 * The Agreement whose row of the top-up's pass tops up its Customer's Spare pools (the first by sys_id of their
 * Agreements the top-up runs over), so each pool is topped up once a pass however many Agreements share it; '' for none.
 */
export function sparePoolLead(agreementIds: readonly string[]): string {
    return agreementIds.reduce((first, id) => (first === '' || id < first ? id : first), '')
}
