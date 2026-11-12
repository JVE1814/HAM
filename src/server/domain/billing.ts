import { addDays, addMonths } from './calendar.ts'
import { activeDays, currencyKey, divideRounded, fromCents, isMonth, previousMonth, toCents, type MonthBounds } from './money.ts'
import { FLEET_CONDITION, fleetStagesQuery } from './fleet.ts'
import { DEPLOYED_STAGES } from './lifecycle.ts'
import { BILLING_PERIOD_STATUS, STAGE_FIELDS, SUBSCRIPTION_LINE_STATUS, SUBSCRIPTION_LINE_TYPE } from './vocabulary.ts'
import { ROLE, type AppRole } from './roles.ts'

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

/** Rates are taken to four decimals (ten-thousandths of the currency unit): a rate with more is rounded to four first. */
const RATE_SCALE = 10000

/**
 * A monthly rate charged for `units` (whole) days, or device-days, of a month, to the cent: worked out in whole numbers,
 * so a charge of exactly half a cent rounds up (0.29 a month for 14 of 28 days is 0.15).
 */
function prorate(monthlyRate: number, units: number, daysInMonth: number): number {
    if (daysInMonth <= 0) return 0
    const rate = Math.round(monthlyRate * RATE_SCALE)
    return fromCents(divideRounded(rate * Math.round(units), daysInMonth * (RATE_SCALE / 100)))
}

/** The days one Asset (or `count` Assets) delivered a Subscription line at a Site (end inclusive; none while still in service). */
export interface ServiceInterval {
    siteId: string
    start: string
    end?: string
    /** Assets that share this Site and these dates (default 1). */
    count?: number
}

/**
 * The last day (inclusive) of a Service interval that started on `start` and is closed on `closedOn`, or null for one
 * that starts later (the day after an interval elsewhere ended, restartInterval): it delivered no day, so it is removed
 * and not ended, which would bill its first day.
 */
export function intervalEnd(start: string, closedOn: string): string | null {
    return closedOn < start ? null : closedOn
}

/** Where an Asset in service is billed: the Subscription line it delivers ('' for none) and its Site. A Service interval records both once, as it opens. */
export interface IntervalPlace {
    lineId: string
    siteId: string
}

/**
 * How billing restarts on `start` at `place` for an Asset whose latest closed Service interval is
 * `latest` (end inclusive): one at the same place that ends on or after `start` is reopened, so no day
 * is billed twice; one elsewhere makes the new interval start the day after it ends; otherwise it starts on `start`.
 */
export function restartInterval<Closed extends IntervalPlace & { end: string }>(
    latest: Closed | null,
    place: IntervalPlace,
    start: string,
): { reopen: Closed } | { start: string } {
    if (!latest || latest.end < start) return { start }
    return latest.lineId === place.lineId && latest.siteId === place.siteId ? { reopen: latest } : { start: addDays(latest.end, 1) }
}

export interface SubscriptionLineTerms {
    /** As stored. 'site_package' bills its own dates, 'device_class' its Service intervals; any other value bills nothing. */
    lineType: string
    monthlyRate: number
    /** The currency it bills in: its Agreement's (chooseCurrency). */
    currency: string
    /** The package's Site ('' on a per-device line). */
    siteId: string
    description: string
    /** The line's own dates, end inclusive: a site package bills them, a per-device line its intervals within them. */
    start?: string
    end?: string
}

export function billsFromIntervals(line: Pick<SubscriptionLineTerms, 'lineType'>): boolean {
    return line.lineType === SUBSCRIPTION_LINE_TYPE.device_class
}

/** A range of days, end inclusive; no end means still open. */
interface DayRange {
    start: string
    end?: string
}

/**
 * The days of a Service interval its per-device line bills: the interval cut to the line's own start and end date, so
 * a unit still in service after its line ended stops billing on the line's end date (the Billing integrity dashboard
 * flags it, IN_SERVICE_ON_ENDED_LINE; it is never moved to another line). Null when they do not overlap, and for a
 * line without a start date, which has not started (a site package without one bills nothing either).
 */
