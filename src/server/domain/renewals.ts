import { addMonths, endOfMonth, isMonthEnd } from './calendar.ts'

/** Agreement renewals (plan §13 Renewals): the end a renewal moves an Agreement to, and what a moved end means for its recovery. */

/**
 * The Agreement's end after renewing it for `termMonths`. A term ending on a month end renews to a month end
 * (28 Feb + 3 months is 31 May, not 28 May), so a day clamped in a short month is not lost for good.
 */
export function renewedEnd(currentEnd: string, termMonths: number): string {
    const renewed = addMonths(currentEnd, Math.max(1, termMonths))
    return isMonthEnd(currentEnd) ? endOfMonth(renewed) : renewed
}

/**
 * Whether an Agreement whose end date changed to `ends` has its equipment recovered again at that end: one that ends
 * today or later has not ended, so its agreement-end Return is raised (again) once the day has passed. One moved to a
 * past day ended before, and what was installed then has been recovered.
 */
export function recoversAgainAt(ends: string, today: string): boolean {
    return ends >= today
}
