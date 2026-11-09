import { addDays, addMonths, endOfMonth, isMonthEnd } from './calendar.ts'
import { inFleet } from './fleet.ts'
import { notRetiredCondition, type Stage } from './lifecycle.ts'
import type { LeaseEndAction } from './vocabulary.ts'

/** Lease schedules, end-of-lease decisions and renewals (P3.23–P3.24). */

/**
 * `leaseCondition` (an encoded query on the Asset's lease) narrowed to the fleet assets (ADR 0016) the lease still
 * covers. A retired unit (returned to the Lessor or the OEM, disposed of) keeps its lease as history, but is no longer
 * counted, bought out, transferred or paid for; a unit of the Provider IT's is none of the app's to count.
 */
export function stillCovered(leaseCondition: string): string {
    return inFleet(`${leaseCondition}^${notRetiredCondition()}`)
}

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

/** How long after its end an undecided lease is still reviewed: its mismatch flagged, a decision raised for it. */
const REVIEWED_DAYS_PAST_END = 30

/** The earliest end date of the undecided leases the daily review on `today` still looks at. */
export function earliestReviewedEnd(today: string): string {
    return addDays(today, -REVIEWED_DAYS_PAST_END)
}

export interface LeaseDecisionInput {
    decision: LeaseEndAction | ''
    /** The lease's end action now ('' is undecided). */
    endAction: LeaseEndAction | ''
    leaseEnd: string
    newEndDate: string
}

const DECIDED: Partial<Record<LeaseEndAction, string>> = {
    buyout: 'The lease is already being bought out',
    return: 'The lease is already being returned to the lessor',
}

/**
 * Why an end-of-lease decision cannot be applied, or null when it can. A lease takes one buy out or return: a second
 * decision would act on Assets the first already transferred, put on a disposal or set to be swapped out.
 */
export function leaseDecisionProblem(input: LeaseDecisionInput): string | null {
    const decided = input.endAction && DECIDED[input.endAction]
    if (decided) return decided
    if (!input.decision || input.decision === 'undecided') return 'Choose buy out, extend or return'
    if (input.decision === 'extend' && !(input.newEndDate > input.leaseEnd)) return 'An extension needs a new end date after the current lease end'
    return null
}

/** What an applied end-of-lease decision writes on its lease; a field left out keeps its value. */
export interface DecidedLease {
    endAction: LeaseEndAction
    ends?: string
    mismatch?: false
}

/**
 * The lease after `decision` (one `leaseDecisionProblem` lets through) is applied. A buy out or a return is the
 * lease's end action from then on. An extension moves its end to `newEndDate` and leaves it undecided, so a new
 * decision comes due before the new end, with its mismatch to be judged again against that end by the daily review.
 */
export function decidedLease(decision: LeaseEndAction, newEndDate: string): DecidedLease {
    if (decision === 'extend') return { endAction: 'undecided', ends: newEndDate, mismatch: false }
    return { endAction: decision }
}

/**
 * The buyout's terms to fix on a lease as `decision` is applied, or null when it fixes none: how many Assets it covers
 * (`covered`) and what each costs, its even share of `price`. They are fixed once, while every Asset is still covered
 * (`fixedAssets` is 0 until then): Margin keeps splitting the lease payment over that many while the transfer runs.
 */
export function buyoutTerms(
    decision: LeaseEndAction,
    lease: { fixedAssets: number; price: number },
    covered: () => number,
): { assets: number; share: number } | null {
    if (decision !== 'buyout' || lease.fixedAssets) return null
    const assets = covered()
    return { assets, share: evenShare(lease.price, assets) }
}

/**
 * Whether an Agreement whose end date changed to `ends` has its equipment recovered again at that end: one that ends
 * today or later has not ended, so its agreement-end Return is raised (again) once the day has passed. One moved to a
 * past day ended before, and what was installed then has been recovered.
 */
export function recoversAgainAt(ends: string, today: string): boolean {
    return ends >= today
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

/**
 * The Agreement's end after renewing it for `termMonths`. A term ending on a month end renews to a month end
 * (28 Feb + 3 months is 31 May, not 28 May), so a day clamped in a short month is not lost for good.
 */
export function renewedEnd(currentEnd: string, termMonths: number): string {
    const renewed = addMonths(currentEnd, Math.max(1, termMonths))
    return isMonthEnd(currentEnd) ? endOfMonth(renewed) : renewed
}

/**
 * The moves, one save each, that take a returned lease's stock out of circulation: to pending wipe, where its
 * return-to-lessor disposal starts and sourcing and the spare-pool top-up no longer find it. Spare-pool stock leaves
 * its pool through available (the lifecycle has no direct move); anything else is not stock and has none.
 */
export function stockReturnMoves(stage: Stage | null): readonly Stage[] {
    if (stage === 'available') return ['pending_wipe']
    if (stage === 'spare_pool') return ['available', 'pending_wipe']
    return []
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