function withinLine(interval: DayRange, line: Partial<DayRange>): DayRange | null {
    if (!line.start || !interval.start) return null
    const start = interval.start > line.start ? interval.start : line.start
    const end = !line.end || (interval.end && interval.end < line.end) ? interval.end : line.end
    return end !== undefined && end < start ? null : { start, end }
}

/**
 * Why a Subscription line cannot be saved as it is, or null: one set Ended needs its End date. Billing goes by a
 * line's dates and takes one without an End date as still open, whatever its status, so an Ended line without one
 * would be billed every month. The End date is the last day billed, which only whoever ends the line knows, so none
 * is filled in for them.
 */
export function endedLineProblem(line: { status: string; endDate: string }): string | null {
    if (line.status !== SUBSCRIPTION_LINE_STATUS.ended || line.endDate) return null
    return 'An Ended subscription line needs an End date, the last day it is billed: enter it (today, if the line ends now)'
}

const NO_LINE = 'x_daas_ham_subscription_lineISEMPTY'

/**
 * Encoded query on alm_hardware for the Billing integrity dashboard: fleet assets (ADR 0016) in a billed stage on no
 * Subscription line, which nothing bills. Go-live attaches a unit to none when no open line of its Agreement matches
 * it (platform/subscriptions), on a temporary deployment as in service. It is
 * `fleetStagesQuery(IN_USE_STAGES, NO_LINE)` written out, one clause per stage in use, as IN_SERVICE_ON_ENDED_LINE is.
 */
export const IN_SERVICE_UNBILLED = `install_status=${STAGE_FIELDS.in_service.installStatus}^substatusISEMPTY^${NO_LINE}^${FLEET_CONDITION}^NQinstall_status=${STAGE_FIELDS.temporary_deployment.installStatus}^substatus=${STAGE_FIELDS.temporary_deployment.substatus}^${NO_LINE}^${FLEET_CONDITION}`

const ON_ENDED_LINE = `x_daas_ham_subscription_line.status=${SUBSCRIPTION_LINE_STATUS.ended}^ORx_daas_ham_subscription_line.end_date<javascript:gs.beginningOfToday()`

/**
 * Encoded query on alm_hardware for the Billing integrity dashboard: fleet assets (ADR 0016) billed from a Service
 * interval whose Subscription line has ended (set ended, or past its end date; the end date itself is billed). Their
 * days after the line's end are not billed (withinLine), so they are flagged; nothing moves them to another line.
 * It is `fleetStagesQuery(IN_USE_STAGES, ON_ENDED_LINE)` written out, one clause per stage in use: the dashboard tile
 * imports it, and Fluent metadata reads no function call (domain/billing.test.ts checks which Assets it flags).
 */
export const IN_SERVICE_ON_ENDED_LINE = `install_status=${STAGE_FIELDS.in_service.installStatus}^substatusISEMPTY^${ON_ENDED_LINE}^${FLEET_CONDITION}^NQinstall_status=${STAGE_FIELDS.temporary_deployment.installStatus}^substatus=${STAGE_FIELDS.temporary_deployment.substatus}^${ON_ENDED_LINE}^${FLEET_CONDITION}`

const ON_PENDING_LINE = `x_daas_ham_subscription_line.status=${SUBSCRIPTION_LINE_STATUS.pending}`

/**
 * Encoded query on alm_hardware for the Billing integrity dashboard: fleet assets (ADR 0016) in a billed stage whose
 * Subscription line is still pending. Generation bills no pending line, so nothing bills them. Go-live starts a pending
 * line as it attaches a unit (platform/subscriptions), so only a line set on the Asset by hand leaves one here. It is
 * `fleetStagesQuery(IN_USE_STAGES, ON_PENDING_LINE)` written out, as IN_SERVICE_ON_ENDED_LINE is.
 */
