import { GlideAggregate, GlideRecord, gs } from '@servicenow/glide'
import { fleetStagesQuery } from '../domain/fleet.ts'
import type { HeldLock } from '../domain/job-lock.ts'
import { withinLead } from '../domain/calendar.ts'
import {
    buyoutPurchase,
    buyoutTerms,
    decidedLease,
    earliestReviewedEnd,
    leaseDecisionProblem,
    leaseMismatch,
    stillCovered,
    stockReturnMoves,
} from '../domain/leases.ts'
import { isRetired, SERVING_STAGES, type Stage, STOCK_STAGES } from '../domain/lifecycle.ts'
import { isFree } from '../domain/sourcing.ts'
import { LEASE_END_ACTION, type LeaseEndAction, LEGAL_OWNER, TASK_STATE } from '../domain/vocabulary.ts'
import { assetManagerIds } from './approvals.ts'
import { moveAsset, readStage } from './assets.ts'
import { runEventTableJob } from './chunked.ts'
import { todayIso } from './clock.ts'
import { addDisposalLine, draftLessorDisposal } from './disposal.ts'
import { EVENT, fire, queueJob, type JobEvent } from './events.ts'
import { queueRefresh } from './lifecycle-dates.ts'
import { PROPERTY, stringProperty } from './properties.ts'
import { bool, count, exists, findById, num, refusal, str, warnRefused } from './records.ts'
import { changeStock, releaseToProviderStock, stockUnit } from './stock.ts'

/**
 * Lease schedules and their end-of-lease decisions (P3.23), over fleet assets only (ADR 0016): the daily review, a
 * decision applied, and the background jobs a buy out and a return start. None of it tells the user anything: each
 * gives what came of it, for the trigger that asked.
 */

const LEASE = 'x_daas_ham_lease_schedule'

/** The task state an applied decision is closed with. */
const DECISION_CLOSED = TASK_STATE.closedComplete

/**
 * An Asset on a Lease schedule is owned by that schedule's Lessor (the lease's Vendor, which the Asset reaches through
 * its Lease schedule): set its Legal owner (the caller saves). One on no lease is left as it is.
 */
export function giveToLessor(asset: GlideRecord): void {
    if (findById(LEASE, str(asset, 'x_daas_ham_lease'))) asset.setValue('x_daas_ham_legal_owner', LEGAL_OWNER.lessor)
}

/**
 * Flag leases that end before the service they support, raise decisions ahead of lease ends, and queue the transfer
 * again for a bought-out lease that still has Assets (an update was refused): the daily review.
 */
export function runLeaseReview(): void {
    resumeBuyouts()
    const today = todayIso()
    const lease = new GlideRecord(LEASE)
    lease.addQuery('end_action', LEASE_END_ACTION.undecided)
    lease.addNotNullQuery('ends')
    lease.addQuery('ends', '>=', earliestReviewedEnd(today))
    lease.query()
    while (lease.next()) {
        const leaseId = lease.getUniqueValue()
        const mismatch = leaseMismatch(str(lease, 'ends'), serviceEnds(leaseId))
        if (mismatch !== bool(lease, 'mismatch')) {
            lease.setValue('mismatch', mismatch)
            // Refused: tomorrow's review alerts again, which beats not alerting at all.
            if (!lease.update()) warnRefused(lease, `Lease ${str(lease, 'number')} mismatch flag not saved`)
            if (mismatch) fire(EVENT.leaseMismatch, lease, assetManagerIds().join(','))
        }
        if (withinLead(str(lease, 'ends'), today, num(lease, 'decision_lead_days')) && !openDecision(leaseId)) raiseDecision(lease, mismatch)
    }
}

/** Queue the transfer again for each bought-out lease that still covers Assets (retired ones stay on it). */
function resumeBuyouts(): void {
    const ga = new GlideAggregate('alm_hardware')
    ga.addEncodedQuery(stillCovered(`x_daas_ham_lease.end_action=${LEASE_END_ACTION.buyout}`))
    ga.addAggregate('COUNT', '')
    ga.groupBy('x_daas_ham_lease')
    ga.query()
    while (ga.next()) {
        const lease = findById(LEASE, String(ga.getValue('x_daas_ham_lease') ?? ''))
        if (lease) queueBuyout(lease)
    }
}

