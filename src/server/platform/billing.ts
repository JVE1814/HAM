import { GlideAggregate, GlideRecord, GlideSysAttachment, gs } from '@servicenow/glide'
import {
    billingCsvHeader,
    billingCsvRow,
    billingLineJson,
    billsFromIntervals,
    decideGenerationReset,
    monthBounds,
    overlapsMonth,
    RESET_AFTER_IDLE_MINUTES,
    resetGenerationError,
    subscriptionCharges,
    toCsv,
    type BillingLineValues,
    type MonthBounds,
    type ServiceInterval,
    type StoredBillingLine,
    type SubscriptionLineTerms,
} from '../domain/billing.ts'
import { appendTo } from '../domain/collections.ts'
import { messageOf } from '../domain/errors.ts'
import { memoized } from '../domain/memo.ts'
import { inCurrentPass, queuePass, runEventTableJob, type EventJobResult } from './chunked.ts'
import { glideToMs, nowGlide, nowMs } from './clock.ts'
import { EVENT, fire, type JobEvent } from './events.ts'
import { billableFees, markBilled, putOnPeriod, takeOffPeriod, visitWaivedFees } from './fees.ts'
import { findJobCursor, retirePass } from './job-cursor.ts'
import { deleteWhere, exists, findById, num, refusal, str } from './records.ts'
import { BILLING_PERIOD_STATUS, type BillingLineKind, SUBSCRIPTION_LINE_STATUS } from '../domain/vocabulary.ts'

/** Billing periods: generate, review, close (lock) and export (P3.25, D66). */

const PERIOD = 'x_daas_ham_billing_period'
const LINE = 'x_daas_ham_billing_line'

/** The kinds of Billing line, by name (the domain's line values carry `kind` as text). */
const LINE_KIND = { subscription: 'subscription', fee: 'fee' } as const satisfies { [Kind in BillingLineKind]: Kind }

/**
 * What became of an action on a period: done, or not done and why. `why` is '' when the platform has told the user
 * already: it refused the save of the form the action was used on.
 */
export type PeriodOutcome = { done: true } | { done: false; why: string }

const DONE: PeriodOutcome = { done: true }

function notDone(why: string): PeriodOutcome {
    return { done: false, why }
}

/**
 * Open the Billing period of `month` unless it exists. Its insert rules set its days and start its generation, as for
 * a period created by hand, so each new period is generated once.
 */
export function openBillingPeriod(month: string): void {
    const existing = new GlideRecord(PERIOD)
    if (existing.get('period', month)) return
    const period = new GlideRecord(PERIOD)
    period.initialize()
    period.setValue('period', month)
    period.setValue('status', BILLING_PERIOD_STATUS.generating)
    if (period.insert()) return
    // No later run opens this month, so a refused one would go unbilled unseen.
    gs.error(`[x_daas_ham] Billing period ${month} not opened: ${refusal(period)}; create it by hand`)
}

/*
 * Generation. A period's generation passes replace each other on its job cursor `billing_generate_<sys_id>`
 * (ADR 0007, platform/chunked `PassJob`): the row names the current pass ('' once reset by hand), and its last run is
 * when that pass last started a chunk, its activity. No lock is taken: a pass starts where it is triggered.
 */

function generationJob(periodId: string): string {
    return `billing_generate_${periodId}`
}

/**
 * Start a new pass of the period's generation and queue its first chunk. The chunks still queued of any earlier pass
 * (one reset by hand) are dropped from then on. Returns why when the pass cannot be recorded, and so does not start.
 */
function startGeneration(period: GlideRecord): string | null {
    const periodId = period.getUniqueValue()
    try {
        queuePass(EVENT.billingGenerate, period, periodId, generationJob(periodId))
        return null
    } catch (error) {
        return messageOf(error)
    }
}

/**
 * Generate a period just inserted still generating (the monthly job's or one made by hand). A pass that cannot be
 * started is held for review with why, as a generation that stops is.
 */
