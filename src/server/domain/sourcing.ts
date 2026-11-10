import { endedUnfulfilled, OPEN_LINE_STAGES } from './fulfilment.ts'
import { fleetStagesQuery, providerStockroomCondition, STOCKROOM_TYPE_FIELD } from './fleet.ts'
import { STOCK_STAGES, type Stage } from './lifecycle.ts'
import {
    type LeaseEndAction,
    LINE_STAGE,
    type LineStage,
    type OrderType,
    STOCKROOM_TYPE,
} from './vocabulary.ts'

/**
 * Sourcing: where an Order line's Assets come from.
 *
 * New installs: the Customer's Spare pool, then central stock, then purchase (the spare-pool top-up
 * job refills the pool afterwards). Replacements: the hot spare in a customer-site stockroom at the
 * Order's Site first, then the Spare pool, then central stock, then purchase.
 */

export type Source = 'customer_site_stock' | 'spare_pool' | 'central_stock'

/** Stock that may serve a request, under the Source whose query found it (`stockQueries`). */
export interface StockCandidate {
    assetId: string
    modelId: string
    stockroomId: string
    source: Source
}

export interface SourcingRequest {
    modelId: string
    quantity: number
    customerId: string
    /** The Order's Site: a hot spare is installed from where it is, so only one there serves a replacement. */
    siteId: string
    purpose: 'new' | 'replace'
}

export interface SourcingPlan {
    picks: Array<{ assetId: string; source: Source }>
    toPurchase: number
    summary: string
}

const PRIORITY: Record<SourcingRequest['purpose'], readonly Source[]> = {
    new: ['spare_pool', 'central_stock'],
    replace: ['customer_site_stock', 'spare_pool', 'central_stock'],
}

/** What a line of an Order of this type is sourced for: a device replace takes the hot spare at its Site first. */
export function sourcingPurpose(orderType: OrderType | ''): SourcingRequest['purpose'] {
    return orderType === 'device_replace' ? 'replace' : 'new'
}

/**
 * How many candidates to read per Source for a shortfall: more than are needed, as a claim may find a candidate taken
 * since it was read, yet bounded, so a large stock is not read whole for a small need.
 */
export function candidateLimit(shortfall: number): number {
    return shortfall * 5 + 50
}

/** An Order line as sourcing counts it. */
export interface LineNeed {
    quantity: number
    /** Assets on the line, in any stage. */
    allocated: number
    /** Units bought for it and not yet received (its On order count). */
    onOrder: number
    /** OEM advance replacements still to come for it (domain/oem-rma `RMA_AWAITED`). */
    awaitedRmas: number
}

/** Units the line still needs: not allocated, on order or under an OEM RMA whose replacement is still to come. */
export function lineShortfall(line: LineNeed): number {
    return line.quantity - line.allocated - line.onOrder - line.awaitedRmas
}

/**
 * Units to buy when the line is saved: what the pass planned (`toPurchase`), less any need met since it read the line,
 * as when a receipt is allocated with nothing left on order to take it off. `shortfall` is read afresh at the save and
 * counts the stock the pass `putBack` (not bought). A need grown meanwhile is left to a later pass, which picks stock
 * before it buys.
 */
export function stillToBuy(toPurchase: number, shortfall: number, putBack: number): number {
    return Math.max(0, Math.min(toPurchase, shortfall - putBack))
}

/**
 * Whether stock picked in `fromStockroomId` needs a transfer order to the staging centre before it is staged: it sits
 * in another stockroom. Stock already there, or in no stockroom, is staged where it is, and so is all of it while no
 * staging centre is set.
 */
export function needsTransfer(fromStockroomId: string, stagingStockroomId: string): boolean {
    return !!stagingStockroomId && !!fromStockroomId && fromStockroomId !== stagingStockroomId
}

/** The Asset a break-fix line replaces, as sourcing weighs an OEM advance replacement for the line's shortfall. */
export interface ReplacedUnit {
    modelId: string
    /** The day its OEM coverage ends; '' with none. */
    coverageEnd: string
}

/** Where what a line still misses goes: nowhere (nothing is missing), to a purchase, or to the OEM for an advance replacement. */
export type ShortfallRoute = 'none' | 'purchase' | 'oem_advance_replacement'

/**
 * Where what a line of `modelId` still misses goes: a covered unit that fails with no stock left is replaced by the OEM
 * in advance, anything else is purchased. Only a break-fix line for the same Model as the unit it replaces, covered by
 * the OEM today, can be served by an advance replacement; pass `replaced` for a break-fix line only (null otherwise): a
 * refresh line also names the Asset it replaces, but that Asset is healthy.
 */
export function shortfallRouteFor(modelId: string, replaced: ReplacedUnit | null, today: string, missing: number): ShortfallRoute {
    if (missing <= 0) return 'none'
    const coveredToday = !!replaced && replaced.modelId === modelId && replaced.coverageEnd >= today
    return coveredToday ? 'oem_advance_replacement' : 'purchase'
}

