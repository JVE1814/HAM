import { GlideAggregate, GlideRecord, GlideSysAttachment, gs } from '@servicenow/glide'
import {
    billingCsvHeader,
    billingCsvRow,
    billingLineJson,
    billsFromIntervals,
    chooseCurrency,
    currencyOrThrow,
    currencyTotals,
    decideGenerationReset,
    monthBounds,
    overlapsMonth,
    RESET_AFTER_IDLE_MINUTES,
    resetGenerationError,
    singleCurrencyTotal,
    subscriptionCharges,
    toCsv,
    totalsText,
    type AgreementCurrency,
    type BillingLineValues,
    type CurrencyTotal,
    type MonthBounds,
    type ServiceInterval,
    type StoredBillingLine,
    type SubscriptionLineTerms,
} from '../domain/billing.ts'
import { appendTo } from '../domain/collections.ts'
import { messageOf } from '../domain/errors.ts'
import { LOCK } from '../domain/lock-names.ts'
import { memoized } from '../domain/memo.ts'
import { agreementCurrencyOf, customerCurrencies } from './agreements.ts'
import { inCurrentPass, queuePass, runEventTableJob, type EventJobResult } from './chunked.ts'
import { glideToMs, nowGlide, nowMs } from './clock.ts'
import { queueJob, type JobEvent } from './events.ts'
import { EVENT } from '../domain/events.ts'
import { billableFees, billOnPeriod, markBilled, takeOffPeriod, visitOpenFees, visitWaivedFees, type FeeBilling } from './fees.ts'
import { findJobCursor, retirePass } from './job-cursor.ts'
import { attemptLock, whyNotRun } from './locks.ts'
import { deleteWhere, exists, findById, noneLeft, num, refusal, str, throwRefused } from './records.ts'
import { BILLING_PERIOD_STATUS, type BillingLineKind, SUBSCRIPTION_LINE_STATUS } from '../domain/vocabulary.ts'
import { log } from './log.ts'

/** Billing periods: generate, review, close (lock) and export (plan §13 Billing export, Q66). */

const PERIOD = 'x_daas_ham_billing_period'
const LINE = 'x_daas_ham_billing_line'

const LINE_KIND = { subscription: 'subscription', fee: 'fee' } as const satisfies { [Kind in BillingLineKind]: Kind }

/**
 * What became of an action on a period: done, or not done and why. `why` is '' when the platform has told the user
 * already: it refused the save of the form the action was used on. One done may leave something to put right by hand,
 * its `warning`.
 */
export type PeriodOutcome = { done: true; warning?: string } | { done: false; why: string }

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
    log.error(`Billing period ${month} not opened: ${refusal(period)}; create it by hand`)
}

/*
 * Generation. A period's generation passes replace each other on its job cursor `billing_generate_<sys_id>`
 * (ADR 0007, platform/chunked `PassJob`): the row names the current pass ('' once reset by hand), and its last run is
 * when that pass last started a chunk, its activity. No lock is taken: a pass starts where it is triggered.
 */

function generationJob(periodId: string): string {
    return `billing_generate_${periodId}`
}

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
        return void log.warn(`${queued.name}: dropped a generation chunk, as there is no billing period '${queued.subject}'`)
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
    log.warn(
        `Billing period ${str(period, 'period')}: dropped a generation chunk of a pass reset or replaced; if the period stays Generating, Reset generation and Regenerate it`,
    )
}

function billLines(period: GlideRecord, bounds: MonthBounds, queued: JobEvent, job: string): EventJobResult {
    const siteName = memoized(siteNameOf)
    const currencies = memoized(customerCurrencies)
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
            agreement: agreementCurrencyOf(line, 'agreement'),
        }),
        prepare: (lines: readonly LineRow[]) => withIntervals(lines, bounds),
        // Before the next chunk is queued: a line that could not be billed must not vanish from the bill, so a count
        // the period refuses stops the generation (held for review) instead of letting it finish as clean.
        flush: (failures) => {
            if (failures.failed === 0) return
            addFailedLines(period, failures.failed, failures.lastError)
            if (!period.update()) throwRefused(period, `${failures.failed} failed line(s) not counted`)
        },
        handle: (line, lineId) => {
            if (line.intervalsUnread) throw line.intervalsUnread.error
            // A line whose Agreement has no currency fails (counted on the period), so Close refuses until it is set.
            const currency = currencyOrThrow(chooseCurrency(line.agreement, () => currencies(line.customerId)))
            const terms = { ...line.terms, currency }
            for (const charge of subscriptionCharges(terms, bounds, { intervals: line.intervals, siteName })) {
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
                    currency: charge.currency,
                })
            }
        },
    })
}