export function generateNewPeriod(inserted: GlideRecord): void {
    const unstarted = startGeneration(inserted)
    if (!unstarted) return
    const period = findById(PERIOD, inserted.getUniqueValue())
    if (period) stopGeneration(period, `generation not started: ${unstarted}`)
}

/**
 * One chunk of a generation pass over the Subscription lines active in the period's month; the last one adds the fees
 * and holds the period for review. A chunk of a pass that was reset or replaced since is dropped. A chunk that cannot
 * run (e.g. a month saved past the month rule) stops the pass and holds the period for review.
 */
export function generateChunk(queued: JobEvent): void {
    const period = findById(PERIOD, queued.subject)
    if (!period) {
        // The period was deleted, or the event names none: nothing can be held for review, so this is all that tells.
        return void gs.warn(`[x_daas_ham] ${queued.name}: dropped a generation chunk, as there is no billing period '${queued.subject}'`)
    }
    if (str(period, 'status') !== BILLING_PERIOD_STATUS.generating) return
    const job = generationJob(queued.subject)
    try {
        recordActivity(job)
        const bounds = monthBounds(str(period, 'period'))
        const result = billLines(period, bounds, queued, job)
        if (result.superseded) return void dropChunk(period)
        if (result.done) finishGeneration(period, bounds)
    } catch (error) {
        // A pass reset or replaced meanwhile must not hold the period, which may be generating afresh by now.
        if (!inCurrentPass(queued, job)) return void dropChunk(period)
        stopGeneration(period, messageOf(error))
    }
}

/**
 * As a chunk starts: record the activity of the job's pass. Recorded before the chunk's pass is checked, so a Reset
 * generation that retires the pass meanwhile sees it and leaves the period generating. Throws when the activity is
 * refused: a pass that cannot show activity could be reset while it runs. A job without a row has no pass to show.
 */
function recordActivity(job: string): void {
    const refused = findJobCursor(job)?.save({ ranNow: true })
    if (refused) throw new Error(`generation activity not recorded: ${refused}`)
}

function dropChunk(period: GlideRecord): void {
    gs.warn(
        `[x_daas_ham] Billing period ${str(period, 'period')}: dropped a generation chunk of a pass reset or replaced; if the period stays Generating, Reset generation and Regenerate it`,
    )
}

/** Bill the next chunk of the period's Subscription lines after the event's cursor. */
function billLines(period: GlideRecord, bounds: MonthBounds, queued: JobEvent, job: string): EventJobResult {
    const siteName = memoized(siteNameOf)
    return runEventTableJob(queued, {
        pass: { job },
        table: 'x_daas_ham_subscription_line',
        query: `status!=${SUBSCRIPTION_LINE_STATUS.pending}^${overlapsMonth(bounds)}`,
        read: (line) => ({
            lineId: line.getUniqueValue(),
            terms: {
                lineType: str(line, 'line_type'),
                monthlyRate: num(line, 'monthly_rate'),
                siteId: str(line, 'site'),
                description: str(line, 'description'),
                start: str(line, 'start_date') || undefined,
                end: str(line, 'end_date') || undefined,
            },
            customerId: str(line, 'customer'),
            agreementId: str(line, 'agreement'),
            currency: str(line, 'currency') || 'EUR',
        }),
        prepare: (lines: readonly LineRow[]) => withIntervals(lines, bounds),
        // Before the next chunk is queued: a line that could not be billed must not vanish from the bill, so a count
        // the period refuses stops the generation (held for review) instead of letting it finish as clean.
        flush: (failures) => {
            if (failures.failed === 0) return
            addFailedLines(period, failures.failed, failures.lastError)
            if (!period.update()) throw new Error(`${failures.failed} failed line(s) not counted: ${refusal(period)}`)
        },
        handle: (line, lineId) => {
            if (line.intervalsUnread) throw line.intervalsUnread.error
            for (const charge of subscriptionCharges(line.terms, bounds, { intervals: line.intervals, siteName })) {
                insertLine(period, {
                    kind: LINE_KIND.subscription,
                    customer: line.customerId,
                    agreement: line.agreementId,
                    subscription_line: lineId,
                    site: charge.siteId,
                    description: charge.description,
                    units: charge.units,
                    monthly_rate: line.terms.monthlyRate,
                    amount: charge.amount,
                    currency: line.currency,
                })
            }
        },
    })
}