/**
 * What Cancel order does with a unit it takes off its line, by the stage the unit is in:
 * - `stays_spare`: a hot spare stays in its Customer's Spare pool, only unlinked from the line;
 * - `stays_in_transfer`: a unit in transfer is the Provider's again but stays in transfer (domain/lifecycle
 *   `checkTransition`), free stock once Inventory lets it go;
 * - `free_stock`: any other unit becomes the Provider's free stock, available.
 */
export type CancelledUnit = 'stays_spare' | 'stays_in_transfer' | 'free_stock'

export function cancelledUnit(stage: Stage | null): CancelledUnit {
    if (stage === 'spare_pool') return 'stays_spare'
    return stage === 'in_transfer' ? 'stays_in_transfer' : 'free_stock'
}

/** What a sourcing run looks for: the line's request less its quantity; a customerId of '' wants free stock only. */
export type StockScope = Omit<SourcingRequest, 'quantity'>

/** Free stock of `modelId` sought for no Customer, as the spare-pool top-up moves into a pool. */
export function freeStockOf(modelId: string): StockScope {
    return { modelId, customerId: '', siteId: '', purpose: 'new' }
}

/** The end action of a lease whose units go back to its Lessor. */
const RETURNING: LeaseEndAction = 'return'

const LEASE_END = 'x_daas_ham_lease.end_action'

/**
 * Stock not bound for its Lessor, as an encoded alm_hardware condition (`isClaimable` on a query). Not left to how !=
 * treats empty values: stock on no lease has no end action.
 */
const NOT_LESSOR_BOUND = `${LEASE_END}!=${RETURNING}^OR${LEASE_END}ISEMPTY`

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
 * the guard that holds; `stockQueries` leaves them out too.
 */
export function isClaimable(unit: StockUnit, from: readonly Stage[]): boolean {
    return isFree(unit, from) && unit.leaseEndAction !== RETURNING
}

/** The stock of one Source that may serve a request, as an encoded alm_hardware query. */
export interface SourceQuery {
    source: Source
    query: string
}

/**
 * Encoded alm_hardware queries for the stock that may serve `scope`, one per Source in priority order, so a limit on
 * each cuts within its Source only and other Customers' spares never crowd it out: the Customer's site stockroom
 * stock at the Site or one of its Rooms (replacements; a spare at another of its Sites is not shipped from there, so
 * it is no hot spare for this one), its Spare pool, and free stock in the Provider's NaaS stockrooms (central depots
 * and staging centres). Only fleet assets in NaaS stockrooms are stock (ADR 0016): every clause carries the Fleet
 * flag, and stock in a stockroom with no NaaS stockroom type, or in none, is the Provider IT's. Stock on an Order line
 * or bound for its Lessor (`isClaimable`) is never a candidate. What a query finds is stock of its Source: nothing
 * else says what a Source is.
 */
export function stockQueries(scope: StockScope): SourceQuery[] {
    const base = `model=${scope.modelId}^x_daas_ham_order_lineISEMPTY^${NOT_LESSOR_BOUND}`
    const provider = `${base}^${providerStockroomCondition('stockroom.')}`
    const customerSite = `${base}^stockroom.${STOCKROOM_TYPE_FIELD}=${STOCKROOM_TYPE.customer_site}^stockroom.x_daas_ham_customer=${scope.customerId}`
    const atSite = `stockroom.location=${scope.siteId}^ORstockroom.location.parent=${scope.siteId}`
    const bySource: Record<Source, string> = {
        customer_site_stock: fleetStagesQuery(STOCK_STAGES, `${customerSite}^${atSite}`),
        spare_pool: fleetStagesQuery(['spare_pool'], `${provider}^company=${scope.customerId}`),
        central_stock: fleetStagesQuery(['available'], provider),
    }
    const sources: readonly Source[] = scope.customerId ? PRIORITY[scope.purpose] : ['central_stock']
    return sources.map((source) => ({ source, query: bySource[source] }))
}

const LABEL: Record<Source, string> = {
    customer_site_stock: 'from site stock',
    spare_pool: 'from spare pool',
    central_stock: 'from central stock',
}

/**
 * Which stock serves `request`, in its Sources' priority order, and how many units are left to purchase. A quantity
 * below one, or not a whole number of units, wants no more than its whole part: none takes no stock and buys nothing.
 */
export function planSourcing(request: SourcingRequest, stock: readonly StockCandidate[]): SourcingPlan {
    const wanted = Number.isFinite(request.quantity) ? Math.max(0, Math.floor(request.quantity)) : 0
    const picks: SourcingPlan['picks'] = []
    for (const source of PRIORITY[request.purpose]) {
        const matching = stock
            .filter((c) => c.modelId === request.modelId && c.source === source)
            .sort((a, b) => a.stockroomId.localeCompare(b.stockroomId) || a.assetId.localeCompare(b.assetId))
        for (const candidate of matching) {
            if (picks.length >= wanted) break
            picks.push({ assetId: candidate.assetId, source })
        }
    }
    const toPurchase = wanted - picks.length
    const parts = (Object.keys(LABEL) as Source[])
        .filter((s) => PRIORITY[request.purpose].includes(s))
        .map((s) => [picks.filter((p) => p.source === s).length, LABEL[s]] as const)
        .filter(([count]) => count > 0)
        .map(([count, label]) => `${count} ${label}`)
    if (toPurchase > 0) parts.push(`${toPurchase} to purchase`)
    return { picks, toPurchase, summary: parts.join(', ') }
}

