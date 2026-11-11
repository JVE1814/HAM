import { GlideRecord, gs } from '@servicenow/glide'
import { messageOf } from '../domain/errors.ts'
import { TRY_AGAIN, type HeldLock } from '../domain/job-lock.ts'
import { checkTransition, isDeployed, type Stage } from '../domain/lifecycle.ts'
import { LOCK } from '../domain/lock-names.ts'
import {
    AWAITED,
    evaluationTarget,
    isSiteRecovery,
    KEEPS_RETURN_OPEN,
    opensDeinstallWork,
    overdueStep,
    receivedLate,
    requestedTrigger,
    RETURN_TASK_STATE,
    returnDueDate,
    returnRequestFindings,
    SETTLED_BY_RECEIPT,
    type RequestedReturn,
    type ReturnRequester,
} from '../domain/returns.ts'
import {
    type EvaluationOutcome,
    type LeaseEndAction,
    type LegalOwner,
    RETURN_LINE_STATUS,
    RETURN_TRIGGER,
    type ReturnCondition,
    type ReturnLineStatus,
    type ReturnMethod,
    type ReturnTrigger,
} from '../domain/vocabulary.ts'
import { customerAdminIds } from './approvals.ts'
import { clearRackPlacement, clearWipeEvidence, isFleetAsset, moveAndSave, moveRefusal, readStage, transitionFacts } from './assets.ts'
import { runTableJob } from './chunked.ts'
import { nowGlide, todayIso } from './clock.ts'
import { fire } from './events.ts'
import { EVENT } from '../domain/events.ts'
import { recordFee, waiveOpenFees } from './fees.ts'
import { openFieldWork } from './field-work.ts'
import { installedAssetIds } from './installed-assets.ts'
import { attemptLock, withLock } from './locks.ts'
import { intProperty } from './properties.ts'
import { PROPERTY } from '../domain/properties.ts'
import { bool, choice, exists, findById, num, refusal, str, warnRefused } from './records.ts'
import { creatorOf } from './session.ts'
import { releaseToProviderStock } from './stock.ts'
import { endSitePackageIfEmpty } from './subscriptions.ts'
import { SITE_FIELD } from '../domain/fleet.ts'

/**
 * Return orders and their lines (P2.4): raising one, by request or for a job, and what each line then goes through.
 * A line awaits its unit, which is received at the depot and evaluated, or declared missing once it is overdue; its
 * Return order closes when every line is evaluated or missing. Every write of a line's status is made here.
 */

const RETURN = 'x_daas_ham_return_order'
const RETURN_LINE = 'x_daas_ham_return_order_line'

/** A Return to raise: why, for whom and from where, how its units come back, and the Assets to bring back. */
export interface ReturnRequest {
    trigger: ReturnTrigger
    customerId: string
    siteId: string
    agreementId: string
    method: ReturnMethod
    assetIds: readonly string[]
    sourceOrderId?: string
    description: string
}

/** A Return order raised: its number, and how many of its Assets got a line. */
export interface RaisedReturn {
    number: string
    lines: number
}

/**
 * Create a Return order with one line per Asset; installed or shipped Assets become pending return. Null, with a
 * warning, when the platform refuses the Return order: no Asset is touched, so the caller can raise it again.
 */
export function raiseReturn(request: ReturnRequest): RaisedReturn | null {
    const order = new GlideRecord(RETURN)
    order.initialize()
    order.setValue('trigger', request.trigger)
    order.setValue('customer', request.customerId)
    order.setValue('site', request.siteId)
    order.setValue('agreement', request.agreementId)
    order.setValue('method', request.method)
    order.setValue('source_order', request.sourceOrderId ?? '')
    order.setValue('short_description', request.description)
    if (!order.insert()) {
        warnRefused(order, `Return not raised (${request.description})`)
        return null
    }
    return fillReturn(order, request)
}

/**
 * Fill in a saved Return order header: due date, lines, de-install work (unless a swap's work order collects the units,
 * domain/returns `opensDeinstallWork`). Only fleet assets (ADR 0016) get a line: one of the Provider IT's that a caller
 * lists is left off (logged), so no app job ever chases, declares or charges it. Each Asset is put on it under its
 * return lock (`addUnderLock`), so it awaits one Return at a time.
 */
