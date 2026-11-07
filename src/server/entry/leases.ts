// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.
import { GlideAggregate, GlideRecord, gs } from '@servicenow/glide'
import { addDays } from '../domain/calendar'
import { groupExpiringCoverage, leaseDecisionProblem, leaseMismatch, renewedEnd, withinLead, type ExpiringCoverage, type LeaseEndAction } from '../domain/leases'
import { SERVING_STAGES, stagesQuery, type Stage } from '../domain/lifecycle'
import { leaseShare } from '../domain/margin'
import { providerApproverIds } from '../platform/approvals'
import { runEventTableJob } from '../platform/chunked'
import { todayIso } from '../platform/clock'
import { EVENT, fire } from '../platform/events'
import { refreshLifecycleDates } from '../platform/lifecycle-dates'
import { intProperty, PROPERTY, stringProperty } from '../platform/properties'
import { bool, count, findById, num, str } from '../platform/records'

/** Leases, end-of-lease decisions and renewals (P3.23–P3.24). */

/** Healthy stock that can go straight back to the Lessor. */
const IN_STOCK: readonly Stage[] = ['available', 'spare_pool']

/** Before rule on alm_hardware: an Asset on a lease schedule is owned by that schedule's Lessor. */
export function onAssetLeaseChanged(current: GlideRecord): void {
    const lease = findById('x_daas_ham_lease_schedule', str(current, 'x_daas_ham_lease'))
    if (!lease) return
    current.setValue('x_daas_ham_legal_owner', 'lessor')
    current.setValue('x_daas_ham_lessor', str(lease, 'lessor'))
}

/**
 * Daily: flag leases that end before the service they support, raise decisions ahead of lease ends,
 * and queue the transfer again for a bought-out lease that still has Assets (an update was refused).
 */
export function reviewLeases(): void {
    resumeBuyouts()
    const today = todayIso()
    const lease = new GlideRecord('x_daas_ham_lease_schedule')
    lease.addQuery('end_action', 'undecided')
    lease.addNotNullQuery('ends')
    lease.addQuery('ends', '>=', addDays(today, -30))
    lease.query()
    while (lease.next()) {
        const leaseId = lease.getUniqueValue()
        const mismatch = leaseMismatch(str(lease, 'ends'), serviceEnds(leaseId))
        if (mismatch !== bool(lease, 'mismatch')) {
            lease.setValue('mismatch', mismatch)
            lease.update()
            if (mismatch) fire(EVENT.leaseMismatch, lease, providerApproverIds('').join(','))
        }
        if (withinLead(str(lease, 'ends'), today, num(lease, 'decision_lead_days')) && !openDecision(leaseId)) raiseDecision(lease, mismatch)
    }
}

/** Queue the transfer again for each bought-out lease that still has Assets. */
function resumeBuyouts(): void {
    const ga = new GlideAggregate('alm_hardware')
    ga.addEncodedQuery('x_daas_ham_lease.end_action=buyout')
    ga.addAggregate('COUNT', '')
    ga.groupBy('x_daas_ham_lease')
    ga.query()
    while (ga.next()) {
        const lease = findById('x_daas_ham_lease_schedule', String(ga.getValue('x_daas_ham_lease') ?? ''))
        if (lease) fire(EVENT.leaseBuyout, lease, lease.getUniqueValue())
    }
}

/** Agreement end dates of the Assets a lease covers that are serving customers ('' = open-ended). */
function serviceEnds(leaseId: string): string[] {
    // One row per Agreement, its end read as a stored date (a grouped dot-walked date's format is undocumented).
    const ga = new GlideAggregate('alm_hardware')
    ga.addEncodedQuery(stagesQuery(SERVING_STAGES, `x_daas_ham_lease=${leaseId}`))
    ga.addAggregate('COUNT', '')
    ga.groupBy('x_daas_ham_agreement')
    ga.query()
    const ends: string[] = []
    while (ga.next()) {
        const agreement = findById('x_daas_ham_agreement', String(ga.getValue('x_daas_ham_agreement') ?? ''))
        if (agreement) ends.push(str(agreement, 'ends'))
    }
    return ends
}

function openDecision(leaseId: string): boolean {
    const decision = new GlideRecord('x_daas_ham_lease_decision')
    decision.addQuery('lease', leaseId)
    decision.addQuery('active', true)
    decision.setLimit(1)
    decision.query()
    return decision.hasNext()
}

function countAssets(leaseId: string, stages?: readonly Stage[]): number {
    const ofLease = `x_daas_ham_lease=${leaseId}`
    return count('alm_hardware', stages ? stagesQuery(stages, ofLease) : ofLease)
}

