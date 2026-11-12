import { byCandidateOrder, sourceQuery, type Source, type StockCandidate, type StockScope } from './stock.ts'
import { LINE_STAGE, type LineStage, type OrderType } from './vocabulary.ts'

/**
 * Sourcing an Order line: which Sources serve it and in what order (`PRIORITY`; the spare-pool top-up refills the pool
 * afterwards), what it still needs, and where its shortfall goes.
 */

export interface SourcingRequest extends StockScope {
    quantity: number
    purpose: 'new' | 'replace'
}

export interface SourcingPlan {
    picks: Array<{ assetId: string; source: Source }>
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

export interface LineNeed {
    quantity: number
    /** Assets on the line, in any stage. */
    allocated: number
    /** Units bought for it and not yet received (its On order count). */
    onOrder: number
    /** OEM advance replacements still to come for it (domain/oem-rma `RMA_AWAITED`). */
    awaitedRmas: number
}

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

export type SourcingScope = Omit<SourcingRequest, 'quantity'>

/**
 * Encoded alm_hardware queries for the stock that may serve `scope`, one per Source in priority order, so a limit on each cuts within its Source only and other Customers' spares never crowd it out.
 */
export function stockQueries(scope: SourcingScope): Array<{ source: Source; query: string }> {
    // A blank Customer would match every spare and site stock with no owner: an Order without one takes central stock.
    const sources: readonly Source[] = scope.customerId ? PRIORITY[scope.purpose] : ['central_stock']
    return sources.map((source) => ({ source, query: sourceQuery(source, scope) }))
}

const LABEL: Record<Source, string> = {
    customer_site_stock: 'from site stock',
    spare_pool: 'from spare pool',
    central_stock: 'from central stock',
}

/**
 * Which stock serves `request`, in its Sources' priority order, summarised with how many units are left to purchase
 * (the pass works out what it buys itself, as a pick may fail to reserve). A quantity below one, or not a whole number
 * of units, wants no more than its whole part: none takes no stock and buys nothing.
 */
export function planSourcing(request: SourcingRequest, stock: readonly StockCandidate[]): SourcingPlan {
    const wanted = Number.isFinite(request.quantity) ? Math.max(0, Math.floor(request.quantity)) : 0
    const picks: SourcingPlan['picks'] = []
    for (const source of PRIORITY[request.purpose]) {
        const matching = stock.filter((c) => c.source === source).sort(byCandidateOrder)
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
    return { picks, summary: parts.join(', ') }
}

export type PurchaseResult = { ok: true; poId: string } | { ok: false; reason: string }

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
