import { activeDays, divideRounded, fromCents, monthBounds, toCents, type MonthBounds } from './money.ts'
import { addDays, addMonths } from './calendar.ts'
import { evenShare } from './leases.ts'
import { legalOwnerOf } from './lifecycle.ts'
import type { CostType, LegalOwner } from './vocabulary.ts'

/**
 * Cost facts and Margin per Customer and Site (plan §13 Margin / TCO, Q72), each in one currency: costs take their Agreement's (a
 * shipment's, its carrier's), and amounts of two currencies are never added (domain/money `chooseCurrency`).
 */

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

export interface AssetCostFacts {
    /** As stored; '' counts as provider. */
    legalOwner: LegalOwner | ''
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
    const owner = legalOwnerOf(asset.legalOwner)
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
 * While a buyout transfer runs, Assets leave the schedule one by one, so the payment keeps being split over
 * the Assets it covered when the buyout was decided.
 */
export function leaseShare(lease: Pick<LeaseTerms, 'monthlyPayment' | 'coveredAssets' | 'buyoutAssets'>): number {
    return evenShare(lease.monthlyPayment, Math.max(lease.coveredAssets, lease.buyoutAssets))
}

function leaseRunsIn(lease: LeaseTerms, bounds: MonthBounds): boolean {
    const starts = lease.starts.slice(0, 10)
    const ends = lease.ends.slice(0, 10)
    return (!starts || starts <= bounds.last) && (!ends || ends >= bounds.first)
}

function marginKey(customerId: string, siteId: string, currency: string): string {
    return `${customerId}|${siteId}|${currency}`
}

export function costFactKey(customerId: string, siteId: string, type: string, currency: string): string {
    return `${marginKey(customerId, siteId, currency)}|${type}`
}

/** Running totals of cost per Customer, Site, type and currency, flushed to Cost facts in batches. */
export class CostLedger {
    private totals = new Map<string, CostEntry>()

    /** Add a cost (none without a Customer, or of 0); throws for one without a currency, which no Cost fact may hold. */
    add(entry: CostEntry): void {
        const { customerId, siteId, type, currency, amount } = entry
        if (!customerId || amount === 0) return
        if (!currency) throw new Error(`a ${type} cost has no currency`)
        const key = costFactKey(customerId, siteId, type, currency)
        const total = this.totals.get(key)
        if (total) total.amount += amount
        else this.totals.set(key, { customerId, siteId, type, currency, amount })
    }

    /** The totals so far by costFactKey, handed over: the ledger starts afresh, so later amounts leave them as they are. */
    drain(): Map<string, CostEntry> {
        const drained = this.totals
        this.totals = new Map()
        return drained
    }
}

/** Revenue or cost for a Customer and Site ('' for customer-level amounts such as fees), in one currency. */
export interface Amount {
    customerId: string
    siteId: string
    /** A three-letter code (domain/money `currencyCode`). */
    currency: string
    amount: number
}

export interface CostEntry extends Amount {
    type: CostType
}

interface MarginRow {
    customerId: string
    siteId: string
    currency: string
    revenue: number
    cost: number
    margin: number
    /** Margin as a share of revenue, in percent to one decimal; null without revenue. */
    marginPct: number | null
}

/**
 * Margin for every Customer, Site and currency with revenue or cost, sorted by them in that order; amounts for the same
 * three are summed, then rounded to the cent, and the margin is worked out in whole cents. Revenue in one currency is
 * never set against cost in another: a Customer and Site with amounts in two currencies get a row for each.
 */
export function marginRows(revenue: Iterable<Amount>, cost: Iterable<Amount>): MarginRow[] {
    const revenues = sumByKey(revenue)
    const costs = sumByKey(cost)
    const keys = [...new Map([...costs, ...revenues])].map(([key, { customerId, siteId, currency }]) => ({ key, customerId, siteId, currency }))
    keys.sort((a, b) => compare(a.customerId, b.customerId) || compare(a.siteId, b.siteId) || compare(a.currency, b.currency))
    return keys.map(({ key, ...where }) => {
        const r = toCents(revenues.get(key)?.amount ?? 0)
        const c = toCents(costs.get(key)?.amount ?? 0)
        return {
            ...where,
            revenue: fromCents(r),
            cost: fromCents(c),
            margin: fromCents(r - c),
            marginPct: r !== 0 ? divideRounded((r - c) * 1000, r) / 10 : null,
        }
    })
}

function compare(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0
}

function sumByKey(amounts: Iterable<Amount>): Map<string, Amount> {
    const sums = new Map<string, Amount>()
    for (const { customerId, siteId, currency, amount } of amounts) {
        const key = marginKey(customerId, siteId, currency)
        const sum = sums.get(key)
        if (sum) sum.amount += amount
        else sums.set(key, { customerId, siteId, currency, amount })
    }
    return sums
}

/** A work order's field labour cost: its own as stored (an explicit 0 included), or `visitCost` when it is blank. */
export function labourCost(stored: string, visitCost: number): number {
    if (stored.trim() === '') return visitCost
    const cost = Number(stored)
    return Number.isFinite(cost) ? cost : visitCost
}
