import { addDays, addMonths, daysBetween } from './calendar'

/** Billing periods: daily proration of Subscription lines and Fee events (P3.25, D52, D66). */

export interface MonthBounds {
    /** YYYY-MM */
    month: string
    first: string
    last: string
    days: number
}

/** A calendar month as YYYY-MM (what monthBounds takes). */
export function isMonth(value: string): boolean {
    return /^\d{4}-(0[1-9]|1[0-2])$/.test(value)
}

/** The first and last day and the length of a YYYY-MM month; throws for any other value. */
export function monthBounds(month: string): MonthBounds {
    if (!isMonth(month)) throw new Error(`'${month}' is not a YYYY-MM month`)
    const first = `${month}-01`
    const next = addMonths(first, 1)
    return { month, first, last: addDays(next, -1), days: daysBetween(first, next) }
}

/**
 * An encoded query for records whose date range (end blank = still open) overlaps the month.
 * The ^OR binds to the end-date clause only: start <= last AND (end empty OR end >= first).
 */
export function overlapsMonth(bounds: MonthBounds): string {
    return `start_date<=${bounds.last}^end_dateISEMPTY^ORend_date>=${bounds.first}`
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

/** The days one Asset (or `count` Assets) delivered a Subscription line at a Site (end inclusive; none while still in service). */
export interface ServiceInterval {
    siteId: string
    start: string
    end?: string
    /** Assets that share this Site and these dates (default 1). */
    count?: number
}

/** The last day (inclusive) of a Service interval that started on `start` and is closed on `closedOn`: never before it started. */
export function intervalEnd(start: string, closedOn: string): string {
    return closedOn < start ? start : closedOn
}

/** Where an Asset delivers (or delivered) a Subscription line. */
export interface IntervalPlace {
    lineId: string
    siteId: string
}

/**
 * How billing restarts on `start` at `place` for an Asset whose latest closed Service interval is
 * `latest` (end inclusive): one at the same place that ends on or after `start` is reopened, so no day
 * is billed twice; one elsewhere makes the new interval start the day after it ends; otherwise it starts on `start`.
 */
export function restartInterval(latest: (IntervalPlace & { end: string }) | null, place: IntervalPlace, start: string): { reopen: true } | { start: string } {
    if (!latest || latest.end < start) return { start }
    return latest.lineId === place.lineId && latest.siteId === place.siteId ? { reopen: true } : { start: addDays(latest.end, 1) }
}

/** What a Subscription line is billed by, as stored on it. */
export interface SubscriptionLineTerms {
    /** As stored. 'site_package' bills its own dates, 'device_class' its Service intervals; any other value bills nothing. */
    lineType: string
    monthlyRate: number
    /** The package's Site ('' on a per-device line). */
    siteId: string
    /** The Subscription line's own description. */
    description: string
    start?: string
    end?: string
}

/** Whether a Subscription line is billed from its Service intervals (a per-device line). */
export function billsFromIntervals(line: SubscriptionLineTerms): boolean {
    return line.lineType === 'device_class'
}

/** What one Subscription line bills at one Site for the month: the content of its Billing line. */
export interface Charge {
    siteId: string
    /** '<line description> - <Site name>', or just the line description when the Site has no name. */
    description: string
    /** Days for a site package; device-days for a per-device line. */
    units: number
    amount: number
}

/** What a charge is drafted from beyond the line itself, used only when the line's type needs it. */
export interface ChargeSources {
    /** The line's Service intervals overlapping the month: billed only for a line billsFromIntervals accepts, so any other line can pass none. */
    intervals: readonly ServiceInterval[]
    /** A Site's name; '' for '' or an unknown Site. */
    siteName(siteId: string): string
}

/**
 * The charges (one per Site) a Subscription line produces for the month: a site package by its own
 * active days, a per-device line by the device-days its Assets were in service, per Site.
 */
export function subscriptionCharges(line: SubscriptionLineTerms, bounds: MonthBounds, sources: ChargeSources): Charge[] {
    return [...unitsBySite(line, bounds, sources)].map(([siteId, units]) => {
        const name = sources.siteName(siteId)
        return {
            siteId,
            description: name ? `${line.description} - ${name}` : line.description,
            units,
            amount: prorate(line.monthlyRate, units, bounds.days),
        }
    })
}

/** The units the line bills per Site, in order of first appearance; Sites with none are left out. */
function unitsBySite(line: SubscriptionLineTerms, bounds: MonthBounds, sources: ChargeSources): Map<string, number> {
    const bySite = new Map<string, number>()
    if (line.lineType === 'site_package') {
        const units = line.start ? activeDays(bounds, line.start, line.end) : 0
        if (units > 0) bySite.set(line.siteId, units)
    } else if (billsFromIntervals(line)) {
        for (const interval of sources.intervals) {
            const units = activeDays(bounds, interval.start, interval.end) * (interval.count ?? 1)
            if (units > 0) bySite.set(interval.siteId, (bySite.get(interval.siteId) ?? 0) + units)
        }
    }
    return bySite
}

/** RFC 4180 CSV: fields with commas, quotes or line breaks are quoted, quotes doubled. */
export function toCsv(rows: ReadonlyArray<ReadonlyArray<string | number>>): string {
    return rows.map((row) => row.map((value) => csvField(String(value))).join(',')).join('\r\n') + '\r\n'
}

function csvField(value: string): string {
    return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}
