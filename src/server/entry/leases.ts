// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.
import { gs, type GlideRecord } from '@servicenow/glide'
import { todayIso } from '../platform/clock.ts'
import { warnExpiringCoverage } from '../platform/coverage-warnings.ts'
import { EVENT, jobEvent } from '../platform/events.ts'
import { applyLeaseDecision, giveToLessor, runLeaseReview, transferToProvider } from '../platform/leases.ts'
import { queueRefresh, runRefreshPass } from '../platform/lifecycle-dates.ts'
import { rearmForNewEnd, renewAgreement, warnAgreementRenewals } from '../platform/renewals.ts'

/** Leases, end-of-lease decisions and renewals (P3.23–P3.24): platform/leases, platform/renewals. */

/**
 * Before rule on alm_hardware (br_asset_lease): a fleet asset on a lease schedule is owned by that schedule's Lessor,
 * whether its lease is set or it joins the fleet with one already set (adoption and the warehouse receipt set a blank
 * Legal owner to the Provider, which this replaces in the same save). The rule's condition runs it on a fleet asset
 * only, once its Lease schedule or its Fleet flag changes: one of the Provider IT's is left as it is (ADR 0016). It
 * reads no previous value, so either change runs it the same way.
 */
export function onAssetLeaseChanged(current: GlideRecord): void {
    giveToLessor(current)
}

/**
 * Daily: flag leases that end before the service they support, raise decisions ahead of lease ends,
 * and queue the transfer again for a bought-out lease that still has Assets (an update was refused).
 */
export function reviewLeases(): void {
    runLeaseReview()
}

/** UI action "Apply decision" on an end-of-lease decision (platform/leases `applyLeaseDecision`). */
export function uiApplyLeaseDecision(current: GlideRecord): void {
    const outcome = applyLeaseDecision(current)
    for (const note of outcome.notes) gs.addInfoMessage(note)
    for (const problem of outcome.problems) gs.addErrorMessage(problem)
}

/** After-update rule on returned leases whose end date changed: their deployed Assets' Refresh due dates follow it. */
export function onReturnedLeaseEndChanged(current: GlideRecord): void {
    queueRefresh('lease', current)
}

/** Script action on x_daas_ham.lease.assets: recompute Refresh due dates of the lease's serving fleet assets. */
export function refreshLeaseAssets(event: GlideRecord, current: GlideRecord): void {
    runRefreshPass('lease', event, current)
}

/** Script action on x_daas_ham.lease.buyout: the Provider owns the Assets the lease covers. */
export function transferLeaseAssets(event: GlideRecord, current: GlideRecord): void {
    transferToProvider(jobEvent(EVENT.leaseBuyout, event, current), current)
}

/** Daily: warn account managers of Agreements coming up for renewal, and asset managers of expiring OEM coverage. */
export function warnRenewals(): void {
    const today = todayIso()
    warnAgreementRenewals(today)
    warnExpiringCoverage(today)
}

/** Before-update rule on agreements whose end date changed by hand: warn about the new end in time. */
export function onAgreementEndChanged(current: GlideRecord): void {
    rearmForNewEnd(current)
}

/** UI action "Renew agreement": extend the end date by the renewal term and re-arm the warnings. */
export function uiRenewAgreement(current: GlideRecord): void {
    const renewal = renewAgreement(current)
    if (renewal.renewed) gs.addInfoMessage(`Agreement renewed until ${renewal.until}`)
    else if (renewal.why) gs.addErrorMessage(renewal.why)
}