function raiseDecision(lease: GlideRecord, mismatch: boolean): void {
    const decision = new GlideRecord('x_daas_ham_lease_decision')
    decision.initialize()
    decision.setValue('lease', lease.getUniqueValue())
    decision.setValue('lease_end', str(lease, 'ends'))
    decision.setValue('due_date', `${str(lease, 'ends')} 00:00:00`)
    decision.setValue('covered_assets', countAssets(lease.getUniqueValue()))
    decision.setValue('deployed_assets', countAssets(lease.getUniqueValue(), SERVING_STAGES))
    decision.setValue('mismatch', mismatch)
    decision.setValue('assignment_group', stringProperty(PROPERTY.leaseDecisionGroup))
    decision.setValue(
        'short_description',
        `Decide on lease ${str(lease, 'number')} (${lease.getDisplayValue('lessor')}) ending ${str(lease, 'ends')}: buy out, extend or return`,
    )
    decision.insert()
}

/**
 * UI action "Apply decision" on an end-of-lease decision.
 * - buy out: the Provider owns the Assets from now on (transferred in the background, see
 *   transferLeaseAssets);
 * - extend: the lease runs to the new end date;
 * - return: stock goes on a draft return-to-lessor disposal, and Assets at Sites get a Refresh due
 *   date no later than the lease end so automatic refresh swaps them out in time.
 */
export function uiApplyLeaseDecision(current: GlideRecord): void {
    const lease = findById('x_daas_ham_lease_schedule', str(current, 'lease'))
    if (!lease) return void gs.addErrorMessage('The lease schedule no longer exists')
    const decision = str(current, 'decision') as LeaseEndAction | ''
    const problem = leaseDecisionProblem({ decision, leaseEnd: str(lease, 'ends'), newEndDate: str(current, 'new_end_date') })
    if (problem) return void gs.addErrorMessage(problem)

    if (decision === 'extend') {
        lease.setValue('ends', str(current, 'new_end_date'))
        lease.setValue('end_action', 'undecided')
        lease.setValue('mismatch', false)
    } else {
        lease.setValue('end_action', decision)
    }
    // Fixed once, while every Asset is still covered: each one's share of the buyout price (its cost
    // for Margin) and how many there were (Margin keeps splitting the lease over that many while the
    // transfer runs).
    if (decision === 'buyout' && !num(lease, 'buyout_assets')) {
        const covered = countAssets(lease.getUniqueValue())
        lease.setValue('buyout_assets', covered)
        lease.setValue('buyout_share', leaseShare(num(lease, 'buyout_price'), covered))
    }
    lease.update()
    if (decision === 'buyout') {
        fire(EVENT.leaseBuyout, lease, lease.getUniqueValue())
        gs.addInfoMessage("The lease's assets become Provider-owned in the background")
    }
    if (decision === 'return') {
        const disposal = disposeStockToLessor(lease)
        if (disposal) gs.addInfoMessage(`Stock covered by the lease is on draft disposal order ${disposal}`)
        fire(EVENT.leaseAssets, lease, lease.getUniqueValue())
    }
    current.setValue('state', 3)
    current.update()
}

/** Draft a return-to-lessor disposal for the lease's Assets still in stock; returns its number. */
function disposeStockToLessor(lease: GlideRecord): string | null {
    const asset = new GlideRecord('alm_hardware')
    asset.addEncodedQuery(stagesQuery(IN_STOCK, `x_daas_ham_lease=${lease.getUniqueValue()}`))
    asset.query()
    if (!asset.hasNext()) return null
    const order = new GlideRecord('x_daas_ham_disposal_order')
    order.initialize()
    order.setValue('method', 'return_to_lessor')
    order.setValue('disposal_vendor', str(lease, 'lessor'))
    order.setValue('short_description', `Return stock to the lessor at the end of lease ${str(lease, 'number')}`)
    order.insert()
    while (asset.next()) {
        const line = new GlideRecord('x_daas_ham_disposal_line')
        line.initialize()
        line.setValue('disposal_order', order.getUniqueValue())
        line.setValue('asset', asset.getUniqueValue())
        line.insert()
    }
    return str(order, 'number')
}

/** Script action on x_daas_ham.lease.assets: recompute Refresh due dates of the lease's Assets. */
export function refreshLeaseAssets(event: GlideRecord, current: GlideRecord): void {
    const leaseId = str(event, 'parm1')
    // Never run with a blank lease: the query would match every Asset that has no lease.
    if (!leaseId) return
    refreshLifecycleDates({
        eventName: EVENT.leaseAssets,
        record: current,
        parm1: leaseId,
        cursor: str(event, 'parm2'),
        query: stagesQuery(SERVING_STAGES, `x_daas_ham_lease=${leaseId}`),
    })
}

