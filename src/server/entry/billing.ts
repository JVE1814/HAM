import { gs, type GlideRecord } from '@servicenow/glide'
import type { RESTAPIRequest, RESTAPIResponse } from '@servicenow/glide/sn_ws_int'
import { BILLING_PULL_READERS, billingMonthProblem, monthChangedError, PULL_PAGE, pullPageSize } from '../domain/billing.ts'
import { monthBounds, previousMonth } from '../domain/money.ts'
import { EVENT } from '../domain/events.ts'
import { billingChange, isBillable } from '../domain/lifecycle.ts'
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
import { readStage } from '../platform/assets.ts'
import { glideToIsoDate, todayIso } from '../platform/clock.ts'
import { closedLineRefusal, closedPeriodRefusal } from '../platform/closed-period.ts'
import { jobEvent, subjectOf } from '../platform/events.ts'
import { str, type ForeignRecord } from '../platform/records.ts'
import { pathParam, queryInt, reply, requireRole } from '../platform/rest-api.ts'
import { abortWith } from '../platform/rule-api.ts'
import { closeServiceIntervals, moveServiceInterval, openServiceInterval } from '../platform/service-intervals.ts'

export function openMonthlyBillingPeriod(): void {
    openBillingPeriod(previousMonth(todayIso()))
}

export function generateBillingLines(event: GlideRecord, current: GlideRecord): void {
    generateChunk(jobEvent(EVENT.billingGenerate, event, current))
}

function report(outcome: PeriodOutcome, done: string): void {
    if (!outcome.done) {
        if ('why' in outcome) gs.addErrorMessage(outcome.why)
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
    return requireRole(response, BILLING_PULL_READERS, 'Requires the finance or billing reader role')
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

/**
 * A save of a fleet asset that changed its stage, its Subscription line or its Site. One that takes it into or out of
 * service starts or stops its billing. One that leaves it in service (on another line or none, at another Site, or in
 * the other stage in service) moves its Service interval to the line and Site it has now.
 */
export function onAssetServiceChange(current: ForeignRecord, previous: ForeignRecord): void {
    const today = todayIso()
    const change = billingChange(readStage(previous), readStage(current), {
        inServiceDate: glideToIsoDate(str(current, 'x_daas_ham_in_service_date')),
        today,
    })
    const lineId = str(current, 'x_daas_ham_subscription_line')
    if (!change) {
        if (isBillable(readStage(current))) moveServiceInterval(current.getUniqueValue(), today)
    } else if ('stop' in change) closeServiceIntervals(current.getUniqueValue(), change.stop)
    else if (lineId) openServiceInterval(current, lineId, change.start)
}
