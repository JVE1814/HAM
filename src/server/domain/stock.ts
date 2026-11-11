import { fleetStagesQuery, providerStockroomCondition, STOCKROOM_TYPE_FIELD } from './fleet.ts'
import { STOCK_STAGES, type Stage } from './lifecycle.ts'
import { type LeaseEndAction, STOCKROOM_TYPE } from './vocabulary.ts'

export type Source = 'customer_site_stock' | 'spare_pool' | 'central_stock'

/** Stock that may serve a request, under the Source whose query found it (`sourceQuery`). */
export interface StockCandidate {
    assetId: string
    stockroomId: string
    source: Source
}

/** The alm_hardware fields candidates are read in order of, so a limit on a read cuts the same way each run. */
export const CANDIDATE_ORDER = ['stockroom', 'sys_id'] as const

/** Candidates as `CANDIDATE_ORDER` orders them. */
export function byCandidateOrder(a: StockCandidate, b: StockCandidate): number {
    return a.stockroomId.localeCompare(b.stockroomId) || a.assetId.localeCompare(b.assetId)
}

/** Who an Asset claimed for an Order line is held for (ADR 0006): its line, its Customer and its Agreement. */
export interface Reservation {
    orderLineId: string
    customerId: string
    agreementId: string
}

/** The alm_hardware values a claim for `reservation` saves; `stockQueries` and `reservedSparesQuery` read them. */
export function reservationValues(reservation: Reservation): Record<string, string> {
    return {
        x_daas_ham_order_line: reservation.orderLineId,
        company: reservation.customerId,
        x_daas_ham_agreement: reservation.agreementId,
    }
}

/** The end action of a lease whose units go back to its Lessor. */
const RETURNING: LeaseEndAction = 'return'

/** The alm_hardware path to a unit's lease end action, as `StockUnit.leaseEndAction` is read. */
export const LEASE_END_ACTION = 'x_daas_ham_lease.end_action'

/**
 * Stock not bound for its Lessor, as an encoded alm_hardware condition (`isClaimable` on a query). Not left to how !=
 * treats empty values: stock on no lease has no end action.
 */
export const NOT_LESSOR_BOUND = `${LEASE_END_ACTION}!=${RETURNING}^OR${LEASE_END_ACTION}ISEMPTY`

/** An in-stock Asset as a fresh read shows it, to decide whether it may still be claimed or withdrawn. */
export interface StockUnit {
    stage: Stage | null
    /** The Order line it is on; '' for none. */
    orderLineId: string
    /** Its lease's end action; '' without a lease. */
    leaseEndAction: LeaseEndAction | ''
}

/** In one of the `from` stages and on no Order line: nothing has taken it since it was found. */
export function isFree(unit: StockUnit, from: readonly Stage[]): boolean {
    return unit.stage !== null && from.includes(unit.stage) && !unit.orderLineId
}

/**
 * Free, and not bound for its Lessor (on a lease being returned). A returned lease's units can reach free stock after
 * the decision (a released reservation, a unit put back from pending wipe), so this check on the claim's fresh read is
 * the guard that holds; `sourceQuery` leaves them out too.
 */
export function isClaimable(unit: StockUnit, from: readonly Stage[]): boolean {
    return isFree(unit, from) && unit.leaseEndAction !== RETURNING
}

/** Who stock of a Model is sought for: a Customer, at the Site a hot spare is installed from. */
export interface StockScope {
    modelId: string
    customerId: string
    siteId: string
}

function onNoLine(modelId: string): string {
    return `model=${modelId}^x_daas_ham_order_lineISEMPTY^${NOT_LESSOR_BOUND}`
}

/** The Provider's free stock of `modelId` in its NaaS stockrooms (central depots and staging centres). */
export function freeStockQuery(modelId: string): string {
    return fleetStagesQuery(['available'], `${onNoLine(modelId)}^${providerStockroomCondition('stockroom.')}`)
}

/**
 * The stock of `source` that may serve `scope`, as an encoded alm_hardware query: the Customer's site stockroom stock
 * at the Site or one of its Rooms (a spare at another of its Sites is not shipped from there, so it is no hot spare
 * for this one), its Spare pool, or free stock in the Provider's NaaS stockrooms. Only fleet assets in NaaS stockrooms
 * are stock (ADR 0016): every clause carries the Fleet flag, and stock in a stockroom with no NaaS stockroom type, or
 * in none, is the Provider IT's. Stock on an Order line or bound for its Lessor (`isClaimable`) is never a candidate.
 * What a query finds is stock of its Source: nothing else says what a Source is.
 */
export function sourceQuery(source: Source, scope: StockScope): string {
    const base = onNoLine(scope.modelId)
    if (source === 'central_stock') return freeStockQuery(scope.modelId)
    if (source === 'spare_pool') return fleetStagesQuery(['spare_pool'], `${base}^${providerStockroomCondition('stockroom.')}^company=${scope.customerId}`)
    const customerSite = `${base}^stockroom.${STOCKROOM_TYPE_FIELD}=${STOCKROOM_TYPE.customer_site}^stockroom.x_daas_ham_customer=${scope.customerId}`
    return fleetStagesQuery(STOCK_STAGES, `${customerSite}^stockroom.location=${scope.siteId}^ORstockroom.location.parent=${scope.siteId}`)
}

/**
 * Where a unit taken off its Order line goes: whose it is then (`keeps`: still its Customer's, or the Provider's own
 * again, the inverse of a reservation, under no Agreement), and the stage it moves to (`to`; null keeps its stage).
 */
export interface LineExit {
    keeps: 'customer' | 'provider'
    to: Stage | null
}

/**
 * Where Cancel order sends a unit it takes off its line, by the stage the unit is in: a hot spare stays in its
 * Customer's Spare pool, only unlinked from the line; a unit in transfer is the Provider's again but stays in transfer
 * (domain/lifecycle `checkTransition`), free stock once Inventory lets it go; any other unit becomes free stock.
 */
export function cancelledUnit(stage: Stage | null): LineExit {
    if (stage === 'spare_pool') return { keeps: 'customer', to: null }
    return { keeps: 'provider', to: stage === 'in_transfer' ? null : 'available' }
}

/** Where stock reserved for a line but never moved to staging goes back to: the Spare pool it came from, else free stock. */
export function putBackUnit(source: Source): LineExit {
    return source === 'spare_pool' ? { keeps: 'customer', to: 'spare_pool' } : { keeps: 'provider', to: 'available' }
}