function stopGeneration(period: GlideRecord, error: string): void {
    log.error(`Billing period ${str(period, 'period')}: generation stopped: ${error}`)
    period.setValue('last_error', error.slice(0, 255))
    // Refused, it stays generating with no chunk queued, which Close and Regenerate refuse: say why.
    if (!holdForReview(period)) {
        log.error(`Billing period ${str(period, 'period')} not held for review: ${refusal(period)}`)
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

function siteNameOf(siteId: string): string {
    const site = findById('cmn_location', siteId)
    return site ? str(site, 'name') : ''
}

interface LineRow {
    lineId: string
    terms: Omit<SubscriptionLineTerms, 'currency'>
    customerId: string
    agreementId: string
    agreement: AgreementCurrency | null
}

type BillableLine = LineRow & {
    intervals: readonly ServiceInterval[]
    /** Set when the line is billed from Service intervals that could not be read: it fails to bill with this error. */
    intervalsUnread?: { error: unknown }
}

function withIntervals(lines: readonly LineRow[], bounds: MonthBounds): BillableLine[] {
    try {
        const byLine = intervalsByLine(lines.filter((line) => billsFromIntervals(line.terms)).map((line) => line.lineId), bounds)
        return lines.map((line) => ({ ...line, intervals: byLine.get(line.lineId) ?? [] }))
    } catch (error) {
        return lines.map((line) => ({ ...line, intervals: [], intervalsUnread: billsFromIntervals(line.terms) ? { error } : undefined }))
    }
}

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

function insertLine(period: GlideRecord, values: BillingLineValues): void {
    const line = new GlideRecord(LINE)
    line.initialize()
    line.setValue('billing_period', period.getUniqueValue())
    for (const [field, value] of Object.entries(values)) line.setValue(field, value)
    if (!line.insert()) throwRefused(line, 'billing line not saved')
}

function addFailedLines(period: GlideRecord, failed: number, lastError: string): void {
    log.error(`Billing period ${str(period, 'period')}: ${failed} line(s) failed: ${lastError}`)
    period.setValue('failed_lines', num(period, 'failed_lines') + failed)
    period.setValue('last_error', lastError.slice(0, 255))
}

function finishGeneration(period: GlideRecord, bounds: MonthBounds): void {
    const fee = billableFees(period.getUniqueValue(), bounds.last)
    const billed = new Set<string>()
    let failed = 0
    let lastError = ''
    const currencies = memoized(customerCurrencies)
    while (fee.next()) {
        let billing: FeeBilling
        try {
            billing = billOnPeriod(fee, period.getUniqueValue(), (claimed) => {
                const customer = str(claimed, 'customer')
                // Its Agreement's currency (the fee's own Currency field is not used): a fee without one fails to bill.
                const currency = currencyOrThrow(chooseCurrency(agreementCurrencyOf(claimed, 'agreement'), () => currencies(customer)))
                insertLine(period, {
                    kind: LINE_KIND.fee,
                    customer,
                    agreement: str(claimed, 'agreement'),
                    fee_event: claimed.getUniqueValue(),
                    description: feeLabel(claimed),
                    units: 1,
                    amount: num(claimed, 'amount'),
                    currency,
                })
            })
        } catch (error) {
            // The fee stays open without a period, so a regeneration bills it.
            billing = { failed: messageOf(error) }
        }
        if (billing === 'billed') billed.add(fee.getUniqueValue())
        if (typeof billing === 'string') continue
        // Counted, so Close refuses: one unlinked after its line was added would not be marked billed, and a later
        // month would bill it again. Regenerate bills and links it.
        failed++
        lastError = `${fee.getUniqueValue()}: ${billing.failed}`
    }
    // A fee an earlier pass linked that this one did not bill (its date moved past the month, it failed): Close would
    // mark it billed with no line, and no later month bills a fee linked here.
    visitOpenFees(period.getUniqueValue(), (linked) => {
        if (billed.has(linked.getUniqueValue())) return
        const kept = takeOffPeriod(linked)
        if (!kept) return
        failed++
        lastError = `${linked.getUniqueValue()}: fee not taken off the period it is no longer billed on: ${kept}`
    })
    if (failed > 0) addFailedLines(period, failed, lastError)
    period.setValue('generated_at', nowGlide())
    // Refused, it stays generating, which Close and Regenerate refuse: say why.
    if (!holdForReview(period)) {
        log.error(`Billing period ${str(period, 'period')} not saved as ready: ${refusal(period)}`)
    }
}

function setTotals(period: GlideRecord): void {
    const totals = totalsOf([period.getUniqueValue()]).get(period.getUniqueValue()) ?? []
    period.setValue('line_count', totals.reduce((lines, total) => lines + total.lines, 0))
    period.setValue('totals', totalsText(totals))
    period.setValue('total_amount', singleCurrencyTotal(totals) ?? '')
}

function totalsOf(periodIds: readonly string[]): Map<string, CurrencyTotal[]> {
    const groups = new Map<string, CurrencyTotal[]>()
    if (periodIds.length === 0) return groups
    const ga = new GlideAggregate(LINE)
    ga.addEncodedQuery(`billing_periodIN${periodIds.join(',')}`)
    ga.addAggregate('COUNT', '')
    ga.addAggregate('SUM', 'amount')
    ga.groupBy('billing_period')
    ga.groupBy('currency')
    ga.query()
    while (ga.next()) {
        appendTo(groups, String(ga.getValue('billing_period') ?? ''), {
            currency: String(ga.getValue('currency') ?? ''),
            lines: Number(ga.getAggregate('COUNT', '')) || 0,
            amount: Number(ga.getAggregate('SUM', 'amount')) || 0,
        })
    }
    return new Map([...groups].map(([periodId, rows]) => [periodId, currencyTotals(rows)]))
}

function feeLabel(fee: GlideRecord): string {
    return `${fee.getDisplayValue('fee_type')} fee: ${fee.getDisplayValue('asset')} (${str(fee, 'occurred_on')})`
}

/**
 * Run a Close or Regenerate of `period` under the period's lock, with the period as stored there, so the two take
 * turns: `period` was read before the action ran, and a Regenerate that deleted the lines meanwhile would leave Close to
 * lock a period without them (the closed-period rule checks the status as `period` read it). A period held through every
 * try is not acted on.
 */
function takingTurns(period: GlideRecord, undone: string, act: (stored: GlideRecord) => PeriodOutcome): PeriodOutcome {
    const attempt = attemptLock(LOCK.billingPeriod(period.getUniqueValue()), () => {
        const stored = findById(PERIOD, period.getUniqueValue())
        return stored ? act(stored) : notDone(`${str(period, 'period')} ${undone}: the period is gone`)
    })
    if (attempt.ran) return attempt.value
    return notDone(`${str(period, 'period')} ${undone}: ${whyNotRun(attempt, 'a Close or Regenerate of it is running; try again')}`)
}

export function regeneratePeriod(period: GlideRecord): PeriodOutcome {
    return takingTurns(period, 'not regenerated', (stored) => {
        if (str(stored, 'status') !== BILLING_PERIOD_STATUS.ready) return notDone('Only a period ready for review can be regenerated')
        return regenerateReady(period)
    })
}

function regenerateReady(period: GlideRecord): PeriodOutcome {
    period.setValue('status', BILLING_PERIOD_STATUS.generating)
    period.setValue('failed_lines', 0)
    period.setValue('last_error', '')
    // Saved first: a refused form save (the platform says why) keeps the period ready with its lines, not without them.
    if (!period.update()) return notDone('')
    // Lines the delete left would be billed twice by the new generation.
    if (!dropLinesForRegeneration(period)) {
        const name = str(period, 'period')
        period.setValue('status', BILLING_PERIOD_STATUS.ready)
        period.setValue('last_error', 'Regenerate could not remove all of the old lines; remove them and Regenerate again')
        if (period.update()) return notDone(`${name} not regenerated: some of its old lines could not be removed`)
        // Refused, it stays generating with nothing queued, which Close and Regenerate refuse: say so, and how it ends.
        const why = refusal(period)
        log.error(`Billing period ${name}: Regenerate left old lines and the period was not held for review: ${why}`)
        return notDone(
            `${name} not regenerated: some of its old lines could not be removed, and it could not be held for review (${why}). It stays Generating with nothing queued: an admin can Reset generation once it has shown no activity for ${RESET_AFTER_IDLE_MINUTES} minutes, then Regenerate`,
        )
    }
    // The period's open fees stay linked to it: the generation bills them again, or takes off those it no longer bills (finishGeneration).
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

/**
 * Close a period ready for review: lock it and mark its fees billed. Its export and margin are for the caller to queue.
 * A closed period whose fees were not all marked billed is done, with a warning that names them.
 */
export function closePeriod(period: GlideRecord): PeriodOutcome {
    return takingTurns(period, 'not closed', (stored) => closeReady(period, stored))
}

/** Close `period`, judged by how it is `stored` now: a Regenerate since `period` was read may have found lines failing. */
function closeReady(period: GlideRecord, stored: GlideRecord): PeriodOutcome {
    if (str(stored, 'status') !== BILLING_PERIOD_STATUS.ready) return notDone('Only a period ready for review can be closed')
    const name = str(period, 'period')
    const failed = num(stored, 'failed_lines')
    const lastError = str(stored, 'last_error')
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
    const unmarked = markFeesBilled(period)
    if (unmarked.length === 0) return DONE
    const named = unmarked.slice(0, 3).join('; ') + (unmarked.length > 3 ? `; and ${unmarked.length - 3} more (see the system log)` : '')
    return { done: true, warning: `${unmarked.length} fee(s) billed in ${name} could not be marked billed: ${named}. Set them to Billed by hand` }
}

/**
 * Mark the closed period's open fees billed (platform/fees `markBilled`). A fee the platform refuses stays open but
 * linked to the closed period, which no later generation bills (it bills unlinked fees) and Close cannot be run again
 * for: it is returned named with why, and logged, to set to Billed by hand.
 */
function markFeesBilled(period: GlideRecord): string[] {
    const refused: string[] = []
    markBilled(period.getUniqueValue(), (fee, why) => refused.push(`${feeLabel(fee)}: ${why}`))
    if (refused.length > 0) {
        const unmarked = `${refused.length} fee(s) not marked billed; set them to Billed by hand`
        log.error(`Billing period ${str(period, 'period')} closed, but ${unmarked}: ${refused.join('; ')}`)
    }
    return refused
}

export function queueExport(period: GlideRecord): void {
    queueJob(EVENT.billingExport, period)
}

type ExportState = { state: 'not_closed' } | { state: 'attached'; fileName: string } | { state: 'missing'; fileName: string }

function exportState(period: GlideRecord): ExportState {
    if (str(period, 'status') !== BILLING_PERIOD_STATUS.closed) return { state: 'not_closed' }
    const fileName = `billing-${str(period, 'period')}.csv`
    return { state: exists('sys_attachment', exportQuery(period, fileName)) ? 'attached' : 'missing', fileName }
}

export type ExportRequest = { queued: true } | { queued: false; why: 'not_closed' } | { queued: false; why: 'attached'; fileName: string }

/** Re-export CSV: queue the export of a closed period whose file is missing (never saves the period). */
export function requestExport(period: GlideRecord): ExportRequest {
    const found = exportState(period)
    if (found.state === 'not_closed') return { queued: false, why: 'not_closed' }
    if (found.state === 'attached') return { queued: false, why: 'attached', fileName: found.fileName }
    queueExport(period)
    return { queued: true }
}

/**
 * Attach the CSV of a closed period's lines unless it is already attached. Only reads the period, so the
 * closed-period lock is not hit. Two exports racing each other converge on one file: each keeps only the oldest copy.
 * A failure is logged as an error naming the period, and Re-export CSV can be used once it is fixed.
 */
export function attachExport(periodId: string): void {
    const period = findById(PERIOD, periodId)
    if (!period) return
    const found = exportState(period)
    if (found.state !== 'missing') return
    const { fileName } = found
    try {
        const rows: Array<Array<string | number>> = [billingCsvHeader()]
        const stored = lineReader()
        const line = linesOf(periodId)
        line.query()
        while (line.next()) rows.push(billingCsvRow(str(period, 'period'), stored(line)))
        new GlideSysAttachment().write(period, fileName, 'text/csv', toCsv(rows))
        keepOldestExport(period, fileName)
    } catch (error) {
        log.error(`CSV export of billing period ${str(period, 'period')} failed: ${messageOf(error)}`)
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

function linesOf(periodId: string): GlideRecord {
    const line = new GlideRecord(LINE)
    line.addQuery('billing_period', periodId)
    line.orderBy('customer')
    line.orderBy('sys_id')
    return line
}

function lineReader(): (line: GlideRecord) => StoredBillingLine {
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

/*
 * What the billing pull API answers (finance and the ERP integration read it; no page of the app does, so the shapes
 * are declared here and not in domain/rest-contracts).
 */

/** GET /billing_periods: the most recent periods, newest first. */
export interface BillingPeriodList {
    /** `totals` is per currency, from the lines: amounts of two currencies are never added. */
    periods: Array<{ id: string; period: string; status: string; lines: number; totals: CurrencyTotal[] }>
}

/** GET /billing_periods/{id}/lines: one page of a period's lines. */
export interface BillingLinesPage {
    period: string
    status: string
    /** Whether the period is closed: its lines no longer change. */
    final: boolean
    totals: CurrencyTotal[]
    offset: number
    lines: Array<ReturnType<typeof billingLineJson>>
    /** Where the next page starts; null after the last one. */
    nextOffset: number | null
}

export function recentPeriods(limit: number): BillingPeriodList {
    const period = new GlideRecord(PERIOD)
    period.orderByDesc('period')
    period.setLimit(limit)
    period.query()
    const periods: Array<Omit<BillingPeriodList['periods'][number], 'totals'>> = []
    while (period.next()) {
        periods.push({ id: period.getUniqueValue(), period: str(period, 'period'), status: str(period, 'status'), lines: num(period, 'line_count') })
    }
    const totals = totalsOf(periods.map((row) => row.id))
    return { periods: periods.map((row) => ({ ...row, totals: totals.get(row.id) ?? [] })) }
}

/** One page of a period's lines as the pull API gives it (a closed period's are final), or null for an unknown period. */
export function linesPage(periodId: string, offset: number, limit: number): BillingLinesPage | null {
    const period = findById(PERIOD, periodId)
    if (!period) return null
    const stored = lineReader()
    const line = linesOf(periodId)
    line.chooseWindow(offset, offset + limit, false)
    line.query()
    const lines: BillingLinesPage['lines'] = []
    while (line.next()) lines.push(billingLineJson(line.getUniqueValue(), stored(line)))
    return {
        period: str(period, 'period'),
        status: str(period, 'status'),
        final: str(period, 'status') === BILLING_PERIOD_STATUS.closed,
        totals: totalsOf([periodId]).get(periodId) ?? [],
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
    if (!period.update()) throwRefused(period, 'Margin status not saved')
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
    const lines = `billing_period=${period.getUniqueValue()}`
    const line = new GlideRecord(LINE)
    line.addEncodedQuery(lines)
    line.setWorkflow(false)
    line.deleteMultiple()
    return noneLeft(LINE, lines)
}
