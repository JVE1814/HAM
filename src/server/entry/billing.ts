// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.
import { GlideAggregate, GlideDateTime, GlideRecord, GlideSysAttachment, gs } from '@servicenow/glide'
import type { RESTAPIRequest, RESTAPIResponse } from '@servicenow/glide/sn_ws_int'
import { monthBounds, previousMonth, subscriptionCharges, toCsv, type MonthBounds, type ServiceInterval, type SubscriptionLineTerms } from '../domain/billing'
import { ROLE } from '../domain/visibility'
import { runEventTableJob } from '../platform/chunked'
import { todayIso } from '../platform/clock'
import { EVENT, fire } from '../platform/events'
import { findById, num, str } from '../platform/records'
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
    const result = runEventTableJob({
        eventName: EVENT.billingGenerate,
        record: current,
        parm1: period.getUniqueValue(),
        cursor: str(event, 'parm2'),
        table: 'x_daas_ham_subscription_line',
        query: `status!=pending^start_date<=${bounds.last}^end_dateISEMPTY^ORend_date>=${bounds.first}`,
        read: (line) => ({
            terms: {
                lineType: str(line, 'line_type') as SubscriptionLineTerms['lineType'],
                monthlyRate: num(line, 'monthly_rate'),
                siteId: str(line, 'site'),
                start: str(line, 'start_date') || undefined,
                end: str(line, 'end_date') || undefined,
            },
            customerId: str(line, 'customer'),
            agreementId: str(line, 'agreement'),
            description: str(line, 'description'),
            currency: str(line, 'currency') || 'EUR',
        }),
        handle: (line, lineId) => {
            const intervals = line.terms.lineType === 'device_class' ? intervalsOf(lineId, bounds) : []
            for (const charge of subscriptionCharges(line.terms, intervals, bounds)) {
                const site = charge.siteId ? findById('cmn_location', charge.siteId) : null
                insertLine(period, {
                    kind: 'subscription',
                    customer: line.customerId,
                    agreement: line.agreementId,
                    subscription_line: lineId,
                    site: charge.siteId,
                    description: site ? `${line.description} - ${str(site, 'name')}` : line.description,
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

function intervalsOf(lineId: string, bounds: MonthBounds): ServiceInterval[] {
    const interval = new GlideRecord('x_daas_ham_service_interval')
    interval.addEncodedQuery(`subscription_line=${lineId}^start_date<=${bounds.last}^end_dateISEMPTY^ORend_date>=${bounds.first}`)
    interval.query()
    const intervals: ServiceInterval[] = []
    while (interval.next()) {
        intervals.push({ siteId: str(interval, 'site'), start: str(interval, 'start_date'), end: str(interval, 'end_date') || undefined })
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
    const lines = new GlideRecord('x_daas_ham_billing_line')
    lines.addQuery('billing_period', current.getUniqueValue())
    lines.deleteMultiple()
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

const CSV_HEADER = ['period', 'kind', 'customer', 'agreement', 'subscription_line', 'site', 'description', 'units', 'monthly_rate', 'amount', 'currency']

/** UI action "Close period": attach the CSV export, mark its fees billed, lock it and compute its margin. */
export function uiCloseBillingPeriod(current: GlideRecord): void {
    if (str(current, 'status') !== 'ready') return void gs.addErrorMessage('Only a period ready for review can be closed')
    dropWaivedFeeLines(current)
    const rows: Array<Array<string | number>> = [CSV_HEADER]
    const line = linesOf(current.getUniqueValue())
    while (line.next()) rows.push(csvRow(current, line))
    new GlideSysAttachment().write(current, `billing-${str(current, 'period')}.csv`, 'text/csv', toCsv(rows))

    const fee = new GlideRecord('x_daas_ham_fee_event')
    fee.addQuery('billing_period', current.getUniqueValue())
    fee.addQuery('status', 'open')
    fee.query()
    while (fee.next()) {
        fee.setValue('status', 'billed')
        fee.update()
    }
    current.setValue('status', 'closed')
    current.setValue('closed_at', new GlideDateTime().getValue())
    current.setValue('closed_by', gs.getUserID())
    current.update()
    fire(EVENT.marginCompute, current, current.getUniqueValue())
    gs.addInfoMessage(`${str(current, 'period')} closed and locked; margin is being computed`)
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