/**
 * Script action on x_daas_ham.lease.buyout: the Provider owns the lease's Assets, each costing the
 * lease's Buyout cost per asset (for Margin).
 *
 * Every transferred Asset leaves the query set. The cursor (sys_id > last handled) still holds:
 * batches run in ascending sys_id order, so the Assets that were on the lease when the pass reached
 * them are all handled; ones at or below the cursor have left the set. (An Asset linked to the lease
 * during the pass below the cursor is not picked up; buyout is not expected to overlap new links.)
 * Keeping the cursor, rather than re-reading from the start, also stops an Asset whose update fails
 * from being fetched again in every batch of the pass.
 */
export function transferLeaseAssets(event: GlideRecord, current: GlideRecord): void {
    const leaseId = str(event, 'parm1')
    // Never run with a blank lease: the query would match every Asset that has no lease.
    if (!leaseId) return
    const share = num(current, 'buyout_share')
    runEventTableJob({
        eventName: EVENT.leaseBuyout,
        record: current,
        parm1: leaseId,
        cursor: str(event, 'parm2'),
        table: 'alm_hardware',
        query: `x_daas_ham_lease=${leaseId}`,
        read: (asset) => asset.getUniqueValue(),
        handle: (assetId) => {
            const asset = findById('alm_hardware', assetId)
            if (!asset || str(asset, 'x_daas_ham_lease') !== leaseId) return
            asset.setValue('x_daas_ham_lease', '')
            asset.setValue('x_daas_ham_lessor', '')
            asset.setValue('x_daas_ham_legal_owner', 'provider')
            // The Provider bought it today: its write-off (Margin) runs from the buyout, not its first go-live.
            if (share > 0) {
                asset.setValue('cost', share)
                asset.setValue('purchase_date', todayIso())
            }
            asset.update()
        },
    })
}

/** Daily: warn account managers of Agreements coming up for renewal, and asset managers of expiring OEM coverage. */
export function warnRenewals(): void {
    const today = todayIso()
    const agreement = new GlideRecord('x_daas_ham_agreement')
    agreement.addQuery('renewal_notified', false)
    agreement.addNotNullQuery('ends')
    agreement.addQuery('ends', '>=', today)
    agreement.query()
    while (agreement.next()) {
        if (!withinLead(str(agreement, 'ends'), today, num(agreement, 'renewal_lead_days'))) continue
        agreement.setValue('renewal_notified', true)
        agreement.update()
        fire(EVENT.agreementRenewal, agreement, providerApproverIds(str(agreement, 'account_manager')).join(','))
    }
    warnExpiringCoverage(today)
}

/**
 * One warning per Customer for covered, deployed Assets whose OEM coverage ends soon; each contract is
 * warned about once. Exactly the rows counted are marked (a daily job, at most 5000 contracts a run).
 */
function warnExpiringCoverage(today: string): void {
    const horizon = addDays(today, intProperty(PROPERTY.coverageWarningDays, 60))
    const coverage = new GlideRecord('x_daas_ham_oem_coverage')
    coverage.addEncodedQuery(stagesQuery(SERVING_STAGES, `covered=true^expiry_notified=false^end_date>=${today}^end_date<=${horizon}`, 'asset.'))
    coverage.setLimit(5000)
    coverage.query()
    const rows: ExpiringCoverage[] = []
    while (coverage.next()) {
        rows.push({ customerId: str(coverage, 'asset.company'), endDate: str(coverage, 'end_date') })
        coverage.setValue('expiry_notified', true)
        coverage.update()
    }
    const recipients = providerApproverIds('').join(',')
    for (const [customerId, group] of groupExpiringCoverage(rows)) {
        const customer = findById('customer_account', customerId)
        if (customer) fire(EVENT.coverageExpiring, customer, recipients, `${group.count} OEM coverage contract(s), the first ending ${group.firstEnd}`)
    }
}

/** Before-update rule on agreements whose end date changed by hand: warn about the new end in time. */
export function onAgreementEndChanged(current: GlideRecord): void {
    current.setValue('renewal_notified', false)
    if (str(current, 'ends') >= todayIso()) current.setValue('end_return_raised', false)
}

/** UI action "Renew agreement": extend the end date by the renewal term and re-arm the warnings. */
export function uiRenewAgreement(current: GlideRecord): void {
    if (!str(current, 'ends')) return void gs.addErrorMessage('The agreement has no end date to renew')
    const ends = renewedEnd(str(current, 'ends'), num(current, 'renewal_term_months'))
    current.setValue('ends', ends)
    current.setValue('renewal_notified', false)
    current.setValue('end_return_raised', false)
    current.update()
    gs.addInfoMessage(`Agreement renewed until ${ends}`)
}