/**
 * Hold a period whose generation stopped for review, recording why (saves it): Close period refuses until a
 * Regenerate completes.
 */
function stopGeneration(period: GlideRecord, error: string): void {
    gs.error(`[x_daas_ham] Billing period ${str(period, 'period')}: generation stopped: ${error}`)
    period.setValue('last_error', error.slice(0, 255))
    // Refused, it stays generating with no chunk queued, which Close and Regenerate refuse: say why.
    if (!holdForReview(period)) {
        gs.error(`[x_daas_ham] Billing period ${str(period, 'period')} not held for review: ${refusal(period)}`)
    }
}

/**
 * Save the period as ready for review with the count and total of the lines it has now, whether or not its generation
 * finished: a Regenerate keeps the previous totals until then, and they must not show against its new lines. False
 * when the platform refuses the save, and the period stays generating.
 */
function holdForReview(period: GlideRecord): boolean {
    setTotals(period)
    period.setValue('status', BILLING_PERIOD_STATUS.ready)
    return Boolean(period.update())
}

/** A Site's name ('' without a Site); a generation chunk reads each once. */
function siteNameOf(siteId: string): string {
    const site = findById('cmn_location', siteId)
    return site ? str(site, 'name') : ''
}

/** A Subscription line as read for billing: its terms, whom it bills and in which currency. */
interface LineRow {
    lineId: string
    terms: SubscriptionLineTerms
    customerId: string
    agreementId: string
    currency: string
}

/** A Subscription line ready to bill: its row, and its Service intervals in the month. */
type BillableLine = LineRow & {
    intervals: readonly ServiceInterval[]
    /** Set when the line is billed from Service intervals that could not be read: it fails to bill with this error. */
    intervalsUnread?: { error: unknown }
}

/**
 * The batch's lines with their Service intervals in the month (none for a line not billed from them), read with
 * one aggregate for the whole batch. If that read fails, only the lines billed from intervals fail, so the others still bill.
 */
function withIntervals(lines: readonly LineRow[], bounds: MonthBounds): BillableLine[] {
    try {
        const byLine = intervalsByLine(lines.filter((line) => billsFromIntervals(line.terms)).map((line) => line.lineId), bounds)
        return lines.map((line) => ({ ...line, intervals: byLine.get(line.lineId) ?? [] }))
    } catch (error) {
        return lines.map((line) => ({ ...line, intervals: [], intervalsUnread: billsFromIntervals(line.terms) ? { error } : undefined }))
    }
}

/** The Service intervals in the month of each of these lines: one per Site and dates, with the number of Assets sharing them. */
function intervalsByLine(lineIds: readonly string[], bounds: MonthBounds): Map<string, ServiceInterval[]> {
    const byLine = new Map<string, ServiceInterval[]>()
    if (lineIds.length === 0) return byLine
    const ga = new GlideAggregate('x_daas_ham_service_interval')
    ga.addEncodedQuery(`subscription_lineIN${lineIds.join(',')}^${overlapsMonth(bounds)}`)
    ga.addAggregate('COUNT', '')
    ga.groupBy('subscription_line')
    ga.groupBy('site')
    ga.groupBy('start_date')
    ga.groupBy('end_date')
    ga.query()
    while (ga.next()) {
        appendTo(byLine, String(ga.getValue('subscription_line') ?? ''), {
            siteId: String(ga.getValue('site') ?? ''),
            start: String(ga.getValue('start_date') ?? ''),
            end: String(ga.getValue('end_date') ?? '') || undefined,
            count: Number(ga.getAggregate('COUNT', '')),
        })
    }
    return byLine
}

