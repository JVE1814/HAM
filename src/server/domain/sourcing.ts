/**
 * Sourcing: where an Order line's Assets come from.
 *
 * New installs: the Customer's Spare pool, then central stock, then purchase (the spare-pool top-up
 * job refills the pool afterwards). Replacements: the hot spare at a customer-site stockroom first,
 * then the Spare pool, then central stock, then purchase.
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
}

export interface SourcingRequest {
    modelId: string
    quantity: number
    customerId: string
    purpose: 'new' | 'replace'
}

export interface SourcingPlan {
    picks: Array<{ assetId: string; source: Source }>
    toPurchase: number
    summary: string
}

function sourceOf(candidate: StockCandidate, customerId: string): Source | null {
    if (candidate.stockroomType === 'customer_site') {
        return candidate.reservedFor === customerId ? 'customer_site_stock' : null
    }
    if (candidate.stage === 'spare_pool') return candidate.reservedFor === customerId ? 'spare_pool' : null
    return candidate.reservedFor === '' ? 'central_stock' : null
}

const PRIORITY: Record<SourcingRequest['purpose'], readonly Source[]> = {
    new: ['spare_pool', 'central_stock'],
    replace: ['customer_site_stock', 'spare_pool', 'central_stock'],
}

const LABEL: Record<Source, string> = {
    customer_site_stock: 'from site stock',
    spare_pool: 'from spare pool',
    central_stock: 'from central stock',
}

export function planSourcing(request: SourcingRequest, stock: readonly StockCandidate[]): SourcingPlan {
    const picks: SourcingPlan['picks'] = []
    for (const source of PRIORITY[request.purpose]) {
        const matching = stock
            .filter((c) => c.modelId === request.modelId && sourceOf(c, request.customerId) === source)
            .sort((a, b) => a.stockroomId.localeCompare(b.stockroomId) || a.assetId.localeCompare(b.assetId))
        for (const candidate of matching) {
            if (picks.length === request.quantity) break
            picks.push({ assetId: candidate.assetId, source })
        }
    }
    const toPurchase = request.quantity - picks.length
    const parts = (Object.keys(LABEL) as Source[])
        .filter((s) => PRIORITY[request.purpose].includes(s))
        .map((s) => [picks.filter((p) => p.source === s).length, LABEL[s]] as const)
        .filter(([count]) => count > 0)
        .map(([count, label]) => `${count} ${label}`)
    if (toPurchase > 0) parts.push(`${toPurchase} to purchase`)
    return { picks, toPurchase, summary: parts.join(', ') }
}

/** Spares a Customer still needs to reach `ratio` × deployed Assets. */
export function sparePoolShortfall(input: { deployed: number; reserved: number; ratio: number }): number {
    return Math.max(0, Math.ceil(input.deployed * input.ratio - 1e-9) - input.reserved)
}

/** Free central stock of a model to move into a Customer's Spare pool (top-up). */
export function pickForSparePool(stock: readonly StockCandidate[], modelId: string, count: number): string[] {
    return stock
        .filter((c) => c.modelId === modelId && sourceOf(c, '') === 'central_stock')
        .sort((a, b) => a.stockroomId.localeCompare(b.stockroomId) || a.assetId.localeCompare(b.assetId))
        .slice(0, Math.max(0, count))
        .map((c) => c.assetId)
}
