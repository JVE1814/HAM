/** Calendar dates as ISO strings (YYYY-MM-DD, UTC); instants as epoch milliseconds. */

export const DAY_MS = 86_400_000

/** A real calendar date written as YYYY-MM-DD: impossible days such as 2026-02-31 are refused, not rolled over into the next month. */
export function isIsoDate(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
    const epoch = toEpoch(value)
    return !Number.isNaN(epoch) && toIsoDate(epoch) === value
}

function toEpoch(date: string): number {
    return Date.parse(`${date}T00:00:00Z`)
}

export function toIsoDate(epochMs: number): string {
    return new Date(epochMs).toISOString().slice(0, 10)
}

export function addDays(date: string, days: number): string {
    return toIsoDate(toEpoch(date) + days * DAY_MS)
}

export function addMonths(date: string, months: number): string {
    const [y, m, d] = date.split('-').map(Number)
    const monthIndex = m - 1 + months
    const year = y + Math.floor(monthIndex / 12)
    const month = ((monthIndex % 12) + 12) % 12
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
    return toIsoDate(Date.UTC(year, month, Math.min(d, lastDay)))
}

/** The last day of the month `date` falls in. */
export function endOfMonth(date: string): string {
    const [y, m] = date.split('-').map(Number)
    // Day 0 of the next month (m is 1-based, Date.UTC's month 0-based) is this month's last day.
    return toIsoDate(Date.UTC(y, m, 0))
}

export function isMonthEnd(date: string): boolean {
    return endOfMonth(date) === date
}

/** Whole days from `from` to `to` (exclusive of `to`). */
export function daysBetween(from: string, to: string): number {
    return Math.round((toEpoch(to) - toEpoch(from)) / DAY_MS)
}

/** True once `today` is within `leadDays` of `endDate` (or past it); never without an end date. */
export function withinLead(endDate: string, today: string, leadDays: number): boolean {
    return !!endDate && today >= addDays(endDate, -Math.max(0, leadDays))
}

export function earliest(dates: ReadonlyArray<string | undefined | null>): string | undefined {
    const present = dates.filter((d): d is string => !!d)
    return present.length === 0 ? undefined : present.reduce((a, b) => (a <= b ? a : b))
}