/** Queue the transfer of the lease's Assets to the Provider (`transferToProvider`). */
function queueBuyout(lease: GlideRecord): void {
    queueJob(EVENT.leaseBuyout, lease)
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
        `Decide on lease ${str(lease, 'number')} (${lease.getDisplayValue('vendor')}) ending ${str(lease, 'ends')}: buy out, extend or return`,
    )
    // Refused: with no decision open, tomorrow's review raises it again.
    if (!decision.insert()) warnRefused(decision, `No decision raised for lease ${str(lease, 'number')}`)
}

/**
 * What came of applying an end-of-lease decision: whether it was applied, what to tell the user (`notes`), and what
 * went wrong or was left undone (`problems`); neither when the platform has told the user already (it refused the save
 * of the decision's form).
 */
export interface DecisionOutcome {
    applied: boolean
    notes: string[]
    problems: string[]
}

function notApplied(problem?: string): DecisionOutcome {
    return { applied: false, notes: [], problems: problem ? [problem] : [] }
}

/**
 * Apply an end-of-lease decision.
 * - buy out: the Provider owns the Assets from now on (transferred in the background, see `transferToProvider`);
 * - extend: the lease runs to the new end date;
 * - return: stock leaves circulation onto a draft return-to-lessor disposal, and Assets at Sites get a
 *   Refresh due date no later than the lease end so automatic refresh swaps them out in time.
 * A lease being bought out or returned takes no further decision (domain/leases `leaseDecisionProblem`). The decision
 * is closed before the lease changes, and a closed one is not applied, so it never stays open over a lease it already
 * decided: applied again, an extension would extend once more (any new end date after the extended one passes), and
 * while it is open the daily review raises no decision before the new end (`openDecision`).
 */
export function applyLeaseDecision(decisionRecord: GlideRecord): DecisionOutcome {
    // A form opened before the decision was applied can still send it.
    if (!bool(decisionRecord, 'active')) return notApplied('This decision is closed')
    const lease = findById(LEASE, str(decisionRecord, 'lease'))
    if (!lease) return notApplied('The lease schedule no longer exists')
    const decision = str(decisionRecord, 'decision') as LeaseEndAction | ''
    const problem = leaseDecisionProblem({
        decision,
        endAction: str(lease, 'end_action') as LeaseEndAction | '',
        leaseEnd: str(lease, 'ends'),
        newEndDate: str(decisionRecord, 'new_end_date'),
    })
    if (problem || !decision) return notApplied(problem ?? undefined)
    const openState = str(decisionRecord, 'state')
    decisionRecord.setValue('state', DECISION_CLOSED)
    // Closed first: a refused form save (the platform says why) leaves the lease as it was and the decision open.
    if (!decisionRecord.update()) return notApplied()

    const decided = decidedLease(decision, str(decisionRecord, 'new_end_date'))
    if (decided.ends !== undefined) lease.setValue('ends', decided.ends)
    lease.setValue('end_action', decided.endAction)
    if (decided.mismatch !== undefined) lease.setValue('mismatch', decided.mismatch)
    const terms = buyoutTerms(decision, { fixedAssets: num(lease, 'buyout_assets'), price: num(lease, 'buyout_price') }, () =>
        countAssets(lease.getUniqueValue()),
    )
    if (terms) {
        lease.setValue('buyout_assets', terms.assets)
        lease.setValue('buyout_share', terms.share)
    }
    if (!lease.update()) {
        // Refused: no transfer or return may act on a decision the lease does not record, so the decision opens again.
        return notApplied(reopenDecision(decisionRecord, openState, `Lease ${str(lease, 'number')} not saved: ${refusal(lease)}`))
    }
    const outcome: DecisionOutcome = { applied: true, notes: [], problems: [] }
    if (decision === 'buyout') {
        queueBuyout(lease)
        outcome.notes.push("The lease's assets become Provider-owned in the background")
    }
    if (decision === 'return') {
        const stock = disposeStockToLessor(lease)
        if (stock.disposal) outcome.notes.push(`The lease's stock awaits wipe on draft disposal order ${stock.disposal}`)
        if (stock.refused > 0) {
            const units = `${stock.refused} stock unit(s) of the lease`
            outcome.problems.push(`${units} could not go to pending wipe, so are not on the disposal; see the system log`)
        }
        if (stock.unlisted > 0) {
            const units = `${stock.unlisted} stock unit(s) of the lease went to pending wipe`
            outcome.problems.push(`${units} but are on no disposal order; see the system log and add them to one by hand`)
        }
        queueRefresh('lease', lease)
    }
    return outcome
}