/** Insert a Billing line; throws when the platform refuses it, so the line counts as failed instead of vanishing. */
function insertLine(period: GlideRecord, values: BillingLineValues): void {
    const line = new GlideRecord(LINE)
    line.initialize()
    line.setValue('billing_period', period.getUniqueValue())
    for (const [field, value] of Object.entries(values)) line.setValue(field, value)
    if (!line.insert()) throw new Error(`billing line not saved: ${refusal(line)}`)
}

/** Count lines that failed to bill on the period (does not save): Close period refuses until a regeneration bills them. */
function addFailedLines(period: GlideRecord, failed: number, lastError: string): void {
    gs.error(`[x_daas_ham] Billing period ${str(period, 'period')}: ${failed} line(s) failed: ${lastError}`)
    period.setValue('failed_lines', num(period, 'failed_lines') + failed)
    period.setValue('last_error', lastError.slice(0, 255))
}

/** Add the open Fee events up to the month end, then total the period for review. */
function finishGeneration(period: GlideRecord, bounds: MonthBounds): void {
    const fee = billableFees(period.getUniqueValue(), bounds.last)
    let failed = 0
    let lastError = ''
    while (fee.next()) {
        try {
            insertLine(period, {
                kind: LINE_KIND.fee,
                customer: str(fee, 'customer'),
                agreement: str(fee, 'agreement'),
                fee_event: fee.getUniqueValue(),
                description: feeLabel(fee),
                units: 1,
                amount: num(fee, 'amount'),
                currency: str(fee, 'currency') || 'EUR',
            })
        } catch (error) {
            // The fee stays open without a period, so a regeneration bills it.
            failed++
            lastError = `${fee.getUniqueValue()}: ${messageOf(error)}`
            continue
        }
        const unlinked = putOnPeriod(fee, period.getUniqueValue())
        if (!unlinked) continue
        // Unlinked, Close would not mark it billed and a later month would bill it again: Regenerate links it.
        failed++
        lastError = `${fee.getUniqueValue()}: fee not linked to the period: ${unlinked}`
    }
    if (failed > 0) addFailedLines(period, failed, lastError)
    period.setValue('generated_at', nowGlide())
    // Refused, it stays generating, which Close and Regenerate refuse: say why.
    if (!holdForReview(period)) {
        gs.error(`[x_daas_ham] Billing period ${str(period, 'period')} not saved as ready: ${refusal(period)}`)
    }
}

/** Line count and total of the period (does not save). */
function setTotals(period: GlideRecord): void {
    const totals = new GlideAggregate(LINE)
    totals.addEncodedQuery(`billing_period=${period.getUniqueValue()}`)
    totals.addAggregate('COUNT', '')
    totals.addAggregate('SUM', 'amount')
    totals.query()
    const hasTotals = totals.next()
    period.setValue('line_count', hasTotals ? Number(totals.getAggregate('COUNT', '')) : 0)
    period.setValue('total_amount', hasTotals ? Number(totals.getAggregate('SUM', 'amount')) || 0 : 0)
}

/** How a Fee event reads on its billing line, and in the messages that name it. */
function feeLabel(fee: GlideRecord): string {
    return `${fee.getDisplayValue('fee_type')} fee: ${fee.getDisplayValue('asset')} (${str(fee, 'occurred_on')})`
}

/** Regenerate a period ready for review: rebuild its lines from current data. */
export function regeneratePeriod(period: GlideRecord): PeriodOutcome {
    if (str(period, 'status') !== BILLING_PERIOD_STATUS.ready) return notDone('Only a period ready for review can be regenerated')
    period.setValue('status', BILLING_PERIOD_STATUS.generating)
    period.setValue('failed_lines', 0)
    period.setValue('last_error', '')
    // Saved first: a refused form save (the platform says why) keeps the period ready with its lines, not without them.
    if (!period.update()) return notDone('')
    // Lines the delete left would be billed twice by the new generation.
    if (!dropLinesForRegeneration(period)) {
        period.setValue('status', BILLING_PERIOD_STATUS.ready)
        period.setValue('last_error', 'Regenerate could not remove all of the old lines; remove them and Regenerate again')
        period.update()
        return notDone(`${str(period, 'period')} not regenerated: some of its old lines could not be removed`)
    }
    // The period's open fees stay linked to it: the generation bills them again (finishGeneration).
    const unstarted = startGeneration(period)
    if (!unstarted) return DONE
    stopGeneration(period, `generation not started: ${unstarted}`)
    return notDone(`${str(period, 'period')} not regenerated: ${unstarted}`)
}

