// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.
import { GlideAggregate, GlideRecord, gs } from '@servicenow/glide'
import { addDays } from '../domain/calendar.ts'
import {
    buyoutPurchase,
    evenShare,
    groupExpiringCoverage,
    leaseDecisionProblem,
    leaseMismatch,
    renewedEnd,
    stillCovered,
    stockReturnMoves,
    withinLead,
    type ExpiringCoverage,
} from '../domain/leases.ts'
import { fleetStagesQuery } from '../domain/fleet.ts'
import type { HeldLock } from '../domain/job-lock.ts'
import { isRetired, SERVING_STAGES, stagesQuery, type Stage } from '../domain/lifecycle.ts'
import { isFree } from '../domain/sourcing.ts'
import type { LeaseEndAction } from '../domain/vocabulary.ts'
import { providerApproverIds } from '../platform/approvals.ts'
import { moveAsset, readStage } from '../platform/assets.ts'
import { runEventTableJob } from '../platform/chunked.ts'
import { todayIso } from '../platform/clock.ts'
import { EVENT, fire } from '../platform/events.ts'
import { refreshLifecycleDates } from '../platform/lifecycle-dates.ts'
import { intProperty, PROPERTY, stringProperty } from '../platform/properties.ts'
import { bool, count, exists, findById, num, refusal, str } from '../platform/records.ts'
import { changeStock, stockUnit } from '../platform/stock.ts'

/** Leases, end-of-lease decisions and renewals (P3.23–P3.24), over fleet assets only (ADR 0016). */

/** Healthy stock that can go straight back to the Lessor. */
const IN_STOCK: readonly Stage[] = ['available', 'spare_pool']

/**
 * Before rule on alm_hardware (br_asset_lease): a fleet asset on a lease schedule is owned by that schedule's Lessor,
 * whether its lease is set or it joins the fleet with one already set (adoption and the warehouse receipt set a blank
 * Legal owner to the Provider, which this replaces in the same save). The rule's condition runs it on a fleet asset
 * only, once its Lease schedule or its Fleet flag changes: one of the Provider IT's is left as it is (ADR 0016). It
 * reads no previous value, so either change runs it the same way.
 */
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
            // Refused: tomorrow's review alerts again, which beats not alerting at all.
            if (!lease.update()) {
                gs.warn(`[x_daas_ham] Lease ${str(lease, 'number')} mismatch flag not saved: ${refusal(lease)}`)
            }
            if (mismatch) fire(EVENT.leaseMismatch, lease, providerApproverIds('').join(','))
        }
        if (withinLead(str(lease, 'ends'), today, num(lease, 'decision_lead_days')) && !openDecision(leaseId)) raiseDecision(lease, mismatch)
    }
}

/** Queue the transfer again for each bought-out lease that still covers Assets (retired ones stay on it). */
function resumeBuyouts(): void {
    const ga = new GlideAggregate('alm_hardware')
    ga.addEncodedQuery(stillCovered('x_daas_ham_lease.end_action=buyout'))
    ga.addAggregate('COUNT', '')
    ga.groupBy('x_daas_ham_lease')
    ga.query()
    while (ga.next()) {
        const lease = findById('x_daas_ham_lease_schedule', String(ga.getValue('x_daas_ham_lease') ?? ''))
        if (lease) fire(EVENT.leaseBuyout, lease, lease.getUniqueValue())
    }
}

/** Agreement end dates of the fleet assets a lease covers that are serving customers ('' = open-ended). */
function serviceEnds(leaseId: string): string[] {
    // One row per Agreement, its end read as a stored date (a grouped dot-walked date's format is undocumented).
    const ga = new GlideAggregate('alm_hardware')
    ga.addEncodedQuery(fleetStagesQuery(SERVING_STAGES, `x_daas_ham_lease=${leaseId}`))
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
    return exists('x_daas_ham_lease_decision', `lease=${leaseId}^active=true`)
}

