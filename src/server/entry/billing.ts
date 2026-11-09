// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.
import { GlideAggregate, GlideRecord, GlideSysAttachment, gs } from '@servicenow/glide'
import type { RESTAPIRequest, RESTAPIResponse } from '@servicenow/glide/sn_ws_int'
import {
    billingMonthProblem,
    billsFromIntervals,
    decideGenerationReset,
    generationEventParm,
    isCurrentGeneration,
    monthBounds,
    overlapsMonth,
    previousMonth,
    readGenerationEventParm,
    RESET_AFTER_IDLE_MINUTES,
    resetGenerationError,
    subscriptionCharges,
    toCsv,
    type GenerationEventParm,
    type MonthBounds,
    type ServiceInterval,
    type SubscriptionLineTerms,
} from '../domain/billing'
import { appendTo } from '../domain/collections'
import { memoized } from '../domain/memo'
import { ROLE } from '../domain/visibility'
import { RowFailure, runEventTableJob } from '../platform/chunked'
import { glideToMs, msToGlide, nowMs, todayIso } from '../platform/clock'
import { EVENT, fire } from '../platform/events'
import { deleteWhere, exists, findById, num, refusal, str } from '../platform/records'
import { queryInt, reply } from '../platform/rest-api'

/** Billing periods: generate, review, close (lock) and export (P3.25, D66). */

/**
 * Monthly (day 1): open last month's Billing period unless it exists. Its insert rules set its days and start its
 * generation, as for a period created by hand, so each new period is generated once.
 */
export function openMonthlyBillingPeriod(): void {
    const month = previousMonth(todayIso())
    const existing = new GlideRecord('x_daas_ham_billing_period')
    if (existing.get('period', month)) return
    const period = new GlideRecord('x_daas_ham_billing_period')
    period.initialize()
    period.setValue('period', month)
    period.setValue('status', 'generating')
    if (period.insert()) return
    // No later run opens this month, so a refused one would go unbilled unseen.
    gs.error(`[x_daas_ham] Billing period ${month} not opened: ${refusal(period)}; create it by hand`)
}

/**
 * After insert rule on billing periods still generating (the monthly job's or one made by hand): generate it. A pass
 * that cannot be started is held for review with why, as a generation that stops is.
 */
export function startBillingPeriodGeneration(current: GlideRecord): void {
    try {
        queueGeneration(current)
    } catch (error) {
        const period = findById('x_daas_ham_billing_period', current.getUniqueValue())
        if (period) stopGeneration(period, `generation not started: ${messageOf(error)}`)
    }
}

/**
 * Script action on x_daas_ham.billing.generate (parm1 = period and pass, parm2 = cursor): one chunk of a pass over the
 * Subscription lines active in the month. A chunk of a pass that was reset or replaced since is dropped. A chunk that
 * cannot run (e.g. a month saved past the month rule) stops the pass and holds the period for review.
 */