/**
 * Reset a period stuck generating: hold it for review with the reset as its error, so Close period refuses until a
 * Regenerate bills it afresh. It deletes and bills nothing, and only resets a generation that has shown no activity
 * for 30 minutes (domain/billing `decideGenerationReset`): the period's own last save, or its pass's last chunk start
 * on the job cursor. The pass is retired first, so a chunk of it still queued is dropped, even once a Regenerate has
 * the period generating again. A chunk that starts as the pass is retired may have found it still current; the period
 * then stays generating, so nothing can be regenerated beside that chunk until it is done.
 */
export function resetGeneration(period: GlideRecord): PeriodOutcome {
    const name = str(period, 'period')
    const job = generationJob(period.getUniqueValue())
    const pass = findJobCursor(job)
    const lastChunk = pass ? pass.lastRun : ''
    const activity = [glideToMs(str(period, 'sys_updated_on')), glideToMs(lastChunk)]
    const decision = decideGenerationReset(str(period, 'status'), activity, nowMs())
    if (!decision.reset) return notDone(`${name} not reset: ${decision.why}`)
    // Without a job cursor no pass was recorded, and chunks of none are dropped: nothing is left to retire.
    if (pass) {
        const refused = retirePass(pass)
        if (refused) return notDone(`${name} not reset: its generation could not be stopped: ${refused}`)
        if ((findJobCursor(job) ?? pass).lastRun !== lastChunk) {
            return notDone(
                `${name} not reset: a chunk of its generation started as it was being reset. Its generation is stopped and the period stays Generating until that chunk is done: Reset generation again in ${RESET_AFTER_IDLE_MINUTES} minutes`,
            )
        }
    }
    period.setValue('last_error', resetGenerationError(gs.getUserDisplayName(), decision.idleMinutes))
    // Refused (the platform says why), it stays generating with its pass retired: Reset generation again.
    return holdForReview(period) ? DONE : notDone('')
}

/**
 * Fee lines whose fee was waived after generation (e.g. a missing unit turned up) are not billed: their lines are
 * deleted and the fees leave the period (does not redo the totals). Returns each fee that could not leave it, named
 * with why, for Close to refuse with; a retry finds them again. Only called while the period is still ready for
 * review, so the closed-line lock lets the lines go.
 */
function dropWaivedFeeLines(period: GlideRecord): string[] {
    const stuck: string[] = []
    const periodId = period.getUniqueValue()
    visitWaivedFees(periodId, (fee) => {
        // Lines first, by the fee's id (a set-based delete is not relied on to follow a dot-walked condition).
        // A fee whose line survives stays on the period: unlinked, the closed period would keep a line it no
        // longer bills.
        const lines = `billing_period=${periodId}^kind=${LINE_KIND.fee}^fee_event=${fee.getUniqueValue()}`
        if (!deleteWhere(LINE, lines)) return void stuck.push(`${feeLabel(fee)}: its billing line could not be removed`)
        const kept = takeOffPeriod(fee)
        if (kept) stuck.push(`${feeLabel(fee)}: ${kept}`)
    })
    return stuck
}

