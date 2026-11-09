import { OPEN_LINE_STAGES } from './entitlement.ts'
import type { LineStage } from './fulfilment.ts'
import type { LeaseEndAction } from './leases.ts'
import { fleetStagesQuery, naasStockroomCondition, STOCKROOM_TYPE_FIELD } from './fleet.ts'
import type { Stage } from './lifecycle.ts'
import type { ShortfallRoute } from './returns.ts'

/**
 * Sourcing: where an Order line's Assets come from.
 *
 * New installs: the Customer's Spare pool, then central stock, then purchase (the spare-pool top-up
 * job refills the pool afterwards). Replacements: the hot spare in a customer-site stockroom at the
 * Order's Site first, then the Spare pool, then central stock, then purchase.
 */

export type StockroomType = 'central_depot' | 'staging_centre' | 'customer_site'
export type Source = 'customer_site_stock' | 'spare_pool' | 'central_stock'

export interface StockCandidate {
    assetId: string
    modelId: string
    stage: 'available' | 'spare_pool'
    stockroomId: string
    stockroomType: StockroomType
    /** Customer the Asset is reserved for (spare pool) or whose site stockroom holds it; '' if free stock. */
    reservedFor: string
    /** The Site a customer-site stockroom stands at; '' for the Provider's own stockrooms. */
    siteId: string
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

/** Who stock is sought for: a line's Customer and Site, or no one (customerId '') for free stock only. */
type Seeker = Pick<SourcingRequest, 'customerId' | 'siteId'>

function sourceOf(candidate: StockCandidate, seeker: Seeker): Source | null {
    if (candidate.stockroomType === 'customer_site') {
        // A spare at another of the Customer's Sites is not shipped from there: it is no hot spare for this Site.
        const here = candidate.reservedFor === seeker.customerId && candidate.siteId === seeker.siteId
        return here ? 'customer_site_stock' : null
    }
    if (candidate.stage === 'spare_pool') return candidate.reservedFor === seeker.customerId ? 'spare_pool' : null
    return candidate.reservedFor === '' ? 'central_stock' : null
}

const PRIORITY: Record<SourcingRequest['purpose'], readonly Source[]> = {
    new: ['spare_pool', 'central_stock'],
    replace: ['customer_site_stock', 'spare_pool', 'central_stock'],
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

/**
 * Encoded alm_hardware queries for the stock that may serve `scope`, one per Source in priority order, so a limit on
 * each cuts within its Source only and other Customers' spares never crowd it out: the Customer's site stockroom
 * stock at the Site or one of its Rooms (replacements), its Spare pool, and free stock in the Provider's NaaS
 * stockrooms (central depots and staging centres). Only fleet assets in NaaS stockrooms are stock (ADR 0016): every
 * clause carries the Fleet flag, and stock in a stockroom with no NaaS stockroom type, or in none, is the Provider
 * IT's. Stock on an Order line or bound for its Lessor (`isClaimable`) is never a candidate. `sourceOf` still decides
 * each one.
 */
export function stockQueries(scope: StockScope): string[] {
    const base = `model=${scope.modelId}^x_daas_ham_order_lineISEMPTY^${NOT_LESSOR_BOUND}`
    const type = `stockroom.${STOCKROOM_TYPE_FIELD}`
    // A NaaS stockroom type rules out a blank one, so != needs no ISEMPTY beside it.
    const provider = `${base}^${naasStockroomCondition('stockroom.')}^${type}!=customer_site`
    const customerSite = `${base}^${type}=customer_site^stockroom.x_daas_ham_customer=${scope.customerId}`
    const atSite = `stockroom.location=${scope.siteId}^ORstockroom.location.parent=${scope.siteId}`
    const bySource: Record<Source, string> = {
        customer_site_stock: fleetStagesQuery(['available', 'spare_pool'], `${customerSite}^${atSite}`),
        spare_pool: fleetStagesQuery(['spare_pool'], `${provider}^company=${scope.customerId}`),
        central_stock: fleetStagesQuery(['available'], provider),
    }
    const sources: readonly Source[] = scope.customerId ? PRIORITY[scope.purpose] : ['central_stock']
    return sources.map((source) => bySource[source])
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
            .filter((c) => c.modelId === request.modelId && sourceOf(c, request) === source)
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

/** Order stages in which nothing is sourced, even for a line a refused save left open. */
const ENDED_ORDER_STAGES: readonly string[] = ['cancelled', 'rejected']

/** Whether an Order line still waits to be filled: not shipped or cancelled, its Order not cancelled or rejected. */
export function lineStillOpen(line: { lineStage: string; orderStage: string }): boolean {
    return OPEN_LINE_STAGES.includes(line.lineStage as LineStage) && !ENDED_ORDER_STAGES.includes(line.orderStage)
}

/** The states of an OEM RMA (x_daas_ham_oem_rma.state). */
export type RmaState = 'to_open' | 'open' | 'replacement_received' | 'defective_returned' | 'closed'

/** RMAs whose replacement is still to come: their line counts each as a unit on its way. */
export const RMA_AWAITED: readonly RmaState[] = ['to_open', 'open']

/** RMAs still open, the defective unit not yet back with the OEM (as the workspace's Open OEM RMAs list them). */
export const RMA_OPEN: readonly RmaState[] = ['to_open', 'open', 'replacement_received']

/** An RMA for the Asset a break-fix line replaces, as `advanceReplacementRma` weighs it. */
export interface OpenRma {
    rmaId: string
    rmaNumber: string
    state: RmaState
    /** The Order line it serves; '' for none. */
    lineId: string
    /** Whether that line still waits to be filled (`lineStillOpen`); false for none. */
    lineOpen: boolean
}

/** An open RMA a line's advance replacement goes under, and the state it is saved in. */
export interface RmaReuse {
    rma: OpenRma
    state: RmaState
    /** Its replacement was received (then lost in transit or failed staging): the vendor is asked for another. */
    askAgain: boolean
}

/**
 * Whether a break-fix line whose shortfall goes to an OEM advance replacement reuses an RMA already open for the unit
 * it replaces, or (null) opens one: the OEM is not asked twice for one defective unit. Reused, the RMA serves the line
 * and its replacement is awaited, so the line waits for it; one whose replacement was received goes back to open. The
 * line's own RMA comes first, then one still awaited, then the first given (`rmas` oldest first). One that another
 * open line waits for is that line's.
 */
export function advanceReplacementRma(lineId: string, rmas: readonly OpenRma[]): RmaReuse | null {
    const rank = (rma: OpenRma) => (rma.lineId === lineId ? 0 : 2) + (RMA_AWAITED.includes(rma.state) ? 0 : 1)
    // A scan, not a sort: the platform's Array sort need not keep equals in the order given.
    let best: OpenRma | null = null
    for (const rma of rmas) {
        const reusable = RMA_OPEN.includes(rma.state) && (rma.lineId === lineId || !rma.lineOpen)
        if (reusable && (!best || rank(rma) < rank(best))) best = rma
    }
    if (!best) return null
    const askAgain = !RMA_AWAITED.includes(best.state)
    return { rma: best, state: askAgain ? 'open' : best.state, askAgain }
}

/**
 * The job lock (ADR 0013) an Order's sourcing passes take turns under, so two never count the same shortfall, and that
 * Cancel order holds, so a pass never reserves or buys for lines being cancelled.
 */
export function sourcingLockName(orderId: string): string {
    return `source_order_${orderId}`
}

/**
 * The job lock (ADR 0013) an Order line's need is read and changed under: sourcing reads its units and on-order count
 * there and saves what it bought, and a receipt takes its unit off order and allocates it. So neither change is lost,
 * and sourcing's count never sees half a receipt.
 */
export function orderLineLockName(lineId: string): string {
    return `order_line_${lineId}`
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

/** Spares a Customer still needs to reach `ratio` × deployed Assets. */
export function sparePoolShortfall(input: { deployed: number; reserved: number; ratio: number }): number {
    return Math.max(0, Math.ceil(input.deployed * input.ratio - 1e-9) - input.reserved)
}

/** Free central stock of a model to move into a Customer's Spare pool (top-up). */
export function pickForSparePool(stock: readonly StockCandidate[], modelId: string, count: number): string[] {
    return stock
        .filter((c) => c.modelId === modelId && sourceOf(c, freeStockOf(modelId)) === 'central_stock')
        .sort((a, b) => a.stockroomId.localeCompare(b.stockroomId) || a.assetId.localeCompare(b.assetId))
        .slice(0, Math.max(0, count))
        .map((c) => c.assetId)
}
