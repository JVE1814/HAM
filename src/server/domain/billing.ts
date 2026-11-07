import { addDays, addMonths, daysBetween } from './calendar'

/** Billing periods: daily proration of Subscription lines and Fee events (P3.25, D52, D66). */

export interface MonthBounds {
    /** YYYY-MM */
    month: string
    first: string
    last: string
    days: number
}

export function monthBounds(month: string): MonthBounds {
    const first = `${month}-01`
    const next = addMonths(first, 1)
    return { month, first, last: addDays(next, -1), days: daysBetween(first, next) }
}

/**
 * An encoded query for records whose date range (end blank = still open) overlaps the month.
 * The ^OR binds to the end-date clause only: start <= last AND (end empty OR end >= first).
 */
export function overlapsMonth(bounds: MonthBounds, startField = 'start_date', endField = 'end_date'): string {
    return `${startField}<=${bounds.last}^${endField}ISEMPTY^OR${endField}>=${bounds.first}`
}

/** The calendar month before the one `today` falls in. */
export function previousMonth(today: string): string {
    return addMonths(`${today.slice(0, 7)}-01`, -1).slice(0, 7)
}

/** Days from `from` to `to` (both inclusive; open-ended without `to`) that fall in the month. */
export function activeDays(bounds: MonthBounds, from: string, to?: string): number {
    if (!from) return 0
    const start = from > bounds.first ? from : bounds.first
    const end = to && to < bounds.last ? to : bounds.last
    return end < start ? 0 : daysBetween(start, end) + 1
}

/** A monthly rate charged for `units` days (or device-days) of a month, to the cent. */
export function prorate(monthlyRate: number, units: number, daysInMonth: number): number {
    return Math.round((monthlyRate * units * 100) / daysInMonth) / 100
}

/** The days one Asset delivered a Subscription line at a Site (end inclusive; none while still in service). */
export interface ServiceInterval {
    siteId: string
    start: string
    end?: string
}

export interface SubscriptionLineTerms {
    lineType: 'site_package' | 'device_class'
    monthlyRate: number
    siteId: string
    start?: string
    end?: string
}

export interface Charge {
    siteId: string
    /** Days for a site package; device-days for a per-device line. */
    units: number
    amount: number
}

/**
 * What a Subscription line costs for a month: a site package by its own active days, a per-device
 * line by the device-days its Assets were in service, per Site.
 */
export function subscriptionCharges(line: SubscriptionLineTerms, intervals: readonly ServiceInterval[], bounds: MonthBounds): Charge[] {
    if (line.lineType === 'site_package') {
        const units = line.start ? activeDays(bounds, line.start, line.end) : 0
        return units > 0 ? [{ siteId: line.siteId, units, amount: prorate(line.monthlyRate, units, bounds.days) }] : []
    }
    const unitsBySite = new Map<string, number>()
    for (const interval of intervals) {
        const units = activeDays(bounds, interval.start, interval.end)
        if (units > 0) unitsBySite.set(interval.siteId, (unitsBySite.get(interval.siteId) ?? 0) + units)
    }
    return [...unitsBySite].map(([siteId, units]) => ({ siteId, units, amount: prorate(line.monthlyRate, units, bounds.days) }))
}

/** RFC 4180 CSV: fields with commas, quotes or line breaks are quoted, quotes doubled. */
export function toCsv(rows: ReadonlyArray<ReadonlyArray<string | number>>): string {
    return rows.map((row) => row.map((value) => csvField(String(value))).join(',')).join('\r\n') + '\r\n'
}

function csvField(value: string): string {
    return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}