/** Close a period ready for review: lock it and mark its fees billed. Its export and margin are for the caller to queue. */
export function closePeriod(period: GlideRecord): PeriodOutcome {
    if (str(period, 'status') !== BILLING_PERIOD_STATUS.ready) return notDone('Only a period ready for review can be closed')
    const name = str(period, 'period')
    const failed = num(period, 'failed_lines')
    const lastError = str(period, 'last_error')
    if (failed > 0 || lastError) {
        return notDone(
            `${name} did not generate cleanly (${failed} line(s) failed to bill; last error: ${lastError || 'none'}); fix the cause and Regenerate before closing`,
        )
    }
    const stuck = dropWaivedFeeLines(period)
    if (stuck.length > 0) {
        const named = stuck.slice(0, 3).join('; ') + (stuck.length > 3 ? `; and ${stuck.length - 3} more` : '')
        return notDone(`${name} not closed, as ${stuck.length} waived fee(s) could not leave it: ${named}. Fix them and Close again`)
    }
    // Always: finance may have adjusted lines during review, and the locked total must match the locked lines.
    setTotals(period)
    period.setValue('status', BILLING_PERIOD_STATUS.closed)
    period.setValue('closed_at', nowGlide())
    period.setValue('closed_by', gs.getUserID())
    // Closed first: a refused form save (the platform says why) leaves its fees open, so a Regenerate still bills them.
    if (!period.update()) return notDone('')
    markBilled(period.getUniqueValue())
    return DONE
}

/** Queue the CSV export of a closed period (attached in the background by `attachExport`). */
export function queueExport(period: GlideRecord): void {
    fire(EVENT.billingExport, period, period.getUniqueValue())
}

/** The CSV export of a period: its file name, and whether it is attached. */
export function exportOf(period: GlideRecord): { fileName: string; attached: boolean } {
    const fileName = `billing-${str(period, 'period')}.csv`
    return { fileName, attached: exists('sys_attachment', exportQuery(period, fileName)) }
}

/**
 * Attach the CSV of a closed period's lines unless it is already attached. Only reads the period, so the
 * closed-period lock is not hit. Two exports racing each other converge on one file: each keeps only the oldest copy.
 * A failure is logged as an error naming the period, and Re-export CSV can be used once it is fixed.
 */
export function attachExport(periodId: string): void {
    const period = findById(PERIOD, periodId)
    if (!period || str(period, 'status') !== BILLING_PERIOD_STATUS.closed) return
    const { fileName, attached } = exportOf(period)
    if (attached) return
    try {
        const rows: Array<Array<string | number>> = [billingCsvHeader()]
        const stored = lineReader()
        const line = linesOf(periodId)
        line.query()
        while (line.next()) rows.push(billingCsvRow(str(period, 'period'), stored(line)))
        new GlideSysAttachment().write(period, fileName, 'text/csv', toCsv(rows))
        keepOldestExport(period, fileName)
    } catch (error) {
        gs.error(`[x_daas_ham] CSV export of billing period ${str(period, 'period')} failed: ${messageOf(error)}`)
    }
}

/** Delete every copy of the export but the oldest (a deterministic choice every racing export agrees on). */
function keepOldestExport(period: GlideRecord, fileName: string): void {
    const copy = new GlideRecord('sys_attachment')
    copy.addEncodedQuery(`${exportQuery(period, fileName)}^ORDERBYsys_created_on^ORDERBYsys_id`)
    copy.query()
    const attachments = new GlideSysAttachment()
    if (copy.next()) while (copy.next()) attachments.deleteAttachment(copy.getUniqueValue())
}

function exportQuery(period: GlideRecord, fileName: string): string {
    return `table_name=${PERIOD}^table_sys_id=${period.getUniqueValue()}^file_name=${fileName}`
}

/** The period's lines in the order every export gives them, by Customer: not yet queried. */
function linesOf(periodId: string): GlideRecord {
    const line = new GlideRecord(LINE)
    line.addQuery('billing_period', periodId)
    line.orderBy('customer')
    line.orderBy('sys_id')
    return line
}

