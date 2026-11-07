// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.
import { GlideAggregate, GlideRecord, gs } from '@servicenow/glide'
import { addDays } from '../domain/calendar'
import { groupExpiringCoverage, leaseDecisionProblem, leaseMismatch, renewedEnd, withinLead, type LeaseEndAction } from '../domain/leases'
import { stagesQuery, type Stage } from '../domain/lifecycle'
import { leaseShare } from '../domain/margin'
import type { LifecycleDates } from '../domain/model-lifecycle'
import { providerApproverIds } from '../platform/approvals'
import { runEventTableJob } from '../platform/chunked'
import { todayIso } from '../platform/clock'
import { EVENT, fire } from '../platform/events'
import { applyLifecycleDates, modelLifecycle } from '../platform/lifecycle-dates'
import { intProperty, PROPERTY, stringProperty } from '../platform/properties'
import { bool, count, findById, num, str } from '../platform/records'

/** Leases, end-of-lease decisions and renewals (P3.23–P3.24). */

/** At or on the way to a customer Site, and not already coming back. */
const SERVING: readonly Stage[] = ['shipped', 'pending_in_service', 'in_service', 'temporary_deployment']
/** Healthy stock that can go straight back to the Lessor. */
const IN_STOCK: readonly Stage[] = ['available', 'spare_pool']

/** Before rule on alm_hardware: an Asset on a lease schedule is owned by that schedule's Lessor. */
export function onAssetLeaseChanged(current: GlideRecord): void {
    const lease = findById('x_daas_ham_lease_schedule', str(current, 'x_daas_ham_lease'))
    if (!lease) return
    current.setValue('x_daas_ham_legal_owner', 'lessor')
    current.setValue('x_daas_ham_lessor', str(lease, 'lessor'))
}

/** Daily: flag leases that end before the service they support, and raise decisions ahead of lease ends. */
export function reviewLeases(): void {
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

/** Agreement end dates of the Assets a lease covers that are serving customers ('' = open-ended). */
function serviceEnds(leaseId: string): string[] {
    const ga = new GlideAggregate('alm_hardware')
    ga.addEncodedQuery(stagesQuery(SERVING, `x_daas_ham_lease=${leaseId}`))
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
    decision.setValue('deployed_assets', countAssets(lease.getUniqueValue(), SERVING))
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
 * - buy out: the Provider owns the Assets from now on;
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
    lease.update()
    if (decision === 'buyout') transferToProvider(lease)
    if (decision === 'return') {
        const disposal = disposeStockToLessor(lease)
        if (disposal) gs.addInfoMessage(`Stock covered by the lease is on draft disposal order ${disposal}`)
        fire(EVENT.leaseAssets, lease, lease.getUniqueValue())
    }
    current.setValue('state', 3)
    current.update()
}

/** Buyout: the Provider owns the Assets, each costing its share of the buyout price (for Margin). */
function transferToProvider(lease: GlideRecord): void {
    const share = leaseShare(num(lease, 'buyout_price'), countAssets(lease.getUniqueValue()))
    const asset = new GlideRecord('alm_hardware')
    asset.addQuery('x_daas_ham_lease', lease.getUniqueValue())
    asset.query()
    while (asset.next()) {
        asset.setValue('x_daas_ham_lease', '')
        asset.setValue('x_daas_ham_lessor', '')
        asset.setValue('x_daas_ham_legal_owner', 'provider')
        if (share > 0) asset.setValue('cost', share)
        asset.update()
    }
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
    // One lifecycle read per model for this chunk: a lease usually covers many Assets of few models.
    const lifecycles = new Map<string, LifecycleDates>()
    const datesOf = (modelId: string): LifecycleDates => {
        let dates = lifecycles.get(modelId)
        if (!dates) {
            dates = modelLifecycle(modelId)
            lifecycles.set(modelId, dates)
        }
        return dates
    }
    runEventTableJob({
        eventName: EVENT.leaseAssets,
        record: current,
        parm1: leaseId,
        cursor: str(event, 'parm2'),
        table: 'alm_hardware',
        query: stagesQuery(SERVING, `x_daas_ham_lease=${leaseId}`),
        read: (asset) => asset.getUniqueValue(),
        handle: (assetId) => {
            const asset = new GlideRecord('alm_hardware')
            if (asset.get(assetId) && applyLifecycleDates(asset, datesOf(str(asset, 'model')))) asset.update()
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

/** One warning per Customer for covered, deployed Assets whose OEM coverage ends soon. */
function warnExpiringCoverage(today: string): void {
    const horizon = addDays(today, intProperty(PROPERTY.coverageWarningDays, 60))
    const coverage = new GlideRecord('x_daas_ham_oem_coverage')
    coverage.addEncodedQuery(stagesQuery(SERVING, `covered=true^expiry_notified=false^end_date>=${today}^end_date<=${horizon}`, 'asset.'))
    coverage.setLimit(5000)
    coverage.query()
    const rows: Array<{ customerId: string; endDate: string }> = []
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
