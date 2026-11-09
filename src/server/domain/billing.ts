import { addDays, addMonths, daysBetween } from './calendar.ts'
import { FLEET_CONDITION } from './fleet.ts'
import { STAGE_FIELDS, SUBSCRIPTION_LINE_STATUS } from './vocabulary.ts'

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

/**
 * Why a Billing period cannot be saved for `month` on `today`, or null. The month must be YYYY-MM and over: a new
 * period is generated at once, so one for a month still running would bill part of it, and the monthly job would
 * then skip that month.
 */
export function billingMonthProblem(month: string, today: string): string | null {
    if (!isMonth(month)) return `'${month}' is not a month: enter it as YYYY-MM (e.g. ${previousMonth(today)})`
    if (month < today.slice(0, 7)) return null
    const from = addMonths(`${month}-01`, 1)
    return `${month} has not ended yet: a period is generated as soon as it is created, so it can be created from ${from} (the monthly job opens it then)`
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
    /** The line's own dates, end inclusive: a site package bills them, a per-device line its intervals within them. */
    start?: string
    end?: string
}

/** Whether a Subscription line is billed from its Service intervals (a per-device line). */
export function billsFromIntervals(line: SubscriptionLineTerms): boolean {
    return line.lineType === 'device_class'
}

/** A range of days, end inclusive; no end means still open. */
export interface DayRange {
    start: string
    end?: string
}

/**
 * The days of a Service interval its per-device line bills: the interval cut to the line's own start and end date, so
 * a unit still in service after its line ended stops billing on the line's end date (the Billing integrity dashboard
 * flags it, IN_SERVICE_ON_ENDED_LINE; it is never moved to another line). Null when they do not overlap, and for a
 * line without a start date, which has not started (a site package without one bills nothing either).
 */
export function withinLine(interval: DayRange, line: Partial<DayRange>): DayRange | null {
    if (!line.start || !interval.start) return null
    const start = interval.start > line.start ? interval.start : line.start
    const end = !line.end || (interval.end && interval.end < line.end) ? interval.end : line.end
    return end !== undefined && end < start ? null : { start, end }
}

/** An Asset is on no Subscription line. */
export const NO_LINE = 'x_daas_ham_subscription_lineISEMPTY'

/**
 * Encoded query on alm_hardware for the Billing integrity dashboard: fleet assets in service on no Subscription line,
 * which nothing bills. `fleetStagesQuery(['in_service'], NO_LINE)` written out for the tile to import.
 */
export const IN_SERVICE_UNBILLED = `install_status=${STAGE_FIELDS.in_service.installStatus}^substatusISEMPTY^${NO_LINE}^${FLEET_CONDITION}`

/** An Asset's Subscription line has ended: set ended, or past its end date. */
export const ON_ENDED_LINE = `x_daas_ham_subscription_line.status=${SUBSCRIPTION_LINE_STATUS.ended}^ORx_daas_ham_subscription_line.end_date<javascript:gs.beginningOfToday()`

/**
 * Encoded query on alm_hardware for the Billing integrity dashboard: fleet assets (ADR 0016) billed from a Service
 * interval whose Subscription line has ended (set ended, or past its end date; the end date itself is billed). Their
 * days after the line's end are not billed (withinLine), so they are flagged; nothing moves them to another line.
 * It is `fleetStagesQuery(IN_USE_STAGES, ON_ENDED_LINE)` written out, one clause per stage in use: the dashboard tile
 * imports it, and Fluent metadata reads no function call (domain/billing.test.ts holds it to the function's result).
 */
export const IN_SERVICE_ON_ENDED_LINE = `install_status=${STAGE_FIELDS.in_service.installStatus}^substatusISEMPTY^${ON_ENDED_LINE}^${FLEET_CONDITION}^NQinstall_status=${STAGE_FIELDS.temporary_deployment.installStatus}^substatus=${STAGE_FIELDS.temporary_deployment.substatus}^${ON_ENDED_LINE}^${FLEET_CONDITION}`

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
 * active days, a per-device line by the device-days its Assets were in service while it ran, per Site.
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
            const billed = withinLine(interval, line)
            const units = billed ? activeDays(bounds, billed.start, billed.end) * (interval.count ?? 1) : 0
            if (units > 0) bySite.set(interval.siteId, (bySite.get(interval.siteId) ?? 0) + units)
        }
    }
    return bySite
}

/** How long a generating Billing period must show no activity before an admin may reset it (Reset generation). */
export const RESET_AFTER_IDLE_MINUTES = 30

/** Whether an admin may reset a period's generation by hand now, and how long it has shown no activity. */
export type GenerationReset = { reset: true; idleMinutes: number } | { reset: false; why: string }

/**
 * Whether a Billing period stuck in Generating may be reset by hand to Ready for review: only once its generation has
 * shown no activity (the latest of `activityMs`, undefined where unknown) for RESET_AFTER_IDLE_MINUTES. Each chunk
 * records its activity as it starts and runs for the job's time budget (minutes), so a generation still running is not
 * cut short and its lines are not billed beside those of the Regenerate that follows.
 */