function fillReturn(order: GlideRecord, request: ReturnRequest): RaisedReturn {
    const agreement = findById('x_daas_ham_agreement', request.agreementId)
    order.setValue('agreement', request.agreementId)
    order.setValue('due_back', returnDueDate(todayIso(), agreement ? num(agreement, 'overdue_return_days') : 0))
    order.setValue('state', RETURN_TASK_STATE.inProgress)

    let lines = 0
    let refused = 0
    for (const assetId of request.assetIds) {
        const added = addUnderLock(order, assetId)
        if (added === 'added') lines++
        else if (added === 'refused') refused++
    }

    if (lines === 0) {
        // Nothing installed, everything already on another Return order, or every unit refused: close straight away.
        order.setValue('state', RETURN_TASK_STATE.closed)
        const note = refused > 0 ? 'No unit could be added (see the system log).' : 'No equipment to bring back.'
        order.setValue('work_notes', note)
    } else if (opensDeinstallWork(request.trigger, request.method)) {
        const context = {
            customerId: request.customerId,
            siteId: request.siteId,
            description: request.description,
            sourceId: order.getUniqueValue(),
        }
        const work = openFieldWork(context, { changeType: 'normal', purpose: 'de_install', subcontracted: false })
        if (work) {
            order.setValue('change_request', work.changeId)
            order.setValue('work_order', work.workOrderId)
        } else {
            order.setValue('work_notes', 'De-install work not opened (see the system log): open it by hand.')
        }
    }
    // Its lines and moves are saved, but a Return without its due date is never chased: logged to set it by hand.
    if (!order.update()) warnRefused(order, `Return ${str(order, 'number')} due date, state and links not saved`)
    return { number: str(order, 'number'), lines }
}

/** What came of putting an Asset on a Return order: a line added, refused (logged), or none needed. */
type LineResult = 'added' | 'refused' | 'skipped'

/** Whether the Asset is on a Return order line still awaiting it. */
function awaitsReturn(assetId: string): boolean {
    return latestReturnLine(assetId, [AWAITED]) !== null
}

/**
 * Put the Asset on the Return order under its return lock (domain/lock-names `returnAsset`, ADR 0013). The check that
 * it awaits no other return and the insert of its line are one critical section, so two Returns raised at once (a
 * request sent twice, the record producer beside the customer page or an Agreement's end) never both take the unit,
 * which would leave the line it is not received on to be declared missing and charged as lost. No unique index can
 * hold it: an Asset is on one awaiting line at a time, but on any number of settled ones.
 *
 * 'skipped' when the Asset is not found, already awaits a return, or another Return held its lock through every try,
 * back to back (a holder holds it for one check, one line and one move), and has taken it. One whose lock was held
 * through every try but that still awaits no return (the holder was slow, refused or died holding it) is 'refused',
 * logged, as is one whose lock cannot be taken; the line's own errors escape.
 */
function addUnderLock(order: GlideRecord, assetId: string): LineResult {
    // Lost before the line was written: the try is given up, and the next checks afresh.
    const attempt = attemptLock(LOCK.returnAsset(assetId), (lock) => addLineHolding(lock, order, assetId) ?? TRY_AGAIN)
    if (attempt.ran) return attempt.value
    const left = `Asset ${assetId} left off return ${str(order, 'number')}`
    if (!attempt.held) {
        gs.warn(`[x_daas_ham] ${left}: ${messageOf(attempt.error)}`)
        return 'refused'
    }
    // The holder has normally put it on its Return by now; one that has not leaves the unit on none (as recordFee).
    if (awaitsReturn(assetId)) {
        gs.info(`[x_daas_ham] ${left}: another return held its lock and took it`)
        return 'skipped'
    }
    gs.warn(`[x_daas_ham] ${left}: its return lock was held through every try, yet it awaits no return: put it on one by hand if it is due back`)
    return 'refused'
}

/**
 * Add the Asset's line and make it pending return, holding its return `lock`. A holder that outlasts the lock (ADR
 * 0013) and lost it before the insert writes nothing (null); one that lost it during the insert is logged, to check
 * the unit is on one Return.
 */
