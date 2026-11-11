// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.
import { gs, type GlideRecord } from '@servicenow/glide'
import { EVENT } from '../domain/events.ts'
import { todayIso } from '../platform/clock.ts'
import { warnExpiringCoverage } from '../platform/coverage-warnings.ts'
import { jobEvent } from '../platform/events.ts'
import { applyLeaseDecision, giveToLessor, runLeaseReview, transferToProvider } from '../platform/leases.ts'
import { queueRefresh, runRefreshPass } from '../platform/lifecycle-dates.ts'
import type { ForeignRecord } from '../platform/records.ts'
import { warnAgreementRenewals } from '../platform/renewals.ts'

/** Leases, end-of-lease decisions and renewals (plan §13 Leases, Renewals): platform/leases, platform/renewals. */

/**
 * Before rule on alm_hardware (br_asset_lease): a fleet asset on a lease schedule is owned by that schedule's Lessor,
 * whether its lease is set or it joins the fleet with one already set (adoption and the warehouse receipt set a blank
 * Legal owner to the Provider, which this replaces in the same save). The rule's condition runs it on a fleet asset
 * only, once its Lease schedule or its Fleet flag changes: one of the Provider IT's is left as it is (ADR 0016). It
 * reads no previous value, so either change runs it the same way.
 */
export function onAssetLeaseChanged(current: ForeignRecord): void {
    giveToLessor(current)
}

export function reviewLeases(): void {
    runLeaseReview()
}

export function uiApplyLeaseDecision(current: GlideRecord): void {
    const outcome = applyLeaseDecision(current)
    for (const note of outcome.notes) gs.addInfoMessage(note)
    for (const problem of outcome.problems) gs.addErrorMessage(problem)
}

export function onReturnedLeaseEndChanged(current: GlideRecord): void {
    queueRefresh('lease', current)
}

export function refreshLeaseAssets(event: GlideRecord, current: GlideRecord): void {
    runRefreshPass('lease', event, current)
}

export function transferLeaseAssets(event: GlideRecord, current: GlideRecord): void {
    transferToProvider(jobEvent(EVENT.leaseBuyout, event, current), current)
}

export function warnRenewals(): void {
    const today = todayIso()
    warnAgreementRenewals(today)
    warnExpiringCoverage(today)
}
