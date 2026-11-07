// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.
import { GlideAggregate, GlideRecord, GlideSysAttachment, gs } from '@servicenow/glide'
import type { RESTAPIRequest, RESTAPIResponse } from '@servicenow/glide/sn_ws_int'
import {
    billingMonthProblem,
    billsFromIntervals,
    monthBounds,
    overlapsMonth,
    previousMonth,
    subscriptionCharges,
    toCsv,
    type MonthBounds,
    type ServiceInterval,
    type SubscriptionLineTerms,
} from '../domain/billing'
import { appendTo } from '../domain/collections'
import { memoized } from '../domain/memo'
import { ROLE } from '../domain/visibility'
import { RowFailure, runEventTableJob } from '../platform/chunked'
import { msToGlide, nowMs, todayIso } from '../platform/clock'
import { EVENT, fire } from '../platform/events'
import { deleteWhere, exists, findById, num, pluck, str } from '../platform/records'
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
    period.insert()
}

/** After insert rule on billing periods still generating (the monthly job's or one made by hand): generate it. */
export function startBillingPeriodGeneration(current: GlideRecord): void {
    fire(EVENT.billingGenerate, current, current.getUniqueValue())
}

/**
 * Script action on x_daas_ham.billing.generate: one pass over the Subscription lines active in the month.
 * A chunk that cannot run (e.g. a month saved past the month rule) stops the pass and holds the period for review.
 */
export function generateBillingLines(event: GlideRecord, current: GlideRecord): void {
    const period = findById('x_daas_ham_billing_period', str(event, 'parm1'))
    if (!period || str(period, 'status') !== 'generating') return
    try {
        generateChunk(period, str(event, 'parm2'), current)
    } catch (error) {
        stopGeneration(period, error instanceof Error ? error.message : String(error))
    }
}

/** Bill the next chunk of the period's Subscription lines after `cursor`, then finish the period once the last one is billed. */
function generateChunk(period: GlideRecord, cursor: string, current: GlideRecord): void {
    const bounds = monthBounds(str(period, 'period'))
    const siteName = memoized(siteNameOf)
    const result = runEventTableJob({
        eventName: EVENT.billingGenerate,
        record: current,
        parm1: period.getUniqueValue(),
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
    if (result.failed > 0) {
        // A line that could not be billed must not vanish from the bill.
        addFailedLines(period, result.failed, result.lastError)
        period.update()
    }
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
    period.update()
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
    if (!line.insert()) throw new Error(`billing line not saved: ${line.getLastErrorMessage() || 'insert refused'}`)
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
                description: `${fee.getDisplayValue('fee_type')} fee: ${fee.getDisplayValue('asset')} (${str(fee, 'occurred_on')})`,
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
        fee.update()
    }
    if (failed > 0) addFailedLines(period, failed, lastError)
    setTotals(period)
    period.setValue('generated_at', msToGlide(nowMs()))
    period.setValue('status', 'ready')
    period.update()
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

/**
 * Fee lines whose fee was waived after generation (e.g. a missing unit turned up) are not billed: the fees
 * leave the period and their lines are deleted (does not redo the totals). Returns how many fees could not
 * leave it (Close refuses then; a retry finds them again). Only called while the period is still ready for
 * review, so the closed-line guard lets the lines go.
 */
function dropWaivedFeeLines(period: GlideRecord): number {
    let stuck = 0
    // In pages of a bounded id list, in sys_id order, so the loop ends even if an unlink does not take.
    let after = ''
    for (;;) {
        const waived = pluck('x_daas_ham_fee_event', `billing_period=${period.getUniqueValue()}^status=waived${after ? `^sys_id>${after}` : ''}^ORDERBYsys_id`, 'sys_id', 500)
        if (waived.length === 0) return stuck
        // Lines first, by the fees' ids (a set-based delete is not relied on to follow a dot-walked
        // condition): if the delete fails, the fees still point at the period and a retry finds them.
        deleteWhere('x_daas_ham_billing_line', `billing_period=${period.getUniqueValue()}^kind=fee^fee_eventIN${waived.join(',')}`)
        stuck += unlinkFees(`sys_idIN${waived.join(',')}`)
        after = waived[waived.length - 1]
    }
}

/** Unlink the Fee events matching an encoded query from their Billing period; returns how many could not be saved. */
function unlinkFees(encodedQuery: string): number {
    // Per record: updateMultiple does not reliably clear a reference to empty.
    const fee = new GlideRecord('x_daas_ham_fee_event')
    fee.addEncodedQuery(encodedQuery)
    fee.query()
    let failed = 0
    while (fee.next()) {
        fee.setValue('billing_period', '')
        if (!fee.update()) failed++
    }
    return failed
}

/** UI action "Regenerate" on a period ready for review: rebuild its lines from current data. */
export function uiRegenerateBillingPeriod(current: GlideRecord): void {
    if (str(current, 'status') !== 'ready') return void gs.addErrorMessage('Only a period ready for review can be regenerated')
    // Without business rules: the period is ready, not closed, so the closed-line guard has nothing to stop.
    const lines = new GlideRecord('x_daas_ham_billing_line')
    lines.addQuery('billing_period', current.getUniqueValue())
    lines.setWorkflow(false)
    lines.deleteMultiple()
    // The period's open fees stay linked to it: the generation bills them again (finishGeneration).
    current.setValue('status', 'generating')
    current.setValue('failed_lines', 0)
    current.setValue('last_error', '')
    current.update()
    fire(EVENT.billingGenerate, current, current.getUniqueValue())
    gs.addInfoMessage(`Regenerating ${str(current, 'period')}`)
}

const CSV_HEADER = ['period', 'kind', 'customer', 'agreement', 'subscription_line', 'site', 'description', 'units', 'monthly_rate', 'amount', 'currency']

/** UI action "Close period": mark its fees billed, lock it, then export its CSV and compute its margin in the background. */
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
    if (stuck > 0) return void gs.addErrorMessage(`${stuck} waived fee(s) could not leave ${str(current, 'period')}; check them and Close again`)
    // Always: finance may have adjusted lines during review, and the locked total must match the locked lines.
    setTotals(current)
    const fees = new GlideRecord('x_daas_ham_fee_event')
    fees.addQuery('billing_period', current.getUniqueValue())
    fees.addQuery('status', 'open')
    fees.setValue('status', 'billed')
    fees.updateMultiple()
    current.setValue('status', 'closed')
    current.setValue('closed_at', msToGlide(nowMs()))
    current.setValue('closed_by', gs.getUserID())
    current.update()
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
