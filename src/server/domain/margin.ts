import type { LegalOwner } from './lifecycle'

/** Cost facts and Margin per Customer and Site (P3.28, D72). */

export type CostType = 'purchase' | 'lease' | 'oem_support' | 'field_labour'

export interface IntervalCostInput {
    /** Days the Asset served in the month, and the month's length. */
    days: number
    daysInMonth: number
    legalOwner: LegalOwner
    /** Purchase cost of the Asset, written off evenly over `amortisationMonths`. */
    purchaseCost: number
    amortisationMonths: number
    /** The Asset's share of its lease's monthly payment (0 when not leased). */
    leaseMonthly: number
    /** Annual cost of the OEM coverage contracts covering the Asset. */
    supportAnnual: number
}

/**
 * The costs one Asset carried for the days it served in a month. Provider-owned Assets carry their
 * purchase write-off; leased ones the lease payment; customer-owned ones neither. Any Asset carries
 * the OEM support the Provider pays for it.
 */
export function intervalCosts(input: IntervalCostInput): Array<{ type: CostType; amount: number }> {
    const share = input.daysInMonth > 0 ? Math.max(0, input.days) / input.daysInMonth : 0
    const costs: Array<{ type: CostType; amount: number }> = []
    if (input.legalOwner === 'provider' && input.purchaseCost > 0 && input.amortisationMonths > 0) {
        costs.push({ type: 'purchase', amount: (input.purchaseCost / input.amortisationMonths) * share })
    }
    if (input.legalOwner === 'lessor' && input.leaseMonthly > 0) costs.push({ type: 'lease', amount: input.leaseMonthly * share })
    if (input.supportAnnual > 0) costs.push({ type: 'oem_support', amount: (input.supportAnnual / 12) * share })
    return costs
}

/** A lease's monthly payment split evenly over the Assets it covers. */
export function leaseShare(monthlyPayment: number, coveredAssets: number): number {
    return coveredAssets > 0 ? monthlyPayment / coveredAssets : 0
}

/** Where a cost or revenue belongs: a Customer, and a Site ('' for customer-level amounts such as fees). */
export function marginKey(customerId: string, siteId: string): string {
    return `${customerId}|${siteId}`
}

export function splitMarginKey(key: string): { customerId: string; siteId: string } {
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

export interface MarginRow {
    customerId: string
    siteId: string
    revenue: number
    cost: number
    margin: number
    /** Margin as a share of revenue, in percent; null without revenue. */
    marginPct: number | null
}

const cents = (value: number) => Math.round(value * 100) / 100

/** Margin for every Customer/Site that had revenue or cost. */
export function marginRows(revenue: ReadonlyMap<string, number>, cost: ReadonlyMap<string, number>): MarginRow[] {
    const keys = new Set([...revenue.keys(), ...cost.keys()])
    return [...keys].sort().map((key) => {
        const r = cents(revenue.get(key) ?? 0)
        const c = cents(cost.get(key) ?? 0)
        return {
            ...splitMarginKey(key),
            revenue: r,
            cost: c,
            margin: cents(r - c),
            marginPct: r !== 0 ? Math.round(((r - c) / r) * 1000) / 10 : null,
        }
    })
}