function addLineHolding(lock: HeldLock, order: GlideRecord, assetId: string): LineResult | null {
    const asset = findById('alm_hardware', assetId)
    if (!asset || awaitsReturn(assetId)) return 'skipped'
    const number = str(order, 'number')
    if (!isFleetAsset(asset)) {
        gs.warn(`[x_daas_ham] ${str(asset, 'serial_number')} left off return ${number}: it is not a fleet asset`)
        return 'refused'
    }
    // The line first: an Asset whose line is refused stays as it is, off this Return order.
    const line = new GlideRecord(RETURN_LINE)
    line.initialize()
    line.setValue('return_order', order.getUniqueValue())
    line.setValue('asset', assetId)
    const saved = lock.save(`${str(asset, 'serial_number')} put on return ${number}`, () => line.insert(), { check: 'check it is on one return' })
    if (saved === 'lock lost') return null
    if (saved === 'refused') {
        warnRefused(line, `${str(asset, 'serial_number')} left off return ${number}`)
        return 'refused'
    }
    const stage = readStage(asset)
    const moving = isDeployed(stage) && stage !== 'pending_return'
    // Leaving service closes the Asset's service interval (entry/assets.ts onAssetServiceChange). A refused move
    // (moveAndSave warns) takes the line off again: it would await a unit still in service, later declared missing.
    // One that cannot be taken off is logged, to remove by hand before the overdue job gets to it.
    if (moving && !moveAndSave(asset, 'pending_return', `return ${number}`)) {
        if (line.deleteRecord()) return 'refused'
        const kept = `${str(asset, 'serial_number')} not pending return but kept on return ${number}`
        gs.warn(`[x_daas_ham] ${kept}: ${refusal(line, 'delete refused')}; remove its line`)
    }
    return 'added'
}

/** A request to take equipment back from a Site, as the record producer and the customer page make it. */
export interface RequestedEquipment {
    /**
     * The Return order the record producer saved for the request, which names its Customer, Site and method; none
     * when the request has saved nothing yet.
     */
    produced?: GlideRecord
    customerId: string
    siteId: string
    /** A site decommission: everything installed or shipped at the Site comes back, whatever `listedAssetIds` names. */
    decommission: boolean
    listedAssetIds: readonly string[]
    /** How the units come back; '' leaves it to the Site contact to ship them. */
    method: ReturnMethod | ''
    /** The Return's short description, given the Site's name. */
    describe(siteName: string): string
}

/** Why a return request raised no Return (`RequestOutcome`). */
type NotRaised = 'forbidden' | 'invalid' | 'nothing' | 'awaited' | 'busy' | 'refused'

/**
 * What came of a return request: the Return raised (it may have no line: each Asset already awaits another return, or
 * was refused), or why none was. `forbidden`: the requester may not ask; `invalid`: the Customer or Site it names;
 * `nothing`: it names nothing to bring back; `awaited`: each device it names already awaits a return; `busy`: another
 * request of the Customer is being raised; `refused`: the platform refused the Return order (logged).
 */
export type RequestOutcome = ({ raised: true } & RaisedReturn) | { raised: false; reason: NotRaised; why: string }

function notRaised(reason: NotRaised, why: string): RequestOutcome {
    return { raised: false, reason, why }
}

/**
 * Raise the Return the signed-in user requests, from the record producer or the customer page. The Return create rule
 * must let them request it for its Customer, and the Site must be one of the Customer's Sites (domain/returns
 * `returnRequestFindings`): the producer does not apply that rule and its Customer and Site are only qualified in the
 * browser, and locations have no visibility rule (ADR 0005), so any location's sys_id is found. All of that is checked
 * before the Site's devices are read. A site decommission returns everything installed or shipped at the Site
 * (domain/returns `SITE_RECOVERY_STAGES`); a device removal the listed fleet assets (ADR 0016) deployed at the Site,
 * as a list qualified in the browser, or sent to the API, may name any Asset. The Return runs under the Agreement of
 * its first Asset unless the produced Return order names one.
 *
 * A request that names nothing to bring back is refused when it has saved nothing yet, so the customer page leaves no
 * empty Return behind. The producer's Return order is saved already: it is filled in and, with no line, closes at once
 * like any Return with nothing to bring back.
 *
 * A request that has saved nothing yet (the customer page's) is raised under its Customer's return-request lock
 * (domain/lock-names `returnRequest`, ADR 0013), one at a time, and only for devices not already awaiting a return: a
 * request sent twice raises one Return order, with one de-install work order and change. One that finds the lock held
 * raises nothing (`busy`), nor does one whose devices all await a return already (`awaited`).
 */
