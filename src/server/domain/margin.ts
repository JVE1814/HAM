import { activeDays, type MonthBounds } from './billing'
import { addMonths } from './calendar'
import type { LegalOwner } from './lifecycle'

/** Cost facts and Margin per Customer and Site (P3.28, D72). */

export type CostType = 'purchase' | 'lease' | 'oem_support' | 'field_labour'

/** What an Asset's Lease schedule charges, as stored on it. */
export interface LeaseTerms {
    /** Lease schedule start and end, date or date-time; '' = open. */
    starts: string
    ends: string
    /** Monthly payment for every Asset on the schedule. */
    monthlyPayment: number
    /** Assets on the schedule today. */
    coveredAssets: number
}

/** What an Asset's costs are worked out from, as stored on it. */
export interface AssetCostFacts {
    /** As stored; '' counts as provider. */
    legalOwner: LegalOwner
    purchaseCost: number
    /** '' when unknown. */
    purchaseDate: string
    /** Date-time first in service ('' when unknown). The write-off starts here when there is no purchase date. */
    inServiceDate: string
    /** Annual cost of the OEM coverage contracts covering the Asset. */
    supportAnnual: number
    /** The Asset's Lease schedule; null when it has none or it was not found. */
    lease: LeaseTerms | null
}

/**
 * The costs one Asset carried over one Service interval, prorated by the interval's days in the month.
 * Provider-owned Assets carry their purchase write-off until it is complete; leased ones their share of
 * the lease payment while the lease runs; customer-owned ones neither. Any Asset carries the OEM support
 * the Provider pays for it.
 */
export function serviceIntervalCosts(
    interval: { start: string; end?: string },
    asset: AssetCostFacts,
    bounds: MonthBounds,
    amortisationMonths: number,
): Array<{ type: CostType; amount: number }> {
    const share = bounds.days > 0 ? activeDays(bounds, interval.start, interval.end) / bounds.days : 0
    const costs: Array<{ type: CostType; amount: number }> = []
    const owner = asset.legalOwner || 'provider'
    if (owner === 'provider' && asset.purchaseCost > 0 && amortisationMonths > 0 && !writtenOff(asset, bounds, amortisationMonths)) {
        costs.push({ type: 'purchase', amount: (asset.purchaseCost / amortisationMonths) * share })
    }
    if (owner === 'lessor' && asset.lease && leaseRunsIn(asset.lease, bounds)) {
        const monthly = leaseShare(asset.lease.monthlyPayment, asset.lease.coveredAssets)
        if (monthly > 0) costs.push({ type: 'lease', amount: monthly * share })
    }
    if (asset.supportAnnual > 0) costs.push({ type: 'oem_support', amount: (asset.supportAnnual / 12) * share })
    return costs
}

/** Whether the write-off (from the purchase date, else first in service) ended by the month; an unknown start = still running. */
function writtenOff(asset: AssetCostFacts, bounds: MonthBounds, amortisationMonths: number): boolean {
    const start = asset.purchaseDate || asset.inServiceDate.slice(0, 10)
    return !!start && addMonths(start, amortisationMonths) <= bounds.first
}

/** A lease's monthly payment split evenly over the Assets it covers. */
export function leaseShare(monthlyPayment: number, coveredAssets: number): number {
    return coveredAssets > 0 ? monthlyPayment / coveredAssets : 0
}

/** Whether the lease (either end open) is payable in the month. */
function leaseRunsIn(lease: LeaseTerms, bounds: MonthBounds): boolean {
    const starts = lease.starts.slice(0, 10)
    const ends = lease.ends.slice(0, 10)
    return (!starts || starts <= bounds.last) && (!ends || ends >= bounds.first)
}

/** Where a cost or revenue belongs: a Customer, and a Site ('' for customer-level amounts such as fees). */
function marginKey(customerId: string, siteId: string): string {
    return `${customerId}|${siteId}`
}

function splitMarginKey(key: string): { customerId: string; siteId: string } {
    const [customerId, siteId = ''] = key.split('|')
    return { customerId, siteId }
}

/** Running totals of cost per Customer, Site and type, flushed to Cost facts in batches. */
export class CostLedger {
    private readonly totals = new Map<string, number>()

    add(customerId: string, siteId: string, type: CostType, amount: number): void {
        if (!customerId || amount === 0) return
        const key = `${marginKey(customerId, siteId)}|${type}`
        this.totals.set(key, (this.totals.get(key) ?? 0) + amount)
    }

    /** The totals so far, emptying the ledger. */
    drain(): Array<{ customerId: string; siteId: string; type: CostType; amount: number }> {
        const entries = [...this.totals].map(([key, amount]) => {
            const [customerId, siteId, type] = key.split('|')
            return { customerId, siteId, type: type as CostType, amount }
        })
        this.totals.clear()
        return entries
    }
}

/** Revenue or cost for a Customer and Site ('' for customer-level amounts such as fees). */
export interface Amount {
    customerId: string
    siteId: string
    amount: number
}

export interface MarginRow {
    customerId: string
    siteId: string
    revenue: number
    cost: number
    margin: number
    /** Margin as a share of revenue, in percent; null without revenue. */
    marginPct: number | null
}

/** Rounded to the cent. */
export function cents(value: number): number {
    return Math.round(value * 100) / 100
}

/** Margin for every Customer/Site with revenue or cost; amounts for the same Customer and Site are summed. */
export function marginRows(revenue: Iterable<Amount>, cost: Iterable<Amount>): MarginRow[] {
    const revenues = sumByKey(revenue)
    const costs = sumByKey(cost)
    const keys = new Set([...revenues.keys(), ...costs.keys()])
    return [...keys].sort().map((key) => {
        const r = cents(revenues.get(key) ?? 0)
        const c = cents(costs.get(key) ?? 0)
        return {
            ...splitMarginKey(key),
            revenue: r,
            cost: c,
            margin: cents(r - c),
            marginPct: r !== 0 ? Math.round(((r - c) / r) * 1000) / 10 : null,
        }
    })
}

function sumByKey(amounts: Iterable<Amount>): Map<string, number> {
    const sums = new Map<string, number>()
    for (const { customerId, siteId, amount } of amounts) {
        const key = marginKey(customerId, siteId)
        sums.set(key, (sums.get(key) ?? 0) + amount)
    }
    return sums
}