/** Reads Billing lines for an export (domain/billing `StoredBillingLine`), looking up each referenced record's display value once. */
function lineReader(): (line: GlideRecord) => StoredBillingLine {
    // Keyed by the referenced record; the first line seen for it supplies the display value.
    const cache = new Map<string, string>()
    return (line) => ({
        value: (field) => str(line, field),
        display: (field) => {
            const key = `${field}|${str(line, field)}`
            if (!cache.has(key)) cache.set(key, line.getDisplayValue(field))
            return cache.get(key) ?? ''
        },
    })
}

/** The `limit` most recent periods, as the pull API lists them. */
export function recentPeriods(limit: number): object[] {
    const period = new GlideRecord(PERIOD)
    period.orderByDesc('period')
    period.setLimit(limit)
    period.query()
    const periods: object[] = []
    while (period.next()) {
        periods.push({
            id: period.getUniqueValue(),
            period: str(period, 'period'),
            status: str(period, 'status'),
            lines: num(period, 'line_count'),
            total: num(period, 'total_amount'),
        })
    }
    return periods
}

/** One page of a period's lines as the pull API gives it (a closed period's are final), or null for an unknown period. */
export function linesPage(periodId: string, offset: number, limit: number): object | null {
    const period = findById(PERIOD, periodId)
    if (!period) return null
    const stored = lineReader()
    const line = linesOf(periodId)
    line.chooseWindow(offset, offset + limit, false)
    line.query()
    const lines: object[] = []
    while (line.next()) lines.push(billingLineJson(line.getUniqueValue(), stored(line)))
    return {
        period: str(period, 'period'),
        status: str(period, 'status'),
        final: str(period, 'status') === BILLING_PERIOD_STATUS.closed,
        total: num(period, 'total_amount'),
        offset,
        lines,
        nextOffset: lines.length === limit ? offset + limit : null,
    }
}

/*
 * The lock on a closed period. Two before update/delete rules refuse any change to a closed period and to its lines
 * (`closedPeriodRefusal`, `closedLineRefusal`), and each is passed by one write, made without running it:
 * `recordMarginOutcome` and `dropLinesForRegeneration`. Any other write that must get past a rule belongs here too.
 */

/** Why this save or delete of a period is refused: it is closed. Null for one that is not. */
export function closedPeriodRefusal(current: GlideRecord, previous: GlideRecord | null): string | null {
    return str(previous ?? current, 'status') === BILLING_PERIOD_STATUS.closed ? 'This billing period is closed and locked' : null
}

/**
 * Save a margin pass's failure count and last error on its Billing period (0 and '' clear them). The period is closed
 * and locked; these fields are about Margin, not the bill, so the save is made without the period's rules. Throws when
 * the platform refuses it: a period whose count is not saved would read as complete.
 */
export function recordMarginOutcome(period: GlideRecord, failed: number, error: string): void {
    period.setValue('margin_failed', failed)
    period.setValue('margin_error', error.slice(0, 255))
    period.setWorkflow(false)
    if (!period.update()) throw new Error(`Margin status not saved: ${refusal(period)}`)
}

/**
 * Why this save or delete of a Billing line is refused: a closed period's lines never change. The dot-walk on current
 * follows the period being saved, so an update moving the line to another period also checks the stored one: no line
 * leaves a closed period. Null for a line of no closed period.
 */
export function closedLineRefusal(current: GlideRecord, previous: GlideRecord): string | null {
    const statuses = [str(current, 'billing_period.status')]
    if (current.operation() === 'update' && str(previous, 'billing_period') !== str(current, 'billing_period')) {
        statuses.push(str(previous, 'billing_period.status'))
    }
    return statuses.includes(BILLING_PERIOD_STATUS.closed) ? 'This billing period is closed; its lines cannot change' : null
}

/**
 * Delete the lines of a period being regenerated, without the lines' rules: the period is generating, not closed, so
 * the lock has nothing to stop. False when a line is left.
 */
function dropLinesForRegeneration(period: GlideRecord): boolean {
    return deleteWhere(LINE, `billing_period=${period.getUniqueValue()}`, { businessRules: false })
}