export function requestReturn(request: RequestedEquipment): RequestOutcome {
    const { produced, customerId, siteId } = request
    const site = findById('cmn_location', siteId)
    const [finding] = returnRequestFindings({ customerId, site: requestedSite(siteId, site) }, returnRequester(produced))
    if (finding) return notRaised(finding.about === 'requester' ? 'forbidden' : 'invalid', finding.message)
    if (produced) return raiseRequested(request, site)
    const raised = withLock(LOCK.returnRequest(customerId), () => raiseRequested(request, site))
    return raised.ran ? raised.value : notRaised('busy', 'Another return request of yours is being raised: try again in a moment')
}

/** Raise the requested Return, its requester and Site checked (`requestReturn`); the customer page's holding its Customer's return-request lock. */
function raiseRequested(request: RequestedEquipment, site: GlideRecord | null): RequestOutcome {
    const { produced, customerId, siteId } = request
    const trigger = requestedTrigger(request.decommission)
    const requested = isSiteRecovery(trigger) ? installedAssetIds({ siteId, returning: trigger }) : fleetAssetsAt(siteId, request.listedAssetIds)
    if (!produced && requested.length === 0) {
        return notRaised('nothing', request.decommission ? 'The site has no installed devices' : "Choose at least one of the site's devices")
    }
    // Read under the lock: a request sent again after the first was raised finds its devices awaiting that Return.
    const assetIds = produced ? requested : requested.filter((id) => !awaitsReturn(id))
    if (!produced && assetIds.length === 0) return notRaised('awaited', 'Each device is already on a return')
    const firstAsset = findById('alm_hardware', assetIds[0] ?? '')
    const details: ReturnRequest = {
        trigger,
        customerId,
        siteId,
        agreementId: (produced ? str(produced, 'agreement') : '') || (firstAsset ? str(firstAsset, 'x_daas_ham_agreement') : ''),
        method: request.method || 'ship_back',
        assetIds,
        description: request.describe(site ? str(site, 'name') : ''),
    }
    const raised = produced ? fillReturn(produced, details) : raiseReturn(details)
    return raised ? { raised: true, ...raised } : notRaised('refused', 'the platform refused it')
}

/**
 * Raise the Return the record producer just saved (`requestReturn`, which reads the request from it and the Assets it
 * `listedAssetIds`). The producer does not apply the Return create rule, so a Return that is not raised (its requester
 * may not ask for it, its Site is not its Customer's, or the platform refused it) is removed again, as an Order raised
 * in vain is (platform/orders `submitProducedOrder`): never filled in, it moves nothing. One the platform keeps is
 * logged, to cancel by hand.
 */
export function requestProducedReturn(order: GlideRecord, listedAssetIds: readonly string[]): RequestOutcome {
    const outcome = requestReturn({
        produced: order,
        customerId: str(order, 'customer'),
        siteId: str(order, 'site'),
        decommission: str(order, 'trigger') === RETURN_TRIGGER.site_decommission,
        listedAssetIds,
        method: str(order, 'method') as ReturnMethod | '',
        describe: () => str(order, 'short_description') || `Return from ${order.getDisplayValue('site')}`,
    })
    if (!outcome.raised && !order.deleteRecord()) warnRefused(order, `Refused return ${str(order, 'number')} not removed`)
    return outcome
}

/** The location a request names, as domain/returns reads it: whose it is and whether it is a Site at all. */
function requestedSite(siteId: string, site: GlideRecord | null): RequestedReturn['site'] {
    if (!siteId) return undefined
    return { id: siteId, customerId: site ? str(site, 'company') : null, isSite: !!site && bool(site, SITE_FIELD) }
}

