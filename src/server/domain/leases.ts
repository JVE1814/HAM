import { fromCents, toCents } from './money.ts'
import { addDays } from './calendar.ts'
import { inFleet } from './fleet.ts'
import { notRetiredCondition, type Stage } from './lifecycle.ts'
import type { LeaseEndAction } from './vocabulary.ts'

/** Lease schedules and end-of-lease decisions (plan §13 Leases). */

/**
 * `leaseCondition` (an encoded query on the Asset's lease) narrowed to the fleet assets (ADR 0016) the lease still
 * covers. A retired unit (returned to the Lessor or the OEM, disposed of) keeps its lease as history, but is no longer
 * counted, bought out, transferred or paid for; a unit of the Provider IT's is none of the app's to count.
 */
export function stillCovered(leaseCondition: string): string {
    return inFleet(`${leaseCondition}^${notRetiredCondition()}`)
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
 * (`covered`, their sys_ids) and what each costs, its share of `price` to the cent, the cents left over going one each
 * to the first Assets in sys_id order (`buyoutSplit`), so the costs add up to it. They are fixed once, while every
 * Asset is still covered (`fixedAssets` is 0 until then): Margin keeps splitting the lease payment over that many while
 * the transfer runs.
 */
export function buyoutTerms(
    decision: LeaseEndAction,
    lease: { fixedAssets: number; price: number },
    covered: () => readonly string[],
): ({ assets: number } & BuyoutSplit) | null {
    if (decision !== 'buyout' || lease.fixedAssets) return null
    const assetIds = covered()
    return { assets: assetIds.length, ...buyoutSplit(lease.price, assetIds) }
}

/**
 * One share of `amount` split evenly over `count` Assets (0 without any), unrounded: a lease payment's share for
 * Margin, whose costs are summed before they are rounded. An amount to be stored per Asset is split by `evenSplit`.
 */
export function evenShare(amount: number, count: number): number {
    return count > 0 ? amount / count : 0
}

/** An amount split to the cent over a number of Assets: each gets `share`, and the first `extra` of them one cent more. */
export interface EvenSplit {
    share: number
    extra: number
}

/**
 * `amount` split over `count` Assets to the cent by largest remainder (nothing without Assets or a positive amount):
 * the cents left over after an equal split go one each to the first Assets, so the shares add up to the amount
 * (10000.00 over 3 is 3333.34, 3333.33 and 3333.33).
 */
export function evenSplit(amount: number, count: number): EvenSplit {
    const total = toCents(amount)
    if (count <= 0 || total <= 0) return { share: 0, extra: 0 }
    const base = Math.floor(total / count)
    return { share: fromCents(base), extra: total - base * count }
}

/** A buyout price split over the Assets covered at buyout: each costs `share`, and those up to `extraThrough` one cent more. */
export interface BuyoutSplit {
    share: number
    /** The sys_id, in sys_id order, of the last Asset that costs one cent more ('' when none does). */
    extraThrough: string
}

/**
 * A buyout price split to the cent over the Assets it covers (`assetIds`, any order) by largest remainder, fixed once
 * when the buyout is decided: the left-over cents go to the first Assets in sys_id order, the order the buyout's
 * transfer runs in, so the Assets' costs add up to the price whichever chunk transfers each.
 */
export function buyoutSplit(price: number, assetIds: readonly string[]): BuyoutSplit {
    const sorted = [...new Set(assetIds)].sort()
    const split = evenSplit(price, sorted.length)
    return { share: split.share, extraThrough: split.extra > 0 ? sorted[split.extra - 1] : '' }
}

/**
 * What one Asset of a buyout costs (`buyoutSplit`), to the cent: its share, one cent more when its sys_id is up to
 * `extraThrough`. A share stored unrounded (a buyout decided before shares were split to the cent) is rounded too.
 */
export function buyoutCost(split: BuyoutSplit, assetId: string): number {
    const extra = split.extraThrough !== '' && assetId <= split.extraThrough
    return fromCents(toCents(split.share) + (extra ? 1 : 0))
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
 * The moves, one save each, that take a returned lease's stock out of circulation: to pending wipe, where its
 * return-to-lessor disposal starts and sourcing and the spare-pool top-up no longer find it. Spare-pool stock leaves
 * its pool through available (the lifecycle has no direct move); anything else is not stock and has none.
 */
export function stockReturnMoves(stage: Stage | null): readonly Stage[] {
    if (stage === 'available') return ['pending_wipe']
    if (stage === 'spare_pool') return ['available', 'pending_wipe']
    return []
}
