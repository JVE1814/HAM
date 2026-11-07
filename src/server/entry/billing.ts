// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.
import { GlideAggregate, GlideDateTime, GlideRecord, GlideSysAttachment, gs } from '@servicenow/glide'
import type { RESTAPIRequest, RESTAPIResponse } from '@servicenow/glide/sn_ws_int'
import { monthBounds, overlapsMonth, previousMonth, subscriptionCharges, toCsv, type MonthBounds, type ServiceInterval } from '../domain/billing'
import { ROLE } from '../domain/visibility'
import { runEventTableJob } from '../platform/chunked'
import { todayIso } from '../platform/clock'
import { EVENT, fire } from '../platform/events'
import { count, findById, num, str } from '../platform/records'
import { queryInt, reply } from '../platform/rest-api'

/** Billing periods: generate, review, close (lock) and export (P3.25, D66). */

/** Monthly (day 1): open last month's Billing period and generate its lines. */
export function openMonthlyBillingPeriod(): void {
    const month = previousMonth(todayIso())
    const existing = new GlideRecord('x_daas_ham_billing_period')
    if (existing.get('period', month)) return
    const bounds = monthBounds(month)
    const period = new GlideRecord('x_daas_ham_billing_period')
    period.initialize()
    period.setValue('period', month)
    period.setValue('period_start', bounds.first)
    period.setValue('period_end', bounds.last)
    period.setValue('status', 'generating')
    period.insert()
    fire(EVENT.billingGenerate, period, period.getUniqueValue())
}

function boundsOf(period: GlideRecord): MonthBounds {
    return monthBounds(str(period, 'period'))
}