/** The signed-in user as a Return requester: one the Return create rule lets create a Return order. */
function returnRequester(produced: GlideRecord | undefined): ReturnRequester {
    const { permitted, scope, customerId } = creatorOf(produced ?? new GlideRecord(RETURN))
    return { mayRequest: permitted, scope, customerId }
}

/**
 * Those of `listed` that are fleet assets deployed at the Site (visibility rules apply). One declared missing keeps its
 * Site: put on this Return too, it would be declared missing again and charged a second lost fee.
 */
function fleetAssetsAt(siteId: string, listed: readonly string[]): string[] {
    return listed.filter((id) => {
        const asset = findById('alm_hardware', id)
        return !!asset && isFleetAsset(asset) && str(asset, 'x_daas_ham_site') === siteId && isDeployed(readStage(asset))
    })
}

function latestReturnLine(assetId: string, statuses: readonly ReturnLineStatus[]): GlideRecord | null {
    const line = new GlideRecord(RETURN_LINE)
    line.addQuery('asset', assetId)
    line.addQuery('status', 'IN', statuses.join(','))
    line.orderByDesc('sys_created_on')
    line.setLimit(1)
    line.query()
    return line.next() ? line : null
}

/**
 * What came of receiving a unit at the depot as a return: it is not coming back from a Site (it is received as stock
 * instead), it is received, or the lifecycle or the platform refused the receipt and why.
 */
export type ReturnReceipt = 'not_returning' | 'received' | { refused: string }

/**
 * A returned Asset arrived at the depot: it awaits evaluation, its subscription line no longer includes it, its earlier
 * wipe evidence no longer counts, and a late return is charged. A refused unit stays pending return (or missing), with
 * nothing settled, to scan again. The caller holds the unit's receive lock (platform/receiving), which the overdue
 * job's declaration takes too, so a unit is never received and declared at once.
 */
export function receiveReturnedAsset(asset: GlideRecord, stockroomId: string): ReturnReceipt {
    if (readStage(asset) !== 'pending_return' && readStage(asset) !== 'missing') return 'not_returning'
    const line = latestReturnLine(asset.getUniqueValue(), SETTLED_BY_RECEIPT)
    const siteId = str(asset, 'x_daas_ham_site')
    asset.setValue('stockroom', stockroomId)
    asset.setValue('x_daas_ham_site', '')
    asset.setValue('x_daas_ham_subscription_line', '')
    // A wipe recorded before this receipt does not cover what it picked up at the Site, so it must be wiped again.
    clearWipeEvidence(asset)
    clearRackPlacement(asset)
    const refused = moveRefusal(asset, 'pending_evaluation')
    if (refused) return { refused }
    endSitePackageIfEmpty(siteId, str(asset, 'x_daas_ham_agreement'))
    if (line) settleReceivedLine(line, asset)
    return 'received'
}

/** Mark the line of a unit just received, and charge or waive what its arrival settles. */
function settleReceivedLine(line: GlideRecord, asset: GlideRecord): void {
    const turnedUp = str(line, 'status') === RETURN_LINE_STATUS.missing
    line.setValue('status', RETURN_LINE_STATUS.received)
    line.setValue('received_at', nowGlide())
    // The unit is received all the same; a line left unreceived cannot be evaluated, so it is logged to fix by hand.
    const serial = str(asset, 'serial_number')
    const lineOf = `Line of ${serial} on ${line.getDisplayValue('return_order')}`
    if (!line.update()) warnRefused(line, `${lineOf} not marked received`)
    const returnOrder = findById(RETURN, str(line, 'return_order'))
    if (!returnOrder) return
    if (turnedUp) {
        // Declared missing, then found: it is late, not lost, and its line needs evaluating again.
        waiveOpenFees('lost', asset.getUniqueValue(), returnOrder.getUniqueValue())
        returnOrder.setValue('state', RETURN_TASK_STATE.inProgress)
        if (!returnOrder.update()) warnRefused(returnOrder, `${str(returnOrder, 'number')} not reopened for ${serial}`)
    }
    if (receivedLate(str(returnOrder, 'due_back'), todayIso())) recordFee('late_return', asset, returnOrder.getUniqueValue())
}

