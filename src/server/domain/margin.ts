import { activeDays, monthBounds, type MonthBounds } from './billing.ts'
import { addDays, addMonths } from './calendar.ts'
import { evenShare } from './leases.ts'
import type { LegalOwner } from './lifecycle.ts'

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
    /** Assets it covered when a buyout was decided (0 without one). */
    buyoutAssets: number
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
 * Provider-owned Assets carry their purchase write-off from its start (no earlier than the purchase,
 * e.g. a lease buyout) through its last day; leased ones their share of the lease payment while the
 * lease runs; customer-owned ones neither. Any Asset carries the OEM support the Provider pays for it.
 * Costs follow the Asset as it is now: a month recomputed after a buyout is costed as provider-owned.
 */
export function serviceIntervalCosts(
    interval: { start: string; end?: string },
    asset: AssetCostFacts,
    bounds: MonthBounds,
    amortisationMonths: number,
): Array<Pick<CostEntry, 'type' | 'amount'>> {
    const share = activeDays(bounds, interval.start, interval.end) / bounds.days
    const costs: Array<Pick<CostEntry, 'type' | 'amount'>> = []
    const owner = asset.legalOwner || 'provider'
    if (owner === 'provider' && asset.purchaseCost > 0 && amortisationMonths > 0) {
        const writeOff = writeOffShare(interval, writeOffStart(asset), bounds, amortisationMonths)
        const monthly = asset.purchaseCost / amortisationMonths
        if (writeOff !== null) costs.push({ type: 'purchase', amount: monthly * writeOff })
    }
    if (owner === 'lessor' && asset.lease && leaseRunsIn(asset.lease, bounds)) {
        const monthly = leaseShare(asset.lease)
        if (monthly > 0) costs.push({ type: 'lease', amount: monthly * share })
    }
    if (asset.supportAnnual > 0) costs.push({ type: 'oem_support', amount: (asset.supportAnnual / 12) * share })
    return costs
}

/** The day the write-off starts: the purchase date, else the day first in service ('' when unknown). */
function writeOffStart(asset: AssetCostFacts): string {
    return asset.purchaseDate.slice(0, 10) || asset.inServiceDate.slice(0, 10)
}

/**
 * The share of a monthly write-off the interval carries in the month, counted from the write-off start through
 * its last day (null once it is complete; an unknown start keeps it running). One that starts mid-month ends
 * mid-month `amortisationMonths` later, and that last month carries what the first month left of a monthly
 * write-off: an Asset in service throughout is written off exactly its cost, whatever the two months' lengths.
 */
function writeOffShare(
    interval: { start: string; end?: string },
    start: string,
    bounds: MonthBounds,
    amortisationMonths: number,
): number | null {
    if (!start) return activeDays(bounds, interval.start, interval.end) / bounds.days
    const last = addDays(addMonths(start, amortisationMonths), -1)
    if (last < bounds.first) return null
    const from = start > interval.start ? start : interval.start
    const days = activeDays(bounds, from, interval.end && interval.end < last ? interval.end : last)
    if (last >= bounds.last) return days / bounds.days
    const first = monthBounds(start.slice(0, 7))
    const leftByFirstMonth = (first.days - activeDays(first, start)) / first.days
    return leftByFirstMonth * (days / activeDays(bounds, bounds.first, last))
}

/**
 * Each Asset's share of a lease's monthly payment: split evenly over the Assets it covers. While a
 * buyout transfer runs, Assets leave the schedule one by one, so the payment keeps being split over
 * the Assets it covered when the buyout was decided.
 */
export function leaseShare(lease: Pick<LeaseTerms, 'monthlyPayment' | 'coveredAssets' | 'buyoutAssets'>): number {
    return evenShare(lease.monthlyPayment, Math.max(lease.coveredAssets, lease.buyoutAssets))
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

/** Which Cost fact an amount belongs to: one per Customer, Site and cost type in a period. */
export function costFactKey(customerId: string, siteId: string, type: string): string {
    return `${marginKey(customerId, siteId)}|${type}`
}

/** Running totals of cost per Customer, Site and type, flushed to Cost facts in batches. */
export class CostLedger {
    private totals = new Map<string, CostEntry>()

    add(customerId: string, siteId: string, type: CostType, amount: number): void {
        if (!customerId || amount === 0) return
        const key = costFactKey(customerId, siteId, type)
        const total = this.totals.get(key)
        if (total) total.amount += amount
        else this.totals.set(key, { customerId, siteId, type, amount })
    }

    /** The totals so far by costFactKey, handed over: the ledger starts afresh, so later amounts leave them as they are. */
    drain(): Map<string, CostEntry> {
        const drained = this.totals
        this.totals = new Map()
        return drained
    }
}

/** Revenue or cost for a Customer and Site ('' for customer-level amounts such as fees). */
export interface Amount {
    customerId: string
    siteId: string
    amount: number
}

/** An amount of one cost type for a Customer and Site, as a Cost fact holds it. */
export interface CostEntry extends Amount {
    type: CostType
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
