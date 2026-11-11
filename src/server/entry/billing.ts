// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.
import { gs, type GlideRecord } from '@servicenow/glide'
import type { RESTAPIRequest, RESTAPIResponse } from '@servicenow/glide/sn_ws_int'
import { agreementCurrencyProblem, billingMonthProblem, monthChangedError, PULL_PAGE, pullPageSize } from '../domain/billing.ts'
import { currencyCode, monthBounds, previousMonth } from '../domain/money.ts'
import { EVENT } from '../domain/events.ts'
import { ROLE } from '../domain/roles.ts'
import {
    attachExport,
    closePeriod,
    generateChunk,
    linesPage,
    openBillingPeriod,
    recentPeriods,
    regeneratePeriod,
    requestExport,
    resetGeneration,
    type PeriodOutcome,
} from '../platform/billing.ts'
import { todayIso } from '../platform/clock.ts'
import { closedLineRefusal, closedPeriodRefusal } from '../platform/closed-period.ts'
import { jobEvent, subjectOf } from '../platform/events.ts'
import { str } from '../platform/records.ts'
import { pathParam, queryInt, reply, requireRole } from '../platform/rest-api.ts'
import { abortWith } from '../platform/rule-api.ts'

/** Billing periods: generate, review, close (lock) and export (plan §13 Billing export, Q66): platform/billing. */

export function openMonthlyBillingPeriod(): void {
    openBillingPeriod(previousMonth(todayIso()))
}

export function generateBillingLines(event: GlideRecord, current: GlideRecord): void {
    generateChunk(jobEvent(EVENT.billingGenerate, event, current))
}

function report(outcome: PeriodOutcome, done: string): void {
    if (!outcome.done) {
        if (outcome.why) gs.addErrorMessage(outcome.why)
        return
    }
    gs.addInfoMessage(done)
    if (outcome.warning) gs.addErrorMessage(outcome.warning)
}

export function uiRegenerateBillingPeriod(current: GlideRecord): void {
    report(regeneratePeriod(current), `Regenerating ${str(current, 'period')}`)
}

export function uiResetBillingGeneration(current: GlideRecord): void {
    if (!gs.hasRole(ROLE.admin)) return void gs.addErrorMessage('Only an admin can reset a generation')
    report(resetGeneration(current), `${str(current, 'period')} is ready for review, reset by hand: Regenerate it before closing`)
}

export function uiCloseBillingPeriod(current: GlideRecord): void {
    report(closePeriod(current), `${str(current, 'period')} closed and locked; the CSV export and margin are being prepared`)
}

export function uiExportBillingPeriod(current: GlideRecord): void {
    const request = requestExport(current)
    if (request.queued) return void gs.addInfoMessage(`The CSV export of ${str(current, 'period')} is being prepared`)
    if (request.why === 'attached') return void gs.addInfoMessage(`${request.fileName} is already attached; delete it to export again`)
    gs.addErrorMessage('Only a closed period can be exported')
}

export function exportBillingPeriod(event: GlideRecord): void {
    attachExport(subjectOf(event))
}

export function guardClosedBillingLine(current: GlideRecord, previous: GlideRecord): void {
    abortWith(current, closedLineRefusal(current, previous))
}

/**
 * Before insert/update rule on Agreements (when the currency changes): a currency that is no three-letter code is
 * refused as it is entered (domain/billing `agreementCurrencyProblem`), rather than failing every line of the Agreement
 * at the next generation; one entered in lower case is saved upper-cased, as billing reads it.
 */
export function guardAgreementCurrency(current: GlideRecord): void {
    const entered = str(current, 'currency')
    const problem = agreementCurrencyProblem(entered)
    if (problem) return abortWith(current, problem)
    const code = currencyCode(entered)
    if (code && code !== entered) current.setValue('currency', code)
}

export function guardBillingPeriodMonth(current: GlideRecord): void {
    const month = str(current, 'period')
    const problem = billingMonthProblem(month, todayIso())
    if (problem) return abortWith(current, problem)
    const bounds = monthBounds(month)
    current.setValue('period_start', bounds.first)
    current.setValue('period_end', bounds.last)
    if (!current.isNewRecord()) current.setValue('last_error', monthChangedError(month))
}

export function guardClosedBillingPeriod(current: GlideRecord, previous: GlideRecord): void {
    abortWith(current, closedPeriodRefusal(current, previous))
}

function canPull(response: RESTAPIResponse): boolean {
    return requireRole(response, [ROLE.finance, ROLE.integration], 'Requires the finance or integration role')
}

export function listBillingPeriods(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!canPull(response)) return
    reply(response, 200, recentPeriods(pullPageSize(queryInt(request, 'limit', PULL_PAGE.periods.size), PULL_PAGE.periods)))
}

export function getBillingLines(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!canPull(response)) return
    const offset = queryInt(request, 'offset', 0)
    const limit = pullPageSize(queryInt(request, 'limit', PULL_PAGE.lines.size), PULL_PAGE.lines)
    const page = linesPage(pathParam(request, 'id'), offset, limit)
    if (!page) return reply(response, 404, { error: 'Unknown billing period' })
    reply(response, 200, page)
}