/** What came of an evaluation: the Asset moved on and its line is evaluated, or why not. */
export type Evaluation = { evaluated: true } | { evaluated: false; why: string }

function notEvaluated(why: string): Evaluation {
    return { evaluated: false, why }
}

/**
 * Route the Asset of a return line whose evaluation was set onward, and mark the line evaluated. A unit its owner
 * takes back, the Customer or the Lessor of a lease being returned, goes to wiping, not stock (domain/returns
 * `evaluationTarget`). A refused move leaves the line received, so the evaluation can be chosen again.
 */
export function evaluateReturnLine(line: GlideRecord): Evaluation {
    const asset = findById('alm_hardware', str(line, 'asset'))
    if (!asset || readStage(asset) !== 'pending_evaluation') {
        return notEvaluated('Evaluate the asset after it has been received at the depot')
    }
    const target = evaluationTarget(str(line, 'evaluation') as EvaluationOutcome, {
        legalOwner: str(asset, 'x_daas_ham_legal_owner') as LegalOwner | '',
        leaseEndAction: str(asset, 'x_daas_ham_lease.end_action') as LeaseEndAction | '',
    })
    // Charged before refurbishing hands the unit back to the Provider; choosing the evaluation again charges it once.
    if (choice<ReturnCondition>(line, 'condition') === 'damaged') recordFee('damaged', asset, str(line, 'return_order'))
    if (target === 'available') releaseToProviderStock(asset)
    const refused = moveRefusal(asset, target)
    if (refused) return notEvaluated(`The asset was not moved to ${target}: ${refused}`)
    line.setValue('status', RETURN_LINE_STATUS.evaluated)
    if (!line.update()) {
        return notEvaluated(`The asset went to ${target}, but its return line was not marked evaluated: ${refusal(line)}`)
    }
    closeReturnIfDone(str(line, 'return_order'))
    return { evaluated: true }
}

/** Escalate overdue returns once, then declare the Assets missing and charge the lost-asset fee (the daily job). */
export function chaseOverdue(): void {
    const today = todayIso()
    const grace = intProperty(PROPERTY.returnGraceDays)
    runTableJob({
        job: 'chase_overdue_returns',
        table: RETURN_LINE,
        query: `status=${AWAITED}^return_order.due_back<${today}`,
        read: (line) => ({
            assetId: str(line, 'asset'),
            returnOrderId: str(line, 'return_order'),
            dueDate: str(line, 'return_order.due_back'),
        }),
        handle: (line, lineId) => {
            // Read the header fresh: an earlier line of the same order may have escalated it in this batch.
            const returnOrder = findById(RETURN, line.returnOrderId)
            if (!returnOrder) return
            const number = str(returnOrder, 'number')
            const step = overdueStep({ dueDate: line.dueDate, today, graceDays: grace, received: false, escalated: bool(returnOrder, 'escalated') })
            if (step === 'escalate') {
                returnOrder.setValue('escalated', true)
                returnOrder.setValue('work_notes', `Return overdue since ${line.dueDate}; customer and account manager notified.`)
                // Not marked escalated, it would be escalated again every day: nobody is told until the mark holds.
                if (!returnOrder.update()) return void warnRefused(returnOrder, `${number} not escalated`)
                const recipients = [...customerAdminIds(str(returnOrder, 'customer')), str(returnOrder, 'agreement.account_manager')]
                fire(EVENT.returnOverdue, returnOrder, recipients.filter(Boolean).join(','), line.assetId)
            } else if (step === 'declare_missing') {
                declareMissing({ lineId, assetId: line.assetId, returnOrderId: line.returnOrderId, number })
            }
        },
    })
}

/** An overdue return line to declare missing, with its Return order's number for the log. */
interface OverdueLine {
    lineId: string
    assetId: string
    returnOrderId: string
    number: string
}