/** The fleet assets the lease covers (those in `stages`, when given). */
function countAssets(leaseId: string, stages?: readonly Stage[]): number {
    const ofLease = `x_daas_ham_lease=${leaseId}`
    return count('alm_hardware', stages ? fleetStagesQuery(stages, ofLease) : stillCovered(ofLease))
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
 * - return: stock leaves circulation onto a draft return-to-lessor disposal, and Assets at Sites get a
 *   Refresh due date no later than the lease end so automatic refresh swaps them out in time.
 * A lease being bought out or returned takes no further decision (domain/leases `leaseDecisionProblem`). The decision
 * is closed before the lease changes, and a closed one is not applied, so it never stays open over a lease it already
 * decided: applied again, an extension would extend once more (any new end date after the extended one passes), and
 * while it is open the daily review raises no decision before the new end (`openDecision`).
 */
export function uiApplyLeaseDecision(current: GlideRecord): void {
    // A form opened before the decision was applied can still send it.
    if (!bool(current, 'active')) return void gs.addErrorMessage('This decision is closed')
    const lease = findById('x_daas_ham_lease_schedule', str(current, 'lease'))
    if (!lease) return void gs.addErrorMessage('The lease schedule no longer exists')
    const decision = str(current, 'decision') as LeaseEndAction | ''
    const problem = leaseDecisionProblem({
        decision,
        endAction: str(lease, 'end_action') as LeaseEndAction | '',
        leaseEnd: str(lease, 'ends'),
        newEndDate: str(current, 'new_end_date'),
    })
    if (problem) return void gs.addErrorMessage(problem)
    const openState = str(current, 'state')
    current.setValue('state', 3)
    // Closed first: a refused form save (the platform says why) leaves the lease as it was and the decision open.
    if (!current.update()) return

    if (decision === 'extend') {
        lease.setValue('ends', str(current, 'new_end_date'))
        lease.setValue('end_action', 'undecided')
        lease.setValue('mismatch', false)
    } else {
        lease.setValue('end_action', decision)
    }
    // The buyout's terms are fixed once, while every Asset is still covered: Margin keeps splitting the
    // lease payment over that many while the transfer runs, and each costs its share of the buyout price.
    if (decision === 'buyout' && !num(lease, 'buyout_assets')) {
        const covered = countAssets(lease.getUniqueValue())
        lease.setValue('buyout_assets', covered)
        lease.setValue('buyout_share', evenShare(num(lease, 'buyout_price'), covered))
    }
    if (!lease.update()) {
        // Refused: no transfer or return may act on a decision the lease does not record, so the decision opens again.
        return reopenDecision(current, openState, `Lease ${str(lease, 'number')} not saved: ${refusal(lease)}`)
    }
    if (decision === 'buyout') {
        fire(EVENT.leaseBuyout, lease, lease.getUniqueValue())
        gs.addInfoMessage("The lease's assets become Provider-owned in the background")
    }
    if (decision === 'return') {
        const stock = disposeStockToLessor(lease)
        if (stock.disposal) gs.addInfoMessage(`The lease's stock awaits wipe on draft disposal order ${stock.disposal}`)
        if (stock.refused > 0) {
            const units = `${stock.refused} stock unit(s) of the lease`
            gs.addErrorMessage(`${units} could not go to pending wipe, so are not on the disposal; see the system log`)
        }
        if (stock.unlisted > 0) {
            const units = `${stock.unlisted} stock unit(s) of the lease went to pending wipe`
            gs.addErrorMessage(`${units} but are on no disposal order; see the system log and add them to one by hand`)
        }
        fire(EVENT.leaseAssets, lease, lease.getUniqueValue())
    }
}

/**
 * Put a decision closed by Apply back in `openState` once its lease was refused, to apply again. One the platform
 * keeps closed is logged: its lease is still undecided, so the daily review raises a new decision (`reviewLeases`, up
 * to 30 days past the lease end).
 */
function reopenDecision(decision: GlideRecord, openState: string, notApplied: string): void {
    decision.setValue('state', openState)
    if (decision.update()) return void gs.addErrorMessage(`${notApplied}. The decision is open again`)
    gs.warn(`[x_daas_ham] Lease decision ${str(decision, 'number')} not reopened (${notApplied}): ${refusal(decision)}`)
    const closed = 'The decision stays closed (see the system log); the daily lease review raises a new one'
    gs.addErrorMessage(`${notApplied}. ${closed}`)
}

/** What a return did with the lease's stock. */
interface StockReturn {
    /** Its draft disposal's number; null without one. */
    disposal: string | null
    /** Units not moved to pending wipe. */
    refused: number
    /** Units at pending wipe but on no disposal: their line, or the disposal, was refused. */
    unlisted: number
}

/**
 * Take the lease's stock out of circulation onto a draft return-to-lessor disposal: each unit is saved at pending
 * wipe, so sourcing and the spare-pool top-up can no longer claim it, and only then gets its line. A hot spare already
 * linked to an Order line is left to that line; once at a Site, its Refresh due date is the lease end like the rest.
 * Each unit is withdrawn under the lock stock claims take, from a fresh read (`withdrawFromStock`), so one reserved
 * since the query keeps its reservation. A unit whose line, or the disposal itself, is refused stays at pending wipe on
 * no disposal and is counted as unlisted, to be put on one by hand.
 */
function disposeStockToLessor(lease: GlideRecord): StockReturn {
    const found = new GlideRecord('alm_hardware')
    const unclaimed = `x_daas_ham_lease=${lease.getUniqueValue()}^x_daas_ham_order_lineISEMPTY`
    found.addEncodedQuery(fleetStagesQuery(IN_STOCK, unclaimed))
    found.query()
    // Undefined until the first unit is withdrawn; null once refused, so it is not tried again for every unit.
    let order: GlideRecord | null | undefined
    let refused = 0
    let unlisted = 0
    while (found.next()) {
        const asset = withdrawFromStock(found)
        if (asset === 'taken') continue
        if (asset === 'refused') {
            refused++
            continue
        }
        if (order === undefined) order = lessorDisposal(lease)
        if (!order) {
            unlisted++
            continue
        }
        const line = new GlideRecord('x_daas_ham_disposal_line')
        line.initialize()
        line.setValue('disposal_order', order.getUniqueValue())
        line.setValue('asset', asset.getUniqueValue())
        if (line.insert()) continue
        unlisted++
        const serial = str(asset, 'serial_number')
        gs.warn(`[x_daas_ham] Lease return: ${serial} left off ${str(order, 'number')}: ${refusal(line)}`)
    }
    return { disposal: order ? str(order, 'number') : null, refused, unlisted }
}

/**
 * Withdraw a unit the query found, under the lock stock claims take and from a fresh read (platform/stock
 * `changeStock`): a claim whose own fresh read came before the return was saved may still be saving it. A unit gone,
 * or no longer free stock on no Order line, is left to whoever took it ('taken'). The Asset at pending wipe, or
 * 'refused' (logged) when a move is refused or the lock cannot be taken.
 */
function withdrawFromStock(found: GlideRecord): GlideRecord | 'taken' | 'refused' {
    const withdrawn = changeStock(found.getUniqueValue(), 'withdrawn for its lessor', (asset, lock) => {
        if (!asset || !isFree(stockUnit(asset), IN_STOCK)) return 'taken'
        return moveOutOfStock(lock, asset) ? asset : 'refused'
    })
    if (withdrawn.ran) return withdrawn.value
    const serial = str(found, 'serial_number')
    gs.warn(`[x_daas_ham] Lease return: ${serial} not withdrawn: its stock lock could not be taken`)
    return 'refused'
}

/**
 * Save the Asset through its stock-return moves (domain/leases `stockReturnMoves`) holding its stock `lock`; false
 * (logged) when one is refused, or the lock was lost: a holder that outlasted it (ADR 0013) may overlap a claim.
 */
function moveOutOfStock(lock: HeldLock, asset: GlideRecord): boolean {
    const moves = stockReturnMoves(readStage(asset))
    for (const to of moves) {
        if (to === 'available') {
            // Out of the Customer's Spare pool: Provider stock again, as when an Order lets a unit go.
            asset.setValue('company', stringProperty(PROPERTY.providerCompany))
            asset.setValue('x_daas_ham_agreement', '')
        }
        const verdict = moveAsset(asset, to)
        if (!verdict.allowed) return notMoved(asset, to, verdict.reason)
        const saved = lock.save(`Lease return: ${str(asset, 'serial_number')} moved to ${to}`, () => asset.update())
        if (saved === 'lock lost') return notMoved(asset, to, 'its stock lock was lost')
        if (saved === 'refused') return notMoved(asset, to, refusal(asset))
    }
    return moves.length > 0
}

function notMoved(asset: GlideRecord, to: Stage, reason: string): false {
    gs.warn(`[x_daas_ham] Lease return: ${str(asset, 'serial_number')} not moved to ${to}: ${reason}`)
    return false
}

/** A draft return-to-lessor disposal order for the lease's stock; null when the platform refuses it (logged). */
function lessorDisposal(lease: GlideRecord): GlideRecord | null {
    const order = new GlideRecord('x_daas_ham_disposal_order')
    order.initialize()
    order.setValue('method', 'return_to_lessor')
    order.setValue('disposal_vendor', str(lease, 'lessor'))
    order.setValue('short_description', `Return stock to the lessor at the end of lease ${str(lease, 'number')}`)
    if (order.insert()) return order
    gs.warn(`[x_daas_ham] Lease return: no disposal order for ${str(lease, 'number')}: ${refusal(order)}`)
    return null
}

/** After-update rule on returned leases whose end date changed: their deployed Assets' Refresh due dates follow it. */
export function onReturnedLeaseEndChanged(current: GlideRecord): void {
    fire(EVENT.leaseAssets, current, current.getUniqueValue())
}

/**
 * Script action on x_daas_ham.lease.assets: recompute Refresh due dates of the lease's serving fleet assets
 * (platform/lifecycle-dates keeps the pass to the fleet).
 */
export function refreshLeaseAssets(event: GlideRecord, current: GlideRecord): void {
    const leaseId = str(event, 'parm1')
    refreshLifecycleDates({
        eventName: EVENT.leaseAssets,
        record: current,
        parm1: leaseId,
        cursor: str(event, 'parm2'),
        query: stagesQuery(SERVING_STAGES, `x_daas_ham_lease=${leaseId}`),
    })
}

/**
 * Script action on x_daas_ham.lease.buyout: the Provider owns the Assets the lease covers, each costing
 * the lease's Buyout cost per asset (for Margin). Retired units, which the Lessor or the OEM holds, keep
 * their lease link and are not transferred.
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
    // Every Asset the chunk transfers is bought today.
    const purchase = buyoutPurchase(num(current, 'buyout_share'), todayIso())
    runEventTableJob({
        eventName: EVENT.leaseBuyout,
        record: current,
        parm1: leaseId,
        cursor: str(event, 'parm2'),
        table: 'alm_hardware',
        query: stillCovered(`x_daas_ham_lease=${leaseId}`),
        read: (asset) => asset.getUniqueValue(),
        handle: (assetId) => {
            const asset = findById('alm_hardware', assetId)
            if (!asset || str(asset, 'x_daas_ham_lease') !== leaseId || isRetired(readStage(asset))) return
            asset.setValue('x_daas_ham_lease', '')
            asset.setValue('x_daas_ham_lessor', '')
            asset.setValue('x_daas_ham_legal_owner', 'provider')
            if (purchase) {
                asset.setValue('cost', purchase.cost)
                asset.setValue('purchase_date', purchase.date)
            }
            if (asset.update()) return
            // It stays the Lessor's until the daily review queues the transfer again; nothing else would say so.
            const serial = str(asset, 'serial_number')
            gs.warn(`[x_daas_ham] Buyout of ${str(current, 'number')}: ${serial} not transferred: ${refusal(asset)}`)
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
        // Refused: tomorrow's run warns again, which beats not warning at all.
        if (!agreement.update()) {
            gs.warn(`[x_daas_ham] Agreement ${str(agreement, 'number')} not marked warned: ${refusal(agreement)}`)
        }
        fire(EVENT.agreementRenewal, agreement, providerApproverIds(str(agreement, 'account_manager')).join(','))
    }
    warnExpiringCoverage(today)
}

/**
 * One warning per Customer for covered, deployed fleet assets whose OEM coverage ends soon; each contract is
 * warned about once. Exactly the rows counted are marked (a daily job, at most 5000 contracts a run); a row
 * whose mark is refused is logged and counted again the next day, which beats not warning at all.
 */
function warnExpiringCoverage(today: string): void {
    const horizon = addDays(today, intProperty(PROPERTY.coverageWarningDays, 60))
    const coverage = new GlideRecord('x_daas_ham_oem_coverage')
    coverage.addEncodedQuery(fleetStagesQuery(SERVING_STAGES, `covered=true^expiry_notified=false^end_date>=${today}^end_date<=${horizon}`, 'asset.'))
    coverage.setLimit(5000)
    coverage.query()
    const rows: ExpiringCoverage[] = []
    while (coverage.next()) {
        rows.push({ customerId: str(coverage, 'asset.company'), endDate: str(coverage, 'end_date') })
        coverage.setValue('expiry_notified', true)
        if (!coverage.update()) {
            const contract = `${str(coverage, 'contract_number')} of ${str(coverage, 'serial_number')}`
            gs.warn(`[x_daas_ham] Coverage ${contract} not marked warned: ${refusal(coverage)}`)
        }
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
    // A refused form save (the platform says why) renewed nothing.
    if (!current.update()) return
    gs.addInfoMessage(`Agreement renewed until ${ends}`)
}