/** Script action on x_daas_ham.billing.generate: one pass over the Subscription lines active in the month. */
export function generateBillingLines(event: GlideRecord, current: GlideRecord): void {
    const period = findById('x_daas_ham_billing_period', str(event, 'parm1'))
    if (!period || str(period, 'status') !== 'generating') return
    const bounds = boundsOf(period)
    const siteNames = new Map<string, string>()
    const result = runEventTableJob({
        eventName: EVENT.billingGenerate,
        record: current,
        parm1: period.getUniqueValue(),
        cursor: str(event, 'parm2'),
        table: 'x_daas_ham_subscription_line',
        query: `status!=pending^${overlapsMonth(bounds)}`,
        read: (line) => ({
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
        handle: (line, lineId) => {
            const sources = { intervals: () => intervalsOf(lineId, bounds), siteName: (siteId: string) => siteName(siteId, siteNames) }
            for (const charge of subscriptionCharges(line.terms, bounds, sources)) {
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
    if (result.done) finishGeneration(period)
}

/** A Site's name, read once per Site and chunk ('' without a Site). */
function siteName(siteId: string, cache: Map<string, string>): string {
    let name = cache.get(siteId)
    if (name === undefined) {
        const site = findById('cmn_location', siteId)
        name = site ? str(site, 'name') : ''
        cache.set(siteId, name)
    }
    return name
}

/** The line's Service intervals in the month, one row per Site and dates with the number of Assets sharing them. */
function intervalsOf(lineId: string, bounds: MonthBounds): ServiceInterval[] {
    const ga = new GlideAggregate('x_daas_ham_service_interval')
    ga.addEncodedQuery(`subscription_line=${lineId}^${overlapsMonth(bounds)}`)
    ga.addAggregate('COUNT', '')
    ga.groupBy('site')
    ga.groupBy('start_date')
    ga.groupBy('end_date')
    ga.query()
    const intervals: ServiceInterval[] = []
    while (ga.next()) {
        intervals.push({
            siteId: String(ga.getValue('site') ?? ''),
            start: String(ga.getValue('start_date') ?? ''),
            end: String(ga.getValue('end_date') ?? '') || undefined,
            count: Number(ga.getAggregate('COUNT', '')),
        })
    }
    return intervals
}

function insertLine(period: GlideRecord, values: { [field: string]: string | number }): void {
    const line = new GlideRecord('x_daas_ham_billing_line')
    line.initialize()
    line.setValue('billing_period', period.getUniqueValue())
    for (const [field, value] of Object.entries(values)) line.setValue(field, value)
    line.insert()
}

/** Add the open Fee events up to the month end, then total the period for review. */
function finishGeneration(period: GlideRecord): void {
    const fee = new GlideRecord('x_daas_ham_fee_event')
    fee.addQuery('status', 'open')
    fee.addNullQuery('billing_period')
    fee.addQuery('occurred_on', '<=', boundsOf(period).last)
    fee.query()
    while (fee.next()) {
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
        fee.setValue('billing_period', period.getUniqueValue())
        fee.update()
    }
    setTotals(period)
    period.setValue('generated_at', new GlideDateTime().getValue())
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

/** Fee lines whose fee was waived after generation (e.g. a missing unit turned up) are not billed. */
function dropWaivedFeeLines(period: GlideRecord): void {
    const line = new GlideRecord('x_daas_ham_billing_line')
    line.addEncodedQuery(`billing_period=${period.getUniqueValue()}^kind=fee^fee_event.status=waived`)
    line.query()
    while (line.next()) {
        const fee = findById('x_daas_ham_fee_event', str(line, 'fee_event'))
        if (fee) {
            fee.setValue('billing_period', '')
            fee.update()
        }
        line.deleteRecord()
    }
    setTotals(period)
}

/** UI action "Regenerate" on a period ready for review: rebuild its lines from current data. */
export function uiRegenerateBillingPeriod(current: GlideRecord): void {
    if (str(current, 'status') !== 'ready') return void gs.addErrorMessage('Only a period ready for review can be regenerated')
    // Without business rules: the period is ready, not closed, so the closed-line guard has nothing to stop.
    const lines = new GlideRecord('x_daas_ham_billing_line')
    lines.addQuery('billing_period', current.getUniqueValue())
    lines.setWorkflow(false)
    lines.deleteMultiple()
    // Per record: updateMultiple does not reliably clear a reference to empty.
    const fee = new GlideRecord('x_daas_ham_fee_event')
    fee.addQuery('billing_period', current.getUniqueValue())
    fee.query()
    while (fee.next()) {
        fee.setValue('billing_period', '')
        fee.update()
    }
    current.setValue('status', 'generating')
    current.update()
    fire(EVENT.billingGenerate, current, current.getUniqueValue())
    gs.addInfoMessage(`Regenerating ${str(current, 'period')}`)
}

/** Fired by Close period and Re-export CSV (parm1 = period); belongs in EVENT once platform/events.ts is free. */
const BILLING_EXPORT_EVENT = 'x_daas_ham.billing.export'

const CSV_HEADER = ['period', 'kind', 'customer', 'agreement', 'subscription_line', 'site', 'description', 'units', 'monthly_rate', 'amount', 'currency']

/** UI action "Close period": mark its fees billed, lock it, then export its CSV and compute its margin in the background. */
export function uiCloseBillingPeriod(current: GlideRecord): void {
    if (str(current, 'status') !== 'ready') return void gs.addErrorMessage('Only a period ready for review can be closed')
    dropWaivedFeeLines(current)
    const fees = new GlideRecord('x_daas_ham_fee_event')
    fees.addQuery('billing_period', current.getUniqueValue())
    fees.addQuery('status', 'open')
    fees.setValue('status', 'billed')
    fees.updateMultiple()
    current.setValue('status', 'closed')
    current.setValue('closed_at', new GlideDateTime().getValue())
    current.setValue('closed_by', gs.getUserID())
    current.update()
    fire(BILLING_EXPORT_EVENT, current, current.getUniqueValue())
    fire(EVENT.marginCompute, current, current.getUniqueValue())
    gs.addInfoMessage(`${str(current, 'period')} closed and locked; the CSV export and margin are being prepared`)
}

/** UI action "Re-export CSV" on a closed period whose export is missing (never saves the period). */
export function uiExportBillingPeriod(current: GlideRecord): void {
    if (str(current, 'status') !== 'closed') return void gs.addErrorMessage('Only a closed period can be exported')
    const fileName = exportFileName(current)
    if (hasAttachment(current, fileName)) return void gs.addInfoMessage(`${fileName} is already attached; delete it to export again`)
    fire(BILLING_EXPORT_EVENT, current, current.getUniqueValue())
    gs.addInfoMessage(`The CSV export of ${str(current, 'period')} is being prepared`)
}

/**
 * Script action on x_daas_ham.billing.export (parm1 = period): attach the CSV of a closed period's
 * lines unless it is already attached. Only reads the period, so the closed-period lock is not hit.
 */
export function exportBillingPeriod(event: GlideRecord): void {
    const period = findById('x_daas_ham_billing_period', str(event, 'parm1'))
    if (!period || str(period, 'status') !== 'closed') return
    const fileName = exportFileName(period)
    if (hasAttachment(period, fileName)) return
    const rows: Array<Array<string | number>> = [CSV_HEADER]
    const line = linesOf(period.getUniqueValue())
    while (line.next()) rows.push(csvRow(period, line))
    new GlideSysAttachment().write(period, fileName, 'text/csv', toCsv(rows))
}

function exportFileName(period: GlideRecord): string {
    return `billing-${str(period, 'period')}.csv`
}

function hasAttachment(period: GlideRecord, fileName: string): boolean {
    return count('sys_attachment', `table_name=x_daas_ham_billing_period^table_sys_id=${period.getUniqueValue()}^file_name=${fileName}`) > 0
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

function csvRow(period: GlideRecord, line: GlideRecord): Array<string | number> {
    return [
        str(period, 'period'),
        str(line, 'kind'),
        line.getDisplayValue('customer'),
        line.getDisplayValue('agreement'),
        line.getDisplayValue('subscription_line'),
        line.getDisplayValue('site'),
        str(line, 'description'),
        num(line, 'units'),
        num(line, 'monthly_rate'),
        num(line, 'amount'),
        str(line, 'currency'),
    ]
}

/** Before update/delete rule on billing lines: a closed period's lines never change. */
export function guardClosedBillingLine(current: GlideRecord): void {
    if (str(current, 'billing_period.status') !== 'closed') return
    gs.addErrorMessage('This billing period is closed; its lines cannot change')
    current.setAbortAction(true)
}

/** Before update/delete rule on billing periods: a closed period is locked. */
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
    period.setLimit(queryInt(request, 'limit', 24))
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
    const limit = Math.min(queryInt(request, 'limit', 1000), 5000)
    const line = linesOf(period.getUniqueValue(), offset, limit)
    const lines: object[] = []
    while (line.next()) {
        lines.push({
            id: line.getUniqueValue(),
            kind: str(line, 'kind'),
            customerId: str(line, 'customer'),
            customer: line.getDisplayValue('customer'),
            agreement: line.getDisplayValue('agreement'),
            subscriptionLine: str(line, 'subscription_line'),
            siteId: str(line, 'site'),
            site: line.getDisplayValue('site'),
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