/**
 * Declare an overdue unit missing and charge its lost fee. The unit may be scanned in at the depot meanwhile, and a
 * receipt saved between this run's read and its saves would be overwritten: back on the shelf, yet its line missing and
 * a lost fee billed. So this is done under the lock the receipt takes (platform/receiving `receive`), from a fresh
 * read. A run that finds the lock held leaves the line awaiting: the next day's run finds the unit received, or
 * declares it then. Taking the lock throws only when an insert is refused with no lock row (platform/locks); the job
 * counts that line as failed and goes on.
 */
function declareMissing(overdue: OverdueLine): void {
    const declared = withLock(LOCK.receiveAsset(overdue.assetId), (lock) => declareHolding(lock, overdue))
    if (declared.ran && declared.value) closeReturnIfDone(overdue.returnOrderId)
}

/**
 * The declaration, made holding the unit's receive `lock`: only while its line still awaits it and the Asset is still
 * at or towards the Site in a stage the lifecycle lets go missing (`mayGoMissing`), or missing already (an earlier run
 * whose line was refused). True once the line is missing. A unit anywhere else (received, its line refused), or one
 * the lifecycle keeps from going missing, or outside the fleet (a line raised before the Fleet flag, ADR 0016), is
 * logged each run, with no move tried: no run settles that line.
 */
function declareHolding(lock: HeldLock, overdue: OverdueLine): boolean {
    const record = findById(RETURN_LINE, overdue.lineId)
    if (!record || str(record, 'status') !== AWAITED) return false
    const asset = findById('alm_hardware', overdue.assetId)
    if (asset && !isFleetAsset(asset)) {
        const unit = `Line of ${str(asset, 'serial_number')} on ${overdue.number}`
        gs.warn(`[x_daas_ham] ${unit} not declared missing: it is not a fleet asset; settle the line by hand`)
        return false
    }
    const stage = asset ? readStage(asset) : null
    if (asset && stage !== 'missing' && !mayGoMissing(asset, stage)) {
        const unit = `Line of ${str(asset, 'serial_number')} on ${overdue.number}`
        gs.warn(`[x_daas_ham] ${unit} not declared missing: the unit is ${stage ?? 'unknown'}; settle the line by hand`)
        return false
    }
    // A holder that outlasted the lock (ADR 0013) may overlap the next receipt: it saves only while it holds it.
    if (!lock.held()) return false
    if (asset) {
        clearRackPlacement(asset)
        // Refused (moveAndSave warns): the unit and its awaiting line stay as they are, for the next run.
        if (!moveAndSave(asset, 'missing', `return ${overdue.number} overdue`)) return false
        recordFee('lost', asset, overdue.returnOrderId)
        // A missing unit no longer holds its site package open. It keeps its Site and line so that, found again and
        // back in service, it bills on that line again while it is open (entry/assets.ts onAssetServiceChange).
        endSitePackageIfEmpty(str(asset, 'x_daas_ham_site'), str(asset, 'x_daas_ham_agreement'))
    }
    record.setValue('status', RETURN_LINE_STATUS.missing)
    // Left awaiting, it is declared again on the next run, which finds the unit missing and charges no second fee
    // (platform/fees `recordFee`).
    if (record.update()) return true
    const unit = asset ? str(asset, 'serial_number') : overdue.assetId
    warnRefused(record, `Line of ${unit} on ${overdue.number} not declared missing`)
    return false
}

/** Whether the unit is at or towards its Site in a stage the lifecycle moves to missing (domain/lifecycle `checkTransition`). */
function mayGoMissing(asset: GlideRecord, stage: Stage | null): boolean {
    return isDeployed(stage) && checkTransition(stage, 'missing', transitionFacts(asset)).allowed
}

/** Close a Return order once every line is evaluated or declared missing. */
function closeReturnIfDone(returnOrderId: string): void {
    if (exists(RETURN_LINE, `return_order=${returnOrderId}^statusIN${KEEPS_RETURN_OPEN.join(',')}`)) return
    const order = findById(RETURN, returnOrderId)
    if (!order || str(order, 'state') === String(RETURN_TASK_STATE.closed)) return
    order.setValue('state', RETURN_TASK_STATE.closed)
    // No later line calls this again, and an open Return still asks the Customer for its equipment.
    if (!order.update()) warnRefused(order, `Return ${str(order, 'number')} not closed, close it`)
}