/** What came of requesting a purchase: the purchase order created, or why there is none. */
export type PurchaseResult = { ok: true; poId: string } | { ok: false; reason: string }

/** What came of requesting a transfer order to the staging centre: the one created, or why there is none. */
export type TransferResult = { ok: true; transferId: string } | { ok: false; reason: string }

/** Picked stock left where it was, and no longer reserved, because no transfer order to the staging centre came of it. */
export interface UnmovedStock {
    units: number
    /** The Stockroom it stays in. */
    from: string
    reason: string
}

/** Where sourcing leaves an Order line. */
export interface ShortfallOutcome {
    stage: Extract<LineStage, 'sourced' | 'awaiting_stock'>
    summary: string
    /** The purchase order just created for the line, if any. */
    purchaseOrder?: string
    /**
     * Units just put on order for the line (0 without a new purchase order). They are added to its on-order count as it
     * stands when the line is saved, not as sourcing read it: receipts take units off it meanwhile.
     */
    purchased: number
}

/**
 * Where sourcing leaves an Order line once its shortfall is routed: sourced, unless the shortfall was
 * to be purchased and `purchase` (called only then) brings no purchase order, or picked stock could not
 * be moved to the staging centre (`unmoved`), when the line waits for stock and its summary says why; an
 * OEM advance replacement is noted in the summary. `missing` is the shortfall routed. Unmoved stock is
 * not part of `missing`: it is still there, so it is not bought, and the line picks it again when it is
 * next sourced.
 */
export function shortfallOutcome(
    route: ShortfallRoute,
    line: { planSummary: string; missing: number; unmoved?: readonly UnmovedStock[] },
    purchase: () => PurchaseResult,
): ShortfallOutcome {
    const outcome = routedOutcome(route, line, purchase)
    if (!line.unmoved?.length) return outcome
    const notes = line.unmoved.map((stock) => `no transfer order for ${stock.units} from ${stock.from}: ${stock.reason}`)
    return { ...outcome, stage: 'awaiting_stock', summary: `${outcome.summary} (${notes.join('; ')})` }
}

function routedOutcome(route: ShortfallRoute, line: { planSummary: string; missing: number }, purchase: () => PurchaseResult): ShortfallOutcome {
    const sourced = { stage: 'sourced', summary: line.planSummary, purchased: 0 } as const
    if (route === 'none') return sourced
    if (route === 'oem_advance_replacement') return { ...sourced, summary: `${line.planSummary} (OEM advance replacement under RMA)` }
    const bought = purchase()
    if (!bought.ok) return { ...sourced, stage: 'awaiting_stock', summary: `${line.planSummary} (no purchase order: ${bought.reason})` }
    return { ...sourced, purchaseOrder: bought.poId, purchased: line.missing }
}

/** The stages of the lines a sourcing pass sources: not sourced yet, or short of stock again. */
export const LINES_TO_SOURCE: readonly LineStage[] = [LINE_STAGE.new, LINE_STAGE.awaiting_stock]

/** Whether an Order line still waits to be filled: not shipped or cancelled, its Order not cancelled or rejected. */
export function lineStillOpen(line: { lineStage: string; orderStage: string }): boolean {
    return OPEN_LINE_STAGES.includes(line.lineStage as LineStage) && !endedUnfulfilled(line.orderStage)
}

/**
 * An encoded alm_hardware query for the Customer's Spare pool as the top-up counts it: its fleet assets (ADR 0016) in
 * the pool, and those of its spares on a transfer order line. In transfer and on no Order line, a unit held for the
 * Customer (its company) goes back to the pool once Inventory lets it go, received or not (domain/lifecycle
 * `stageAfterTransfer`, ADR 0002): it is still the Customer's spare, and left out the top-up would fill the pool again
 * meanwhile. One in transfer on an Order line is sourcing's, on its way to staging for that line, and no spare. Units
 * bound for their Lessor are left out: sourcing can no longer claim them (`isClaimable`), so counted they would keep
 * the pool short.
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

/** Free central stock of a model to move into a Customer's Spare pool (top-up). */
export function pickForSparePool(stock: readonly StockCandidate[], modelId: string, count: number): string[] {
    return stock
        .filter((c) => c.modelId === modelId && c.source === 'central_stock')
        .sort((a, b) => a.stockroomId.localeCompare(b.stockroomId) || a.assetId.localeCompare(b.assetId))
        .slice(0, Math.max(0, count))
        .map((c) => c.assetId)
}