export const IN_SERVICE_ON_PENDING_LINE = `install_status=${STAGE_FIELDS.in_service.installStatus}^substatusISEMPTY^${ON_PENDING_LINE}^${FLEET_CONDITION}^NQinstall_status=${STAGE_FIELDS.temporary_deployment.installStatus}^substatus=${STAGE_FIELDS.temporary_deployment.substatus}^${ON_PENDING_LINE}^${FLEET_CONDITION}`

/**
 * Encoded query on x_daas_ham_subscription_line for the Billing integrity dashboard: the lines endedLineProblem
 * refuses, saved before its rule or past it. Billing takes each as still open and bills it every month until it is
 * given its End date.
 */
export const ENDED_LINES_WITHOUT_END_DATE = `status=${SUBSCRIPTION_LINE_STATUS.ended}^end_dateISEMPTY`

/**
 * The Assets that keep a site package open, as an encoded alm_hardware query: the fleet assets (ADR 0016) at its Site
 * under its Agreement on their way there, serving there or on their way back. A unit received at the depot or declared
 * missing no longer counts. A swap's new units do, before monitoring first sees them and attaches them to the package,
 * so a swap-back that reaches the depot first does not end it (Q60).
 */
export function sitePackageHoldersQuery(line: { siteId: string; agreementId: string }): string {
    return fleetStagesQuery(DEPLOYED_STAGES, `x_daas_ham_site=${line.siteId}^x_daas_ham_agreement=${line.agreementId}`)
}

/** What one Subscription line bills at one Site for the month: the content of its Billing line. */
export interface Charge {
    siteId: string
    /** '<line description> - <Site name>', or just the line description when the Site has no name. */
    description: string
    /** Days for a site package; device-days for a per-device line. */
    units: number
    /** To the cent, in `currency`. */
    amount: number
    currency: string
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
            currency: line.currency,
        }
    })
}