export function generateBillingLines(event: GlideRecord, current: GlideRecord): void {
    const parm1 = str(event, 'parm1')
    const pass = readGenerationEventParm(parm1)
    const period = findById('x_daas_ham_billing_period', pass.periodId)
    if (!period || str(period, 'status') !== 'generating') return
    try {
        if (!startChunk(pass)) return void dropChunk(period)
        generateChunk(period, pass, parm1, str(event, 'parm2'), current)
    } catch (error) {
        // A pass reset or replaced meanwhile must not hold the period, which may be generating afresh by now.
        if (!isCurrentPass(pass)) return void dropChunk(period)
        stopGeneration(period, messageOf(error))
    }
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

/*
 * A period's generation passes are tracked on its job cursor `billing_generate_<sys_id>` (ADR 0007): `cursor` holds the
 * current pass's token ('' once reset by hand) and `last_run` when that pass last started a chunk, its activity. Each
 * chunk's position still travels in its event's parm2.
 */

function generationJob(periodId: string): string {
    return `billing_generate_${periodId}`
}

function generationCursor(periodId: string): GlideRecord | null {
    const row = new GlideRecord('x_daas_ham_job_cursor')
    return row.get('job', generationJob(periodId)) ? row : null
}

/**
 * Start a new pass of the period's generation and queue its first chunk. The chunks still queued of any earlier pass
 * (one reset by hand) are dropped from then on. Throws (with why) when the pass cannot be recorded.
 */
function queueGeneration(period: GlideRecord): void {
    const periodId = period.getUniqueValue()
    const token = String(nowMs())
    recordPass(periodId, token)
    fire(EVENT.billingGenerate, period, generationEventParm({ periodId, token }))
}

/** Make `token` the period's current pass, active now, on its job cursor (created on its first pass). */
function recordPass(periodId: string, token: string): void {
    const job = generationJob(periodId)
    let row = generationCursor(periodId)
    if (!row) {
        const created = new GlideRecord('x_daas_ham_job_cursor')
        created.initialize()
        created.setValue('job', job)
        setPass(created, token)
        if (created.insert()) return
        // Another start inserted it first (the unique index on job): this pass replaces that one on its row.
        row = generationCursor(periodId)
        if (!row) throw new Error(`job cursor ${job} not created: ${refusal(created)}`)
    }
    setPass(row, token)
    if (!row.update()) throw new Error(`job cursor ${job} not saved: ${refusal(row)}`)
}

function setPass(row: GlideRecord, token: string): void {
    row.setValue('cursor', token)
    row.setValue('last_run', msToGlide(nowMs()))
    // Not 'generating': nothing marks the row as the pass ends, so it would read as stalled; the period has the state.
    row.setValue('last_status', 'pass started')
}

function isCurrentPass(pass: GenerationEventParm): boolean {
    const row = generationCursor(pass.periodId)
    return row !== null && isCurrentGeneration(str(row, 'cursor'), pass.token)
}

/**
 * As a chunk starts: record its pass's activity, then check that it is still the current pass. Recorded before the
 * check, so a Reset generation that retires the pass meanwhile sees it and leaves the period generating. Throws when
 * the activity is refused: a pass that cannot show activity could be reset while it runs.
 */
function startChunk(pass: GenerationEventParm): boolean {
    const row = generationCursor(pass.periodId)
    if (!row) return false
    row.setValue('last_run', msToGlide(nowMs()))
    if (!row.update()) throw new Error(`generation activity not recorded: ${refusal(row)}`)
    return isCurrentPass(pass)
}

function dropChunk(period: GlideRecord): void {
    gs.warn(
        `[x_daas_ham] Billing period ${str(period, 'period')}: dropped a generation chunk of a pass reset or replaced (or queued before passes were tracked); if the period stays Generating, Reset generation and Regenerate it`,
    )
}

/** Bill the next chunk of the period's Subscription lines after `cursor`, then finish the period once the last one is billed. */
function generateChunk(
    period: GlideRecord,
    pass: GenerationEventParm,
    parm1: string,
    cursor: string,
    current: GlideRecord,
): void {
    const bounds = monthBounds(str(period, 'period'))
    const siteName = memoized(siteNameOf)
    const result = runEventTableJob({
        eventName: EVENT.billingGenerate,
        record: current,
        parm1,
        cursor,
        table: 'x_daas_ham_subscription_line',
        query: `status!=pending^${overlapsMonth(bounds)}`,
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
        // the period refuses stops the generation (held for review) instead of letting it finish as clean. A pass reset
        // during the chunk neither queues the next nor finishes the period.
        flush: (failures) => {
            if (!isCurrentPass(pass)) throw new Error('its generation pass was reset or replaced')
            if (failures.failed === 0) return
            addFailedLines(period, failures.failed, failures.lastError)
            if (!period.update()) throw new Error(`${failures.failed} failed line(s) not counted: ${refusal(period)}`)
        },
        handle: (line, lineId) => {
            for (const charge of subscriptionCharges(line.terms, bounds, { intervals: line.intervals, siteName })) {
                insertLine(period, {
                    kind: 'subscription',
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
    if (result.done) finishGeneration(period, bounds)
}

/**
 * Hold a period whose generation stopped for review, recording why and totalling the lines written so far (saves it):
 * Close period refuses until a Regenerate completes.
 */
function stopGeneration(period: GlideRecord, error: string): void {
    gs.error(`[x_daas_ham] Billing period ${str(period, 'period')}: generation stopped: ${error}`)
    period.setValue('last_error', error.slice(0, 255))
    // A Regenerate keeps the previous totals until the end, so a held period must not show them against its new lines.
    setTotals(period)
    period.setValue('status', 'ready')
    // Refused, it stays generating with no chunk queued, which Close and Regenerate refuse: say why.
    if (!period.update()) {
        gs.error(`[x_daas_ham] Billing period ${str(period, 'period')} not held for review: ${refusal(period)}`)
    }
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
type BillableLine = LineRow & { intervals: readonly ServiceInterval[] }

/**
 * The batch's lines with their Service intervals in the month (none for a line not billed from them), read with
 * one aggregate for the whole batch. If that read fails, only the lines billed from intervals fail, so the others still bill.
 */
function withIntervals(lines: readonly LineRow[], bounds: MonthBounds): Array<BillableLine | RowFailure> {
    try {
        const byLine = intervalsByLine(lines.filter((line) => billsFromIntervals(line.terms)).map((line) => line.lineId), bounds)
        return lines.map((line) => ({ ...line, intervals: byLine.get(line.lineId) ?? [] }))
    } catch (error) {
        return lines.map((line) => (billsFromIntervals(line.terms) ? new RowFailure(error) : { ...line, intervals: [] }))
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
function insertLine(period: GlideRecord, values: { [field: string]: string | number }): void {
    const line = new GlideRecord('x_daas_ham_billing_line')
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
    const fee = new GlideRecord('x_daas_ham_fee_event')
    fee.addQuery('status', 'open')
    // Not yet billed, or already linked to this period by a generation its Regenerate rebuilds.
    fee.addEncodedQuery(`billing_periodISEMPTY^ORbilling_period=${period.getUniqueValue()}`)
    fee.addQuery('occurred_on', '<=', bounds.last)
    fee.query()
    let failed = 0
    let lastError = ''
    while (fee.next()) {
        try {
            insertLine(period, {
                kind: 'fee',
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
            lastError = `${fee.getUniqueValue()}: ${error instanceof Error ? error.message : String(error)}`
            continue
        }
        fee.setValue('billing_period', period.getUniqueValue())
        if (fee.update()) continue
        // Unlinked, Close would not mark it billed and a later month would bill it again: Regenerate links it.
        failed++
        lastError = `${fee.getUniqueValue()}: fee not linked to the period: ${refusal(fee)}`
    }
    if (failed > 0) addFailedLines(period, failed, lastError)
    setTotals(period)
    period.setValue('generated_at', msToGlide(nowMs()))
    period.setValue('status', 'ready')
    // Refused, it stays generating, which Close and Regenerate refuse: say why.
    if (!period.update()) {
        gs.error(`[x_daas_ham] Billing period ${str(period, 'period')} not saved as ready: ${refusal(period)}`)
    }
}

/** Line count and total of the period (does not save). */
function setTotals(period: GlideRecord): void {
    const totals = new GlideAggregate('x_daas_ham_billing_line')
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

/**
 * Fee lines whose fee was waived after generation (e.g. a missing unit turned up) are not billed: their lines are
 * deleted and the fees leave the period (does not redo the totals). Returns each fee that could not leave it, named
 * with why, for Close to refuse with; a retry finds them again. Only called while the period is still ready for
 * review, so the closed-line guard lets the lines go.
 */
function dropWaivedFeeLines(period: GlideRecord): string[] {
    const stuck: string[] = []
    // In pages, in sys_id order, so the loop ends even if a fee cannot leave the period.
    let after = ''
    for (;;) {
        const fee = new GlideRecord('x_daas_ham_fee_event')
        fee.addEncodedQuery(`billing_period=${period.getUniqueValue()}^status=waived${after ? `^sys_id>${after}` : ''}`)
        fee.orderBy('sys_id')
        fee.setLimit(500)
        fee.query()
        if (!fee.hasNext()) return stuck
        while (fee.next()) {
            after = fee.getUniqueValue()
            // Lines first, by the fee's id (a set-based delete is not relied on to follow a dot-walked condition).
            // A fee whose line survives stays on the period: unlinked, the closed period would keep a line it no
            // longer bills.
            const lines = `billing_period=${period.getUniqueValue()}^kind=fee^fee_event=${after}`
            if (!deleteWhere('x_daas_ham_billing_line', lines)) {
                stuck.push(`${feeLabel(fee)}: its billing line could not be removed`)
                continue
            }
            // Per record: updateMultiple does not reliably clear a reference to empty.
            fee.setValue('billing_period', '')
            if (!fee.update()) stuck.push(`${feeLabel(fee)}: ${refusal(fee)}`)
        }
    }
}

/** UI action "Regenerate" on a period ready for review: rebuild its lines from current data. */
export function uiRegenerateBillingPeriod(current: GlideRecord): void {
    if (str(current, 'status') !== 'ready') return void gs.addErrorMessage('Only a period ready for review can be regenerated')
    current.setValue('status', 'generating')
    current.setValue('failed_lines', 0)
    current.setValue('last_error', '')
    // Saved first: a refused form save (the platform says why) keeps the period ready with its lines, not without them.
    if (!current.update()) return
    // Without business rules: the period is generating, not closed, so the closed-line guard has nothing to stop.
    // Lines the delete left would be billed twice by the new generation.
    const lines = `billing_period=${current.getUniqueValue()}`
    if (!deleteWhere('x_daas_ham_billing_line', lines, { businessRules: false })) {
        current.setValue('status', 'ready')
        current.setValue('last_error', 'Regenerate could not remove all of the old lines; remove them and Regenerate again')
        current.update()
        return void gs.addErrorMessage(`${str(current, 'period')} not regenerated: some of its old lines could not be removed`)
    }
    // The period's open fees stay linked to it: the generation bills them again (finishGeneration).
    try {
        queueGeneration(current)
    } catch (error) {
        stopGeneration(current, `generation not started: ${messageOf(error)}`)
        return void gs.addErrorMessage(`${str(current, 'period')} not regenerated: ${messageOf(error)}`)
    }
    gs.addInfoMessage(`Regenerating ${str(current, 'period')}`)
}

/**
 * UI action "Reset generation" (admin) on a period stuck generating: hold it for review with the reset as its error, so
 * Close period refuses until a Regenerate bills it afresh. It deletes and bills nothing, and only resets a generation
 * that has shown no activity for 30 minutes (domain/billing `decideGenerationReset`): the period's own last save, or
 * its pass's last chunk start on the job cursor. The pass is retired first, so a chunk of it still queued is dropped,
 * even once a Regenerate has the period generating again. A chunk that starts as the pass is retired may have found it
 * still current; the period then stays generating, so nothing can be regenerated beside that chunk until it is done.
 */
export function uiResetBillingGeneration(current: GlideRecord): void {
    if (!gs.hasRole(ROLE.admin)) return void gs.addErrorMessage('Only an admin can reset a generation')
    const name = str(current, 'period')
    const periodId = current.getUniqueValue()
    const cursor = generationCursor(periodId)
    const lastChunk = cursor ? str(cursor, 'last_run') : ''
    const activity = [glideToMs(str(current, 'sys_updated_on')), glideToMs(lastChunk)]
    const decision = decideGenerationReset(str(current, 'status'), activity, nowMs())
    if (!decision.reset) return void gs.addErrorMessage(`${name} not reset: ${decision.why}`)
    // Without a cursor no pass was recorded, and chunks of none are dropped (startChunk): nothing is left to retire.
    if (cursor) {
        // Its activity is left as it was, so a chunk that starts from now on shows on the read below.
        cursor.setValue('cursor', '')
        cursor.setValue('last_status', 'reset by hand')
        if (!cursor.update()) {
            return void gs.addErrorMessage(`${name} not reset: its generation could not be stopped: ${refusal(cursor)}`)
        }
        if (str(generationCursor(periodId) ?? cursor, 'last_run') !== lastChunk) {
            return void gs.addErrorMessage(
                `${name} not reset: a chunk of its generation started as it was being reset. Its generation is stopped and the period stays Generating until that chunk is done: Reset generation again in ${RESET_AFTER_IDLE_MINUTES} minutes`,
            )
        }
    }
    current.setValue('status', 'ready')
    current.setValue('last_error', resetGenerationError(gs.getUserDisplayName(), decision.idleMinutes))
    // As when a generation stops: the totals of an earlier generation do not match the lines written so far.
    setTotals(current)
    // Refused (the platform says why), it stays generating with its pass retired: Reset generation again.
    if (!current.update()) return
    gs.addInfoMessage(`${name} is ready for review, reset by hand: Regenerate it before closing`)
}

const CSV_HEADER = ['period', 'kind', 'customer', 'agreement', 'subscription_line', 'site', 'description', 'units', 'monthly_rate', 'amount', 'currency']

/** UI action "Close period": lock it, mark its fees billed, then export its CSV and compute its margin in the background. */
export function uiCloseBillingPeriod(current: GlideRecord): void {
    if (str(current, 'status') !== 'ready') return void gs.addErrorMessage('Only a period ready for review can be closed')
    const failed = num(current, 'failed_lines')
    const lastError = str(current, 'last_error')
    if (failed > 0 || lastError) {
        return void gs.addErrorMessage(
            `${str(current, 'period')} did not generate cleanly (${failed} line(s) failed to bill; last error: ${lastError || 'none'}); fix the cause and Regenerate before closing`,
        )
    }
    const stuck = dropWaivedFeeLines(current)
    if (stuck.length > 0) {
        const named = stuck.slice(0, 3).join('; ') + (stuck.length > 3 ? `; and ${stuck.length - 3} more` : '')
        return void gs.addErrorMessage(
            `${str(current, 'period')} not closed, as ${stuck.length} waived fee(s) could not leave it: ${named}. Fix them and Close again`,
        )
    }
    // Always: finance may have adjusted lines during review, and the locked total must match the locked lines.
    setTotals(current)
    current.setValue('status', 'closed')
    current.setValue('closed_at', msToGlide(nowMs()))
    current.setValue('closed_by', gs.getUserID())
    // Closed first: a refused form save (the platform says why) leaves its fees open, so a Regenerate still bills them.
    if (!current.update()) return
    const fees = new GlideRecord('x_daas_ham_fee_event')
    fees.addQuery('billing_period', current.getUniqueValue())
    fees.addQuery('status', 'open')
    fees.setValue('status', 'billed')
    fees.updateMultiple()
    fire(EVENT.billingExport, current, current.getUniqueValue())
    fire(EVENT.marginCompute, current, current.getUniqueValue())
    gs.addInfoMessage(`${str(current, 'period')} closed and locked; the CSV export and margin are being prepared`)
}

/** UI action "Re-export CSV" on a closed period whose export is missing (never saves the period). */
export function uiExportBillingPeriod(current: GlideRecord): void {
    if (str(current, 'status') !== 'closed') return void gs.addErrorMessage('Only a closed period can be exported')
    const fileName = exportFileName(current)
    if (hasAttachment(current, fileName)) return void gs.addInfoMessage(`${fileName} is already attached; delete it to export again`)
    fire(EVENT.billingExport, current, current.getUniqueValue())
    gs.addInfoMessage(`The CSV export of ${str(current, 'period')} is being prepared`)
}

/**
 * Script action on x_daas_ham.billing.export (parm1 = period): attach the CSV of a closed period's
 * lines unless it is already attached. Only reads the period, so the closed-period lock is not hit.
 * Two exports racing each other converge on one file: each keeps only the oldest copy. A failure is
 * logged as an error naming the period, and Re-export CSV can be used once it is fixed.
 */
export function exportBillingPeriod(event: GlideRecord): void {
    const period = findById('x_daas_ham_billing_period', str(event, 'parm1'))
    if (!period || str(period, 'status') !== 'closed') return
    const fileName = exportFileName(period)
    if (hasAttachment(period, fileName)) return
    try {
        const rows: Array<Array<string | number>> = [CSV_HEADER]
        const display = referenceDisplay()
        const line = linesOf(period.getUniqueValue())
        while (line.next()) rows.push(csvRow(period, line, display))
        new GlideSysAttachment().write(period, fileName, 'text/csv', toCsv(rows))
        keepOldestExport(period, fileName)
    } catch (error) {
        gs.error(`[x_daas_ham] CSV export of billing period ${str(period, 'period')} failed: ${error instanceof Error ? error.message : String(error)}`)
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

function exportFileName(period: GlideRecord): string {
    return `billing-${str(period, 'period')}.csv`
}

function exportQuery(period: GlideRecord, fileName: string): string {
    return `table_name=x_daas_ham_billing_period^table_sys_id=${period.getUniqueValue()}^file_name=${fileName}`
}

function hasAttachment(period: GlideRecord, fileName: string): boolean {
    return exists('sys_attachment', exportQuery(period, fileName))
}

function linesOf(periodId: string, offset = 0, limit = 0): GlideRecord {
    const line = new GlideRecord('x_daas_ham_billing_line')
    line.addQuery('billing_period', periodId)
    line.orderBy('customer')
    line.orderBy('sys_id')
    if (limit > 0) line.chooseWindow(offset, offset + limit, false)
    line.query()
    return line
}

/** A line's reference display value, looked up once per referenced record. */
type ReferenceDisplay = (line: GlideRecord, field: 'customer' | 'agreement' | 'subscription_line' | 'site') => string

function referenceDisplay(): ReferenceDisplay {
    // Keyed by the referenced record; the first line seen for it supplies the display value.
    const cache = new Map<string, string>()
    return (line, field) => {
        const key = `${field}|${str(line, field)}`
        if (!cache.has(key)) cache.set(key, line.getDisplayValue(field))
        return cache.get(key) ?? ''
    }
}

function csvRow(period: GlideRecord, line: GlideRecord, display: ReferenceDisplay): Array<string | number> {
    return [
        str(period, 'period'),
        str(line, 'kind'),
        display(line, 'customer'),
        display(line, 'agreement'),
        display(line, 'subscription_line'),
        display(line, 'site'),
        str(line, 'description'),
        num(line, 'units'),
        num(line, 'monthly_rate'),
        num(line, 'amount'),
        str(line, 'currency'),
    ]
}

/**
 * Before update/delete rule on billing lines: a closed period's lines never change. The dot-walk on current follows
 * the period being saved, so an update moving the line to another period also checks the stored one: no line leaves
 * a closed period.
 */
export function guardClosedBillingLine(current: GlideRecord, previous: GlideRecord): void {
    const statuses = [str(current, 'billing_period.status')]
    if (current.operation() === 'update' && str(previous, 'billing_period') !== str(current, 'billing_period')) {
        statuses.push(str(previous, 'billing_period.status'))
    }
    if (!statuses.includes('closed')) return
    gs.addErrorMessage('This billing period is closed; its lines cannot change')
    current.setAbortAction(true)
}

/**
 * Before insert/update rule on billing periods (when the month changes): the month is billed only as YYYY-MM and once
 * it has ended (domain/billing `billingMonthProblem`), and the period's first and last day follow it (a period created
 * by hand has them too).
 */
export function guardBillingPeriodMonth(current: GlideRecord): void {
    const month = str(current, 'period')
    const problem = billingMonthProblem(month, todayIso())
    if (!problem) {
        const bounds = monthBounds(month)
        current.setValue('period_start', bounds.first)
        current.setValue('period_end', bounds.last)
        return
    }
    gs.addErrorMessage(problem)
    current.setAbortAction(true)
}

/** Before update/delete rule on billing periods: a closed period is locked (the margin computation saves its own status fields without this rule). */
export function guardClosedBillingPeriod(current: GlideRecord, previous: GlideRecord): void {
    if (str(previous ?? current, 'status') !== 'closed') return
    gs.addErrorMessage('This billing period is closed and locked')
    current.setAbortAction(true)
}

function canPull(): boolean {
    return gs.hasRole(ROLE.finance) || gs.hasRole(ROLE.integration)
}

/** GET /billing_periods: the most recent periods. */
export function listBillingPeriods(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!canPull()) return reply(response, 403, { error: 'Requires the finance or integration role' })
    const period = new GlideRecord('x_daas_ham_billing_period')
    period.orderByDesc('period')
    period.setLimit(Math.min(Math.max(queryInt(request, 'limit', 24), 1), 120))
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
    reply(response, 200, { periods })
}

/** GET /billing_periods/{id}/lines?offset&limit: one page of a period's lines (closed periods are final). */
export function getBillingLines(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!canPull()) return reply(response, 403, { error: 'Requires the finance or integration role' })
    const period = findById('x_daas_ham_billing_period', String(request.pathParams.id ?? ''))
    if (!period) return reply(response, 404, { error: 'Unknown billing period' })
    const offset = queryInt(request, 'offset', 0)
    const limit = Math.min(Math.max(queryInt(request, 'limit', 1000), 1), 5000)
    const display = referenceDisplay()
    const line = linesOf(period.getUniqueValue(), offset, limit)
    const lines: object[] = []
    while (line.next()) {
        lines.push({
            id: line.getUniqueValue(),
            kind: str(line, 'kind'),
            customerId: str(line, 'customer'),
            customer: display(line, 'customer'),
            agreement: display(line, 'agreement'),
            subscriptionLine: str(line, 'subscription_line'),
            siteId: str(line, 'site'),
            site: display(line, 'site'),
            feeEvent: str(line, 'fee_event'),
            description: str(line, 'description'),
            units: num(line, 'units'),
            monthlyRate: num(line, 'monthly_rate'),
            amount: num(line, 'amount'),
            currency: str(line, 'currency'),
        })
    }
    reply(response, 200, {
        period: str(period, 'period'),
        status: str(period, 'status'),
        final: str(period, 'status') === 'closed',
        total: num(period, 'total_amount'),
        offset,
        lines,
        nextOffset: lines.length === limit ? offset + limit : null,
    })
}