export function decideGenerationReset(
    status: string,
    activityMs: ReadonlyArray<number | undefined>,
    nowMs: number,
): GenerationReset {
    if (status !== 'generating') return { reset: false, why: 'only a period still generating can be reset' }
    const known = activityMs.filter((ms): ms is number => ms !== undefined)
    if (known.length === 0) {
        return { reset: false, why: 'when its generation was last active cannot be read, so it may still be running' }
    }
    const idleMinutes = Math.max(0, Math.floor((nowMs - Math.max(...known)) / 60000))
    if (idleMinutes >= RESET_AFTER_IDLE_MINUTES) return { reset: true, idleMinutes }
    return {
        reset: false,
        why: `its generation was active ${idleMinutes} minute(s) ago and may still be running; it can be reset once it has shown no activity for ${RESET_AFTER_IDLE_MINUTES} minutes`,
    }
}

/** The generation error a reset period records, which Close period refuses on until a Regenerate clears it. */
export function resetGenerationError(byUser: string, idleMinutes: number): string {
    const note = `Generation reset by hand by ${byUser} after ${idleMinutes} minutes without activity; its lines may be incomplete: Regenerate before closing`
    return note.slice(0, 255)
}

/** A column of a Billing line, as its exports give it. */
interface BillingLineColumn<Field extends string = string> {
    field: Field
    /** A reference reads as its display value in the CSV. */
    type: 'text' | 'number' | 'reference'
    /** Whether the CSV export has the column, headed by its field name. */
    csv: boolean
    /** The pull API's name for the column's stored value. */
    json?: string
    /** The pull API's name for a reference's display value. */
    jsonDisplay?: string
}

/**
 * What a Billing line holds besides its period, in the order every export gives it: the CSV attached to a closed
 * period and the pull API's lines are both read off this list (`billingCsvRow`, `billingLineJson`), and a generated
 * line sets these fields (`BillingLineValues`).
 */
export const BILLING_LINE_COLUMNS = [
    { field: 'kind', type: 'text', csv: true, json: 'kind' },
    { field: 'customer', type: 'reference', csv: true, json: 'customerId', jsonDisplay: 'customer' },
    { field: 'agreement', type: 'reference', csv: true, jsonDisplay: 'agreement' },
    { field: 'subscription_line', type: 'reference', csv: true, json: 'subscriptionLine' },
    { field: 'site', type: 'reference', csv: true, json: 'siteId', jsonDisplay: 'site' },
    { field: 'fee_event', type: 'reference', csv: false, json: 'feeEvent' },
    { field: 'description', type: 'text', csv: true, json: 'description' },
    { field: 'units', type: 'number', csv: true, json: 'units' },
    { field: 'monthly_rate', type: 'number', csv: true, json: 'monthlyRate' },
    { field: 'amount', type: 'number', csv: true, json: 'amount' },
    { field: 'currency', type: 'text', csv: true, json: 'currency' },
] as const satisfies readonly BillingLineColumn[]

export type BillingLineField = (typeof BILLING_LINE_COLUMNS)[number]['field']

/** The fields a generated Billing line is given; one left out keeps the column's default. */
export type BillingLineValues = { readonly [field in BillingLineField]?: string | number }

/** A stored Billing line as an export reads it. */
export interface StoredBillingLine {
    /** The field's stored value ('' when empty). */
    value(field: BillingLineField): string
    /** A reference field's display value. */
    display(field: BillingLineField): string
}

const COLUMNS: ReadonlyArray<BillingLineColumn<BillingLineField>> = BILLING_LINE_COLUMNS
const CSV_COLUMNS = COLUMNS.filter((column) => column.csv)

/** The column's stored value: a number column's as a number, 0 when it is empty or unreadable. */
function storedValue(line: StoredBillingLine, column: BillingLineColumn<BillingLineField>): string | number {
    const value = line.value(column.field)
    if (column.type !== 'number') return value
    const number = Number(value)
    return Number.isFinite(number) ? number : 0
}

/** The CSV export's heading: the period, then each exported column. */
export function billingCsvHeader(): string[] {
    return ['period', ...CSV_COLUMNS.map((column) => column.field)]
}

/** A Billing line's row in the CSV export of `period` (its YYYY-MM month). */
export function billingCsvRow(period: string, line: StoredBillingLine): Array<string | number> {
    return [period, ...CSV_COLUMNS.map((column) => (column.type === 'reference' ? line.display(column.field) : storedValue(line, column)))]
}

/** A Billing line as the pull API gives it. */
export function billingLineJson(id: string, line: StoredBillingLine): { [key: string]: string | number } {
    const json: { [key: string]: string | number } = { id }
    for (const column of COLUMNS) {
        if (column.json) json[column.json] = storedValue(line, column)
        if (column.jsonDisplay) json[column.jsonDisplay] = line.display(column.field)
    }
    return json
}

/** RFC 4180 CSV: fields with commas, quotes or line breaks are quoted, quotes doubled. */
export function toCsv(rows: ReadonlyArray<ReadonlyArray<string | number>>): string {
    return rows.map((row) => row.map((value) => csvField(String(value))).join(',')).join('\r\n') + '\r\n'
}

function csvField(value: string): string {
    return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}