function unitsBySite(line: SubscriptionLineTerms, bounds: MonthBounds, sources: ChargeSources): Map<string, number> {
    const bySite = new Map<string, number>()
    if (line.lineType === SUBSCRIPTION_LINE_TYPE.site_package) {
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

export const RESET_AFTER_IDLE_MINUTES = 30

type GenerationReset = { reset: true; idleMinutes: number } | { reset: false; why: string }

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
    if (status !== BILLING_PERIOD_STATUS.generating) return { reset: false, why: 'only a period still generating can be reset' }
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

/** The length of the errors a Billing period records: its `last_error` (generation) and its `margin_error`. */
export const PERIOD_ERROR_LENGTH = 255

/** `text` as a Billing period stores it in either error field: the platform refuses or cuts a longer value unseen. */
export function periodError(text: string): string {
    return text.slice(0, PERIOD_ERROR_LENGTH)
}

/** The generation error a reset period records, which Close period refuses on until a Regenerate clears it. */
export function resetGenerationError(byUser: string, idleMinutes: number): string {
    return periodError(
        `Generation reset by hand by ${byUser} after ${idleMinutes} minutes without activity; its lines may be incomplete: Regenerate before closing`,
    )
}

/**
 * The generation error a period records when its month is changed after it was inserted: its lines and fees are still
 * the old month's (or both months', changed mid-generation), so Close period refuses until a Regenerate bills the new one.
 */
export function monthChangedError(month: string): string {
    return `Month changed to ${month}; its lines are still the old month's: Regenerate before closing`
}

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
 * period and the pull API's lines are both read off this list.
 */
const BILLING_LINE_COLUMNS = [
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

export interface StoredBillingLine {
    /** The field's stored value ('' when empty). */
    value(field: BillingLineField): string
    display(field: BillingLineField): string
}

const COLUMNS: ReadonlyArray<BillingLineColumn<BillingLineField>> = BILLING_LINE_COLUMNS
const CSV_COLUMNS = COLUMNS.filter((column) => column.csv)

function storedValue(line: StoredBillingLine, column: BillingLineColumn<BillingLineField>): string | number {
    const value = line.value(column.field)
    if (column.type !== 'number') return value
    const number = Number(value)
    return Number.isFinite(number) ? number : 0
}

export function billingCsvHeader(): string[] {
    return ['period', ...CSV_COLUMNS.map((column) => column.field)]
}

export function billingCsvRow(period: string, line: StoredBillingLine): Array<string | number> {
    return [period, ...CSV_COLUMNS.map((column) => (column.type === 'reference' ? line.display(column.field) : storedValue(line, column)))]
}

export function billingLineJson(id: string, line: StoredBillingLine): { [key: string]: string | number } {
    const json: { [key: string]: string | number } = { id }
    for (const column of COLUMNS) {
        if (column.json) json[column.json] = storedValue(line, column)
        if (column.jsonDisplay) json[column.jsonDisplay] = line.display(column.field)
    }
    return json
}

/**
 * Who pulls Billing periods and their lines through the pull API: finance, and the billing consumer (an ERP), whose
 * machine role reads them and grants nothing else. Not the NMS's role (domain/device-events `DEVICE_EVENT_SENDERS`):
 * a credential that posts device events reads no Customer's bill, and one that reads bills posts no sighting.
 */
export const BILLING_PULL_READERS: readonly AppRole[] = [ROLE.finance, ROLE.billingReader]

export const PULL_PAGE = {
    periods: { size: 24, most: 120 },
    lines: { size: 1000, most: 5000 },
} as const

export function pullPageSize(requested: number, page: { most: number }): number {
    return Math.min(Math.max(requested, 1), page.most)
}

export interface CurrencyTotal {
    /** As stored on the lines (currencyCode); '' for lines without one. */
    currency: string
    lines: number
    amount: number
}

/**
 * A Billing period's totals per currency, in currency order, from its lines' counts and amounts grouped by currency
 * (rows of one currency are merged, summed in whole cents). Amounts of two currencies are never added.
 */
export function currencyTotals(groups: Iterable<CurrencyTotal>): CurrencyTotal[] {
    const byCurrency = new Map<string, { lines: number; cents: number }>()
    for (const group of groups) {
        const currency = currencyKey(group.currency)
        const total = byCurrency.get(currency) ?? { lines: 0, cents: 0 }
        total.lines += group.lines
        total.cents += toCents(group.amount)
        byCurrency.set(currency, total)
    }
    return [...byCurrency.keys()].sort().map((currency) => {
        const total = byCurrency.get(currency) ?? { lines: 0, cents: 0 }
        return { currency, lines: total.lines, amount: fromCents(total.cents) }
    })
}

/** The most a period's Totals text holds (its field's length). */
export const TOTALS_TEXT_LENGTH = 255

/** A period's totals as its Totals field shows them, e.g. 'EUR 1234.56; USD 99.00' ('' without lines). */
export function totalsText(totals: readonly CurrencyTotal[]): string {
    const text = totals.map((total) => `${total.currency || 'no currency'} ${fromCents(toCents(total.amount)).toFixed(2)}`).join('; ')
    return text.length > TOTALS_TEXT_LENGTH ? `${text.slice(0, TOTALS_TEXT_LENGTH - 4)} ...` : text
}

/** A period's Total: its lines' amount while they are all in one currency (0 without lines); null when in several. */
export function singleCurrencyTotal(totals: readonly CurrencyTotal[]): number | null {
    if (totals.length === 0) return 0
    return totals.length === 1 ? totals[0].amount : null
}

/** RFC 4180 CSV: fields with commas, quotes or line breaks are quoted, quotes doubled. */
export function toCsv(rows: ReadonlyArray<ReadonlyArray<string | number>>): string {
    return rows.map((row) => row.map(csvField).join(',')).join('\r\n') + '\r\n'
}

/**
 * Text a spreadsheet would read as a formula when it starts a cell (OWASP CSV injection): it is written with a leading
 * apostrophe, so a description or a name such as '=HYPERLINK(...)' opens as text. Numbers are written as they are.
 */
const FORMULA_START = /^[=+\-@\t\r]/

function csvField(value: string | number): string {
    const text = typeof value === 'string' && FORMULA_START.test(value) ? `'${value}` : String(value)
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}
