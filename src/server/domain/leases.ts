import { addDays, addMonths } from './calendar'
import type { LegalOwner } from './lifecycle'

/** Lease schedules, end-of-lease decisions and renewals (P3.23–P3.24). */

export type LeaseEndAction = 'undecided' | 'buyout' | 'extend' | 'return'

/** True once `today` is within `leadDays` of `endDate` (or past it). */
export function withinLead(endDate: string, today: string, leadDays: number): boolean {
    return !!endDate && today >= addDays(endDate, -Math.max(0, leadDays))
}

/**
 * A lease mismatches when it ends before the service its deployed Assets deliver: an Agreement end
 * after the lease end, or an Agreement with no end date (`''`), means the Provider would have to hand
 * equipment back while a Customer still pays for it.
 */
export function leaseMismatch(leaseEnd: string, serviceEnds: readonly string[]): boolean {
    if (!leaseEnd) return false
    return serviceEnds.some((end) => end === '' || end > leaseEnd)
}

export interface LeaseDecisionInput {
    decision: LeaseEndAction | ''
    leaseEnd: string
    newEndDate: string
}

/** Why an end-of-lease decision cannot be applied yet, or null when it can. */
export function leaseDecisionProblem(input: LeaseDecisionInput): string | null {
    if (!input.decision || input.decision === 'undecided') return 'Choose buy out, extend or return'
    if (input.decision === 'extend' && !(input.newEndDate > input.leaseEnd)) return 'An extension needs a new end date after the current lease end'
    return null
}

/** A buyout's terms, fixed on the lease once, when the decision is applied while every Asset is still covered. */
export interface BuyoutTerms {
    /** Assets covered at buyout: Margin keeps splitting the lease payment over that many while the transfer runs. */
    buyoutAssets: number
    /** Each Asset's share of the buyout price, its cost once bought out (0 without a price or Assets). */
    buyoutShare: number
}

/** The terms of buying out a lease that covers `coveredAssets` Assets: its buyout price split evenly over them. */
export function buyoutTerms(buyoutPrice: number, coveredAssets: number): BuyoutTerms {
    return { buyoutAssets: coveredAssets, buyoutShare: coveredAssets > 0 ? buyoutPrice / coveredAssets : 0 }
}

/** What a bought-out Asset becomes. */
export interface BoughtOutAsset {
    legalOwner: LegalOwner
    /** The Asset leaves its Lease schedule and its Lessor: both are cleared. */
    leaseId: ''
    lessorId: ''
    /**
     * When the buyout has a price: the Asset costs its share of it, bought on the buyout day (its
     * write-off for Margin starts then). Without one, the Asset keeps its cost and purchase date.
     */
    purchase?: { cost: number; date: string }
}

/** A bought-out Asset is Provider-owned, off the lease, and bought at its share of the buyout price on `buyoutDay`. */
export function boughtOutAsset(buyoutShare: number, buyoutDay: string): BoughtOutAsset {
    const transferred: BoughtOutAsset = { legalOwner: 'provider', leaseId: '', lessorId: '' }
    return buyoutShare > 0 ? { ...transferred, purchase: { cost: buyoutShare, date: buyoutDay } } : transferred
}

/** The Agreement's end after renewing it for `termMonths`. */
export function renewedEnd(currentEnd: string, termMonths: number): string {
    return addMonths(currentEnd, Math.max(1, termMonths))
}

export interface ExpiringCoverage {
    customerId: string
    endDate: string
}

/** Expiring coverage per Customer: how many contracts, and the first one to end. */
export function groupExpiringCoverage(rows: readonly ExpiringCoverage[]): Map<string, { count: number; firstEnd: string }> {
    const groups = new Map<string, { count: number; firstEnd: string }>()
    for (const row of rows) {
        const group = groups.get(row.customerId)
        if (!group) groups.set(row.customerId, { count: 1, firstEnd: row.endDate })
        else groups.set(row.customerId, { count: group.count + 1, firstEnd: row.endDate < group.firstEnd ? row.endDate : group.firstEnd })
    }
    return groups
}
