import { addDays, addMonths } from './calendar'

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

/** One share of `amount` split evenly over `count` Assets (0 without any): a lease payment's or a buyout price's. */
export function evenShare(amount: number, count: number): number {
    return count > 0 ? amount / count : 0
}

/**
 * The purchase to record on a bought-out Asset: when the buyout has a price, the Asset costs its share
 * of it (`buyoutShare`), bought on `buyoutDay` (its write-off for Margin starts then). Without one
 * there is none, and the Asset keeps its cost and purchase date.
 */
export function buyoutPurchase(buyoutShare: number, buyoutDay: string): { cost: number; date: string } | undefined {
    return buyoutShare > 0 ? { cost: buyoutShare, date: buyoutDay } : undefined
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