/**
 * Put a decision closed by Apply back in `openState` once its lease was refused, to apply again; what to tell the
 * user. One the platform keeps closed is logged: its lease is still undecided, so the daily review raises a new
 * decision (`runLeaseReview`, for as long as domain/leases `earliestReviewedEnd` reviews the lease).
 */
function reopenDecision(decision: GlideRecord, openState: string, why: string): string {
    decision.setValue('state', openState)
    if (decision.update()) return `${why}. The decision is open again`
    warnRefused(decision, `Lease decision ${str(decision, 'number')} not reopened (${why})`)
    return `${why}. The decision stays closed (see the system log); the daily lease review raises a new one`
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
    found.addEncodedQuery(fleetStagesQuery(STOCK_STAGES, unclaimed))
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
        if (order === undefined) order = draftLessorDisposal(lease)
        if (!order || !addDisposalLine(order, asset)) unlisted++
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
        if (!asset || !isFree(stockUnit(asset), STOCK_STAGES)) return 'taken'
        return moveOutOfStock(lock, asset) ? asset : 'refused'
    })
    if (withdrawn.ran) return withdrawn.value
    const serial = str(found, 'serial_number')
    gs.warn(`[x_daas_ham] Lease return: ${serial} not withdrawn: its stock lock could not be taken`)
    return 'refused'
}

/**
 * Save the Asset through its stock-return moves (domain/leases `stockReturnMoves`) holding its stock `lock`; false
 * (logged) when one is refused, or the lock was lost: a holder that outlasted it (ADR 0013) may overlap a claim. Each
 * move is saved through the lock, which platform/assets `moveAndSave` does not do.
 */
function moveOutOfStock(lock: HeldLock, asset: GlideRecord): boolean {
    const moves = stockReturnMoves(readStage(asset))
    for (const to of moves) {
        // Out of the Customer's Spare pool: Provider stock again, as when an Order lets a unit go.
        if (to === 'available') releaseToProviderStock(asset)
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

/**
 * The Provider owns the Assets the bought-out `lease` covers, each costing the lease's Buyout cost per asset (for
 * Margin), a chunk at a time: the job of the event `queueBuyout` queues. Retired units, which the Lessor or the OEM
 * holds, keep their lease link and are not transferred.
 *
 * Every transferred Asset leaves the query set. The cursor (sys_id > last handled) still holds:
 * batches run in ascending sys_id order, so the Assets that were on the lease when the pass reached
 * them are all handled; ones at or below the cursor have left the set. (An Asset linked to the lease
 * during the pass below the cursor is not picked up; buyout is not expected to overlap new links.)
 * Keeping the cursor, rather than re-reading from the start, also stops an Asset whose update fails
 * from being fetched again in every batch of the pass.
 */
export function transferToProvider(queued: JobEvent, lease: GlideRecord): void {
    const leaseId = queued.subject
    // Never run with a blank lease: the query would match every Asset that has no lease.
    if (!leaseId) return
    // Every Asset the chunk transfers is bought today.
    const purchase = buyoutPurchase(num(lease, 'buyout_share'), todayIso())
    runEventTableJob(queued, {
        table: 'alm_hardware',
        query: stillCovered(`x_daas_ham_lease=${leaseId}`),
        read: (asset) => asset.getUniqueValue(),
        handle: (assetId) => {
            const asset = findById('alm_hardware', assetId)
            if (!asset || str(asset, 'x_daas_ham_lease') !== leaseId || isRetired(readStage(asset))) return
            asset.setValue('x_daas_ham_lease', '')
            asset.setValue('x_daas_ham_legal_owner', LEGAL_OWNER.provider)
            if (purchase) {
                asset.setValue('cost', purchase.cost)
                asset.setValue('purchase_date', purchase.date)
            }
            if (asset.update()) return
            // It stays the Lessor's until the daily review queues the transfer again; nothing else would say so.
            const serial = str(asset, 'serial_number')
            warnRefused(asset, `Buyout of ${str(lease, 'number')}: ${serial} not transferred`)
        },
    })
}
