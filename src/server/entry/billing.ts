// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.
import { gs, type GlideRecord } from '@servicenow/glide'
import type { RESTAPIRequest, RESTAPIResponse } from '@servicenow/glide/sn_ws_int'
import { billingMonthProblem, monthBounds, previousMonth } from '../domain/billing.ts'
import { ROLE } from '../domain/visibility.ts'
import {
    attachExport,
    closedLineRefusal,
    closedPeriodRefusal,
    closePeriod,
    generateChunk,
    generateNewPeriod,
    linesPage,
    openBillingPeriod,
    queueExport,
    recentPeriods,
    regeneratePeriod,
    requestExport,
    resetGeneration,
    type PeriodOutcome,
} from '../platform/billing.ts'
import { todayIso } from '../platform/clock.ts'
import { EVENT, jobEvent, subjectOf } from '../platform/events.ts'
import { queueMarginCompute } from '../platform/margin.ts'
import { str } from '../platform/records.ts'
import { pathParam, queryInt, reply, requireRole } from '../platform/rest-api.ts'
import { abortWith } from '../platform/rule-api.ts'

/** Billing periods: generate, review, close (lock) and export (P3.25, D66): platform/billing. */

/** Monthly (day 1): open last month's Billing period unless it exists. */
export function openMonthlyBillingPeriod(): void {
    openBillingPeriod(previousMonth(todayIso()))
}

/** After insert rule on billing periods still generating (the monthly job's or one made by hand): generate it. */
export function startBillingPeriodGeneration(current: GlideRecord): void {
    generateNewPeriod(current)
}

/** Script action on x_daas_ham.billing.generate: one chunk of a generation pass of the period the event names. */
export function generateBillingLines(event: GlideRecord, current: GlideRecord): void {
    generateChunk(jobEvent(EVENT.billingGenerate, event, current))
}

/** Tell the user what became of an action on a period: `done` when it was done, else why not (unless the platform has). */
function report(outcome: PeriodOutcome, done: string): void {
    if (outcome.done) gs.addInfoMessage(done)
    else if (outcome.why) gs.addErrorMessage(outcome.why)
}

/** UI action "Regenerate" on a period ready for review: rebuild its lines from current data. */
export function uiRegenerateBillingPeriod(current: GlideRecord): void {
    report(regeneratePeriod(current), `Regenerating ${str(current, 'period')}`)
}

/** UI action "Reset generation" (admin) on a period stuck generating: hold it for review, to Regenerate. */
export function uiResetBillingGeneration(current: GlideRecord): void {
    if (!gs.hasRole(ROLE.admin)) return void gs.addErrorMessage('Only an admin can reset a generation')
    report(resetGeneration(current), `${str(current, 'period')} is ready for review, reset by hand: Regenerate it before closing`)
}

/** UI action "Close period": lock it, mark its fees billed, then export its CSV and compute its margin in the background. */
export function uiCloseBillingPeriod(current: GlideRecord): void {
    const closed = closePeriod(current)
    if (closed.done) {
        queueExport(current)
        queueMarginCompute(current)
    }
    report(closed, `${str(current, 'period')} closed and locked; the CSV export and margin are being prepared`)
}

/** UI action "Re-export CSV" on a closed period whose export is missing (platform/billing `requestExport`). */
export function uiExportBillingPeriod(current: GlideRecord): void {
    const request = requestExport(current)
    if (request.queued) return void gs.addInfoMessage(`The CSV export of ${str(current, 'period')} is being prepared`)
    if (request.why === 'attached') return void gs.addInfoMessage(`${request.fileName} is already attached; delete it to export again`)
    gs.addErrorMessage('Only a closed period can be exported')
}

/** Script action on x_daas_ham.billing.export (parm1 = period): attach the CSV of a closed period's lines. */
export function exportBillingPeriod(event: GlideRecord): void {
    attachExport(subjectOf(event))
}

/** Before update/delete rule on billing lines: a closed period's lines never change. */
export function guardClosedBillingLine(current: GlideRecord, previous: GlideRecord): void {
    abortWith(current, closedLineRefusal(current, previous))
}

/**
 * Before insert/update rule on billing periods (when the month changes): the month is billed only as YYYY-MM and once
 * it has ended (domain/billing `billingMonthProblem`), and the period's first and last day follow it (a period created
 * by hand has them too).
 */
export function guardBillingPeriodMonth(current: GlideRecord): void {
    const month = str(current, 'period')
    const problem = billingMonthProblem(month, todayIso())
    if (problem) return abortWith(current, problem)
    const bounds = monthBounds(month)
    current.setValue('period_start', bounds.first)
    current.setValue('period_end', bounds.last)
}

/** Before update/delete rule on billing periods: a closed period is locked. */
export function guardClosedBillingPeriod(current: GlideRecord, previous: GlideRecord): void {
    abortWith(current, closedPeriodRefusal(current, previous))
}

/** The billing pull API is finance's and the ERP integration's. */
function canPull(response: RESTAPIResponse): boolean {
    return requireRole(response, [ROLE.finance, ROLE.integration], 'Requires the finance or integration role')
}

/** GET /billing_periods: the most recent periods. */
export function listBillingPeriods(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!canPull(response)) return
    reply(response, 200, recentPeriods(Math.min(Math.max(queryInt(request, 'limit', 24), 1), 120)))
}

/** GET /billing_periods/{id}/lines?offset&limit: one page of a period's lines (closed periods are final). */
export function getBillingLines(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!canPull(response)) return
    const offset = queryInt(request, 'offset', 0)
    const limit = Math.min(Math.max(queryInt(request, 'limit', 1000), 1), 5000)
    const page = linesPage(pathParam(request, 'id'), offset, limit)
    if (!page) return reply(response, 404, { error: 'Unknown billing period' })
    reply(response, 200, page)
}
