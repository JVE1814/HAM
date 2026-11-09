import { GlideDateTime, GlideRecord, gs } from '@servicenow/glide'
import { groupDecisions, rollupApprovals, type ApprovalDecision, type ApprovalOutcome } from '../domain/approvals.ts'
import { appendTo } from '../domain/collections.ts'
import {
    agreementUsageLockName,
    approversFor,
    assessOrder,
    OPEN_LINE_STAGES,
    ownershipFindings,
    raiserRefusal,
    readsUsage,
    siteTemplateOffered,
    type Approver,
    type EntitlementVerdict,
    type NamedRecord,
    type Orderer,
    type OrderParties,
    type RequestedLine,
} from '../domain/entitlement.ts'
import { anythingShipped, approvalAwaited } from '../domain/fulfilment.ts'
import { shortfallRoute, type ShortfallRoute } from '../domain/returns.ts'
import {
    advanceReplacementRma,
    lineStillOpen,
    orderEnded,
    orderLineLockName,
    planSourcing,
    shortfallOutcome,
    sourcingLockName,
    type Source,
    type SourcingRequest,
    type UnmovedStock,
} from '../domain/sourcing.ts'
import { entitlementContext } from '../platform/agreements.ts'
import {
    approvalsOf,
    cancelPendingApprovals,
    customerAdminIds,
    providerApproverIds,
    requestApprovals,
} from '../platform/approvals.ts'
import { moveAndSave, readStage } from '../platform/assets.ts'
import { beyondVisibility } from '../platform/beyond-visibility.ts'
import { EVENT, fire } from '../platform/events.ts'
import { orderShipment, recomputeLine, recomputeOrder } from '../platform/fulfilment.ts'
import { todayIso } from '../platform/clock.ts'
import { withLock, withLockTries, type HeldLock } from '../platform/locks.ts'
import { openOemRma, openRmaCount, openRmasFor, reuseOemRma } from '../platform/oem-rma.ts'
import { requestPurchase } from '../platform/procurement.ts'
import { PROPERTY, stagingStockroom, stringProperty } from '../platform/properties.ts'
import { bool, count, findById, num, refusal, str } from '../platform/records.ts'
import { currentSession } from '../platform/session.ts'
import { openStagingTask } from '../platform/staging-tasks.ts'
import { linkHotSpare, reserveAsset, stockCandidates } from '../platform/stock.ts'
import { requestTransfer } from '../platform/transfers.ts'

/*
 * Entry points: parameter names must be the platform globals (current, previous, event, producer,
 * request, response) because the SDK's generated wrapper passes them by name.
 *
 * Order orchestration (ADR 0004):
 * submit -> entitlement -> approvals -> sourcing (event) -> staging -> ship -> install -> in service.
 * Stages after sourcing are derived from Asset stages (platform/fulfilment).
 */

interface DeviceRow {
    model?: string
    quantity?: string | number
}

/**
 * Record producer post-insert script: create the lines and submit the Order. The producer does not apply the Order
 * create rule, so an Order its requester may not raise for that Customer is removed again. One that names records
 * that are not its Customer's stays a draft to correct, without the lines of a Site template not offered to it, and so
 * does one missing a line the platform refused (it would be assessed and sourced short of what was asked for).
 * (`current` is typed unknown because the SDK passes its own GlideRecord type here.)
 */
export function afterOrderProduced(producer: Record<string, unknown>, current: unknown): void {
    const order = current as GlideRecord
    const parties = orderParties(order)
    const raiser = orderingUser(order)
    const refusal = raiserRefusal(parties.customerId, raiser)
    if (refusal) {
        gs.addErrorMessage(`Order not raised. ${refusal}.`)
        // The producer has already saved it: one the platform keeps is named, to cancel.
        if (!order.deleteRecord()) saveRefused(order, `${str(order, 'number')} not removed (${refusal}), cancel it`)
        return
    }
    let unsaved = 0
    if (parties.siteTemplate && siteTemplateOffered(parties)) {
        unsaved += addLinesFromSiteTemplate(order, parties.siteTemplate.id)
    }
    for (const row of parseRows(producer.devices)) {
        if (row.model && !addLine(order, String(row.model), Math.max(1, Number(row.quantity) || 1), false)) unsaved++
    }
    const missing = unsaved > 0 ? [`${unsaved} order line(s) not saved (see the system log): add them`] : []
    submitAsRaised(order, parties, raiser, missing, { via: 'producer', tries: 0 })
}

function parseRows(value: unknown): DeviceRow[] {
    try {
        const rows = JSON.parse(String(value ?? '[]'))
        return Array.isArray(rows) ? rows : []
    } catch {
        return []
    }
}

/** Add the Site template's non-optional items as lines; how many the platform refused (logged). */
function addLinesFromSiteTemplate(order: GlideRecord, siteTemplateId: string): number {
    const item = new GlideRecord('x_daas_ham_site_template_item')
    item.addQuery('site_template', siteTemplateId)
    item.addQuery('optional', false)
    item.query()
    let unsaved = 0
    while (item.next()) {
        if (!addLine(order, str(item, 'model'), num(item, 'quantity'), true)) unsaved++
    }
    return unsaved
}

/** Add one line to the Order; false (logged) when the platform refuses it. */
function addLine(order: GlideRecord, modelId: string, quantity: number, fromSiteTemplate: boolean): boolean {
    const line = new GlideRecord('x_daas_ham_order_line')
    line.initialize()
    line.setValue('order', order.getUniqueValue())
    line.setValue('model', modelId)
    line.setValue('quantity', quantity)
    line.setValue('from_site_template', fromSiteTemplate)
    if (line.insert()) return true
    saveRefused(line, `${str(order, 'number')}: no line for model ${modelId}`)
    return false
}

/** Why the platform refused to save `record`, logged with what that leaves undone. */
function saveRefused(record: GlideRecord, undone: string): string {
    const reason = refusal(record)
    gs.warn(`[x_daas_ham] ${undone}: ${reason}`)
    return reason
}

/** The signed-in user as the raiser of `order`: an Order raiser when the Order create rule lets them create it. */
function orderingUser(order: GlideRecord): Orderer {
    const { scope, customerId } = currentSession()
    return { mayRaise: order.canCreate(), scope, customerId }
}

/**
 * The records the Order names and whose they are, read as the signed-in user: the visibility rules (ADR 0005) hide
 * another Customer's Agreement from a customer contact, so it reads as belonging to no one they may order for.
 */
function orderParties(order: GlideRecord): OrderParties {
    const named = (field: string, table: string, customerField: string): NamedRecord | undefined => {
        const id = str(order, field)
        if (!id) return undefined
        const record = findById(table, id)
        return { id, customerId: record ? str(record, customerField) : null }
    }
    const site = named('site', 'cmn_location', 'company')
    return {
        customerId: str(order, 'customer'),
        agreement: named('agreement', 'x_daas_ham_agreement', 'customer'),
        site: site && { ...site, isSite: bool(order, 'site.x_daas_ham_is_site') },
        siteTemplate: named('site_template', 'x_daas_ham_site_template', 'customer'),
    }
}

/**
 * How a submission came, which says who is told its outcome: the record producer (its raiser, often a Customer admin,
 * has no Submit action), a submission queued again (`submitLater`, run as the system), or any other (Submit, Raise
 * replacement, the refresh run); and how many times it was queued again.
 */
interface Submission {
    via: 'submit' | 'producer' | 'queued'
    tries: number
}

/**
 * UI action "Submit" on a draft Order, and the end of break-fix and refresh Orders. Returns whether the Order went
 * ahead (to approval or sourcing), also when another submission of it took it ahead; otherwise it stays a draft.
 */
export function submitOrder(order: GlideRecord): boolean {
    return submitAsRaised(order, orderParties(order), orderingUser(order), [], { via: 'submit', tries: 0 })
}

/**
 * Submit the Order unless it cannot go ahead as raised (domain/entitlement `ownershipFindings`, or the `unsaved`
 * lines); then it stays a draft, and the user is told why and the reasons are noted on it.
 */
function submitAsRaised(order: GlideRecord, parties: OrderParties, raiser: Orderer, unsaved: string[], submission: Submission): boolean {
    const findings = [...ownershipFindings(parties, raiser), ...unsaved]
    if (findings.length === 0) return submitAccepted(order, submission)
    gs.addErrorMessage(`Order not submitted. ${findings.join('. ')}.`)
    order.setValue('work_notes', `Not submitted:\n${findings.join('\n')}`)
    // A refresh Order the daily job raised has only this note to say why it is a draft.
    if (!order.update()) saveRefused(order, `${str(order, 'number')} not submitted (${findings.join('; ')}), and its note not saved`)
    return false
}

/**
 * Tries at taking an Agreement's usage lock: a holder keeps it only to read the Order, its lines and the Agreement's
 * usage, ask approvers and save the Order, so as many as for an Order line.
 */
const AGREEMENT_LOCK_TRIES = 10

/**
 * Assess and submit the Order. Two submissions of one Agreement reading its usage at once would each miss the other
 * and could both go ahead within a Contracted quantity only one fits, so an Order whose lines read usage
 * (domain/entitlement `readsUsage`) is assessed and saved out of draft holding the Agreement's job lock
 * (`agreementUsageLockName`, ADR 0013); one replacing Assets only reads none and takes no lock. A submission that
 * finds the lock held through every try is queued again (`submitLater`). Taking the lock throws only when an insert is
 * refused with no lock row (platform/locks): that error escapes.
 */
function submitAccepted(order: GlideRecord, submission: Submission): boolean {
    const lines = requestedLines(order.getUniqueValue())
    if (lines.length === 0) {
        gs.addErrorMessage('Add at least one order line before submitting')
        return false
    }
    if (!readsUsage(lines)) return submitHolding(null, order)
    // Set inside the Agreement's lock; the work returns nothing, so it runs once (platform/locks `withLockTries`).
    let submitted = false as boolean
    const ran = withLockTries(agreementUsageLockName(str(order, 'agreement')), AGREEMENT_LOCK_TRIES, (lock) => {
        submitted = submitHolding(lock, order)
    })
    return ran ? submitted : submitLater(order, submission)
}

/**
 * The submission, holding the Agreement's `usageLock` (null for an Order that reads no usage). The Order, its lines and
 * the Agreement's quantities and usage are read afresh here, so what is assessed is what is saved; it goes on only
 * from draft, under the Agreement and Customer whose lock and ownership check were taken. The caller's `order` is
 * saved, so its in-memory record shows the outcome.
 */
function submitHolding(usageLock: HeldLock | null, order: GlideRecord): boolean {
    const fresh = findById('x_daas_ham_order', order.getUniqueValue())
    if (!fresh) return notSubmitted('it can no longer be read')
    if (str(fresh, 'stage') !== 'draft') return alreadySubmitted(fresh)
    if (str(fresh, 'agreement') !== str(order, 'agreement') || str(fresh, 'customer') !== str(order, 'customer')) {
        return notSubmitted('its Customer or Agreement changed while it was submitted. Submit it again')
    }
    const lines = requestedLines(order.getUniqueValue())
    if (lines.length === 0) return notSubmitted('add at least one order line first')
    if (!usageLock && readsUsage(lines)) return notSubmitted('a line was added while it was submitted. Submit it again')
    const assessment = assessOrder(
        { siteTemplateId: str(order, 'site_template') || undefined, lines },
        entitlementContext(str(order, 'customer'), str(order, 'agreement'), order.getUniqueValue()),
    )
    order.setValue('entitlement_verdict', assessment.verdict)
    order.setValue('entitlement_findings', assessment.findings.join('\n'))

    if (assessment.approvers.length === 0) {
        const refused = startSourcing(order)
        if (refused) gs.addErrorMessage(`Order not submitted: ${refused}`)
        else warnIfUsageLockLost(usageLock, order)
        return !refused
    }
    // Ask first: an Order the requests saved could not approve would wait for ever, so it stays a draft.
    const admins = customerAdminIds(str(order, 'customer'))
    const refusal = requestApprovals(
        order,
        approverIds(order, assessment.verdict, admins),
        assessment.approvers,
        admins,
        'no account manager or asset manager to approve it',
    )
    if (refusal) {
        gs.addErrorMessage(`Order not submitted: ${refusal}.`)
        order.setValue('work_notes', `Not submitted: ${refusal}`)
        if (!order.update()) saveRefused(order, `${str(order, 'number')} not submitted (${refusal}), and its note not saved`)
        return false
    }
    order.setValue('stage', 'awaiting_approval')
    order.setValue('approval', 'requested')
    if (order.update()) {
        warnIfUsageLockLost(usageLock, order)
        return true
    }
    // The requests would wait on a draft, whose decisions roll up to nothing: they are taken back.
    const reason = saveRefused(order, `${str(order, 'number')} not saved as awaiting approval, its requests cancelled`)
    cancelPendingApprovals(order.getUniqueValue())
    gs.addErrorMessage(`Order not submitted: ${reason}`)
    return false
}

function notSubmitted(why: string): false {
    gs.addErrorMessage(`Order not submitted: ${why}`)
    return false
}

/** An Order a submission finds out of draft: gone ahead, through another submission of it (true), or ended (false). */
function alreadySubmitted(fresh: GlideRecord): boolean {
    const stage = fresh.getDisplayValue('stage')
    if (orderEnded(str(fresh, 'stage'))) return notSubmitted(`it is ${stage}`)
    gs.addInfoMessage(`Order ${str(fresh, 'number')} was already submitted (${stage})`)
    return true
}

/** A holder that outlasted the lock (ADR 0013) may have assessed beside a submission that took it over. */
function warnIfUsageLockLost(usageLock: HeldLock | null, order: GlideRecord): void {
    if (!usageLock || usageLock.held()) return
    gs.warn(`[x_daas_ham] ${str(order, 'number')} submitted after its Agreement's usage lock was lost: check the Agreement's Orders against its contracted quantities`)
}

/** parm1 of the sourcing event when it carries a submission queued again (`submitLater`), which `sourceOrder` runs. */
const SUBMIT_AGAIN = 'submit'

/**
 * A submission that found its Agreement's usage lock held through every try. Unless another submission of this same
 * Order took it ahead (then it went ahead), the Order stays a draft for now, noted, and is submitted again a minute
 * later from the event queue, SOURCING_TRIES times at most, then left for staff to submit (logged). Each is told in
 * words that fit them: the record producer's raiser has no Submit action, so is told not to raise it again.
 */
function submitLater(order: GlideRecord, submission: Submission): boolean {
    const fresh = findById('x_daas_ham_order', order.getUniqueValue())
    if (!fresh) return notSubmitted('it can no longer be read')
    if (str(fresh, 'stage') !== 'draft') return alreadySubmitted(fresh)
    const number = str(order, 'number')
    const lockName = agreementUsageLockName(str(order, 'agreement'))
    if (submission.tries >= SOURCING_TRIES) {
        gs.warn(`[x_daas_ham] ${number} left a draft: ${lockName} stayed held through ${submission.tries} submissions queued again; submit it`)
        noteDraft(order, 'Not submitted: other Orders of its Agreement kept being submitted at the same time. Submit it')
        return false
    }
    if (submission.tries === 0) {
        noteDraft(order, 'Not submitted yet: another Order of its Agreement was being submitted at the same time. It is submitted again automatically')
    }
    gs.info(`[x_daas_ham] ${number} submitted again in ${SOURCING_RETRY_SECONDS} s: another submission holds ${lockName}`)
    const when = new GlideDateTime()
    when.addSeconds(SOURCING_RETRY_SECONDS)
    gs.eventQueueScheduled(EVENT.sourceOrder, order, SUBMIT_AGAIN, String(submission.tries + 1), when)
    if (submission.via === 'producer') {
        gs.addInfoMessage(`Order ${number} is saved and is submitted within a few minutes: another order of the same agreement was being submitted at that moment. There is no need to raise it again`)
    } else if (submission.via === 'submit') {
        gs.addErrorMessage('Order not submitted yet: another Order of its Agreement was being submitted at the same time. It is submitted again automatically in a minute')
    }
    return false
}

/** Note on a draft why it is one; a refused note is logged. */
function noteDraft(order: GlideRecord, note: string): void {
    order.setValue('work_notes', note)
    if (!order.update()) saveRefused(order, `${str(order, 'number')} left a draft, its note not saved (${note})`)
}

/**
 * A submission queued again (`submitLater`), run as the system from the event queue: the Order read afresh is
 * submitted as Submit does, its records' ownership checked again, unless it is no longer a draft (submitted or
 * cancelled meanwhile).
 */
function submitQueued(queued: GlideRecord, tries: number): void {
    const order = findById('x_daas_ham_order', queued.getUniqueValue())
    if (!order || str(order, 'stage') !== 'draft') return
    submitAsRaised(order, orderParties(order), orderingUser(order), [], { via: 'queued', tries })
}

function requestedLines(orderId: string): RequestedLine[] {
    const line = new GlideRecord('x_daas_ham_order_line')
    line.addQuery('order', orderId)
    line.addQuery('line_stage', '!=', 'cancelled')
    line.query()
    const lines: RequestedLine[] = []
    while (line.next()) {
        lines.push({
            modelId: str(line, 'model'),
            deviceClass: str(line, 'model.x_daas_ham_device_class'),
            quantity: num(line, 'quantity'),
            fromSiteTemplate: bool(line, 'from_site_template'),
            replacesAsset: !!str(line, 'replaces_asset'),
        })
    }
    return lines
}

/**
 * Customer admins for the customer-admin group (provider approvers stand in when the Customer has
 * none); the account manager, or else the asset managers, for the account-manager group.
 */
function approverIds(order: GlideRecord, verdict: EntitlementVerdict, customerAdmins: readonly string[]): string[] {
    const provider = providerApproverIds(str(order, 'agreement.account_manager'))
    const ids = new Set<string>()
    for (const group of approversFor(verdict)) {
        const admins = group === 'customer_admin' ? customerAdmins : []
        for (const id of admins.length > 0 ? admins : provider) ids.add(id)
    }
    return [...ids]
}

/** Approve the Order and source it; why the platform refused the save ('' once saved), when nothing is sourced. */
function startSourcing(order: GlideRecord): string {
    order.setValue('approval', 'approved')
    order.setValue('stage', 'sourcing')
    order.setValue('state', 2)
    if (!order.update()) return saveRefused(order, `${str(order, 'number')} not saved as approved, not sourced`)
    fire(EVENT.sourceOrder, order)
    return ''
}

/** After-update rule on sysapproval_approver: roll the decisions up to the Order. */
export function onOrderApprovalDecision(current: GlideRecord): void {
    const order = findById('x_daas_ham_order', str(current, 'document_id'))
    if (order) rollUpApprovals(order)
}

/** What rolling an Order's approvals up found: the outcome, and why the platform refused to save it ('' once saved). */
interface ApprovalRollup {
    outcome: ApprovalOutcome
    refused: string
    required: Approver[]
    decisions: ApprovalDecision[]
}

/**
 * Roll the approvals of an Order awaiting approval up (null for any other Order) and save the outcome: approved and
 * sourced, or rejected. The approval decision rule and Re-check approvals both run this.
 */
function rollUpApprovals(order: GlideRecord): ApprovalRollup | null {
    if (str(order, 'stage') !== 'awaiting_approval') return null
    const required = approversFor(str(order, 'entitlement_verdict') as EntitlementVerdict)
    const decisions = groupDecisions(approvalsOf(order.getUniqueValue()), customerAdminIds(str(order, 'customer')))
    const outcome = rollupApprovals(required, decisions)
    if (outcome === 'requested') return { outcome, refused: '', required, decisions }
    const refused = outcome === 'approved' ? startSourcing(order) : rejectOrder(order)
    // Each cancellation runs this rule again, which stops once the Order is saved out of awaiting approval. A refused
    // save keeps it awaiting approval with its requests, so the next decision (or Re-check approvals) tries again.
    if (!refused) cancelPendingApprovals(order.getUniqueValue())
    return { outcome, refused, required, decisions }
}

/**
 * UI action "Re-check approvals": roll an Order's approvals up again, as a decision does, for one whose last decision
 * could not be saved and that no request is left to move on; the user is told the outcome, or why there is none yet.
 * The Order is read afresh: a decision may have moved it since the form was opened.
 */
export function recheckApprovals(orderId: string): void {
    const order = findById('x_daas_ham_order', orderId)
    const rollup = order && rollUpApprovals(order)
    if (!rollup) return void gs.addErrorMessage('The Order is no longer awaiting approval')
    if (rollup.outcome === 'requested') {
        const why = approvalAwaited(rollup.required, rollup.decisions)
        return void gs.addErrorMessage(`Order still awaiting approval: ${why}`)
    }
    if (rollup.refused) return void gs.addErrorMessage(`Order not saved as ${rollup.outcome}: ${rollup.refused}`)
    gs.addInfoMessage(rollup.outcome === 'approved' ? 'Order approved: sourcing has started' : 'Order rejected')
}

/**
 * A rejected Order cancels its lines, so they stop counting as usage. The Order is saved first: one the platform
 * refuses keeps its lines. Both are done holding each open line's lock, as Cancel order does (`cancelOrder`), so no
 * receipt gives a unit to a line being cancelled; one that finds a line's lock held changes nothing (logged) and the
 * Order stays awaiting approval, to re-check. Why it was not rejected ('' once saved).
 */
function rejectOrder(order: GlideRecord): string {
    const orderId = order.getUniqueValue()
    const number = str(order, 'number')
    const lineIds = openLineIds(orderId)
    // Set inside the lines' locks.
    let refused = '' as string
    const held = withOrderLineLocks(lineIds, (locks) => {
        order.setValue('approval', 'rejected')
        order.setValue('stage', 'rejected')
        order.setValue('state', 4)
        if (!order.update()) return void (refused = saveRefused(order, `${number} not saved as rejected`))
        cancelOpenLines(orderId, lineIds)
        if (!locks.every((lock) => lock.held())) warnLineLockLost(number)
    })
    if (held) return refused
    gs.warn(`[x_daas_ham] ${number} not rejected: a line's lock stayed held through every try; re-check its approvals`)
    return 'one of its lines is being received or cancelled: re-check its approvals shortly'
}

/**
 * How many times a request to source an Order (`sourceOrder`), or to submit it (`submitLater`), is queued again, a
 * minute apart, while it cannot run.
 */
const SOURCING_TRIES = 15

const SOURCING_RETRY_SECONDS = 60

/**
 * Tries at taking an Order line's lock before giving up: a holder keeps it for a receipt (the Asset, the line, the
 * reservation and the move into staging saved), for sourcing's read of the line or its purchase and save, or for a
 * cancel or rejection of its Order (`withOrderLineLocks`), so a few more than a counter's.
 */
const LINE_LOCK_ATTEMPTS = 10

/** How sourcing left a line: done (sourced, or a refused save logged), or for a pass queued again to finish. */
type LineSourcing = 'done' | 'line busy' | 'lock lost'

const AGAIN_BECAUSE: Record<Exclude<LineSourcing, 'done'>, string> = {
    'line busy': "a line's lock stayed held",
    'lock lost': "the Order's sourcing lock was lost",
}

/**
 * Script action on x_daas_ham.order.source (parm2: how many times this request was queued again): allocate stock,
 * request transfers and purchases. With parm1 SUBMIT_AGAIN it carries a submission queued again instead
 * (`submitLater`), which it runs: one event serves both.
 *
 * Two passes over one Order (two staging tasks failed seconds apart, or one failed while the first pass runs) would
 * count the same shortfall, and one would buy what the other claimed. So a pass holds a lock on the Order, which Cancel
 * order holds too (`cancelOrder`). One that finds it held runs again a minute later rather than leave its work to the
 * holder, which may have counted before the change that queued it; so does a pass that left a line whose lock stayed
 * held, or that lost the Order's lock. A request is queued again SOURCING_TRIES times at most, past the lock's
 * ten-minute abandonment, then dropped with a warning: a lock still held by then was taken after the request was
 * queued, by a pass that counted its change. Taking the lock throws only when an insert is refused with no lock row
 * (platform/locks): that error escapes.
 */
export function sourceOrder(event: GlideRecord, current: GlideRecord): void {
    if (str(event, 'parm1') === SUBMIT_AGAIN) return submitQueued(current, Number(str(event, 'parm2')) || 0)
    const orderId = current.getUniqueValue()
    // Set inside the Order's lock.
    let again = null as Exclude<LineSourcing, 'done'> | null
    const taken = withLock(sourcingLockName(orderId), (lock) => {
        const line = new GlideRecord('x_daas_ham_order_line')
        line.addQuery('order', orderId)
        line.addQuery('line_stage', 'IN', 'new,awaiting_stock')
        line.query()
        while (again !== 'lock lost' && line.next()) {
            const sourced = sourceLine(lock, current, line)
            if (sourced !== 'done') again = sourced
        }
    })
    if (!taken || again) {
        const why = again ? AGAIN_BECAUSE[again] : 'another pass or a cancel holds its lock'
        sourceAgain(current, Number(str(event, 'parm2')) || 0, why)
    }
    if (taken) recomputeOrder(orderId)
}

/** Queue the request to source `order` again a minute later, unless it was already queued again `tries` times. */
function sourceAgain(order: GlideRecord, tries: number, why: string): void {
    const number = str(order, 'number')
    if (tries >= SOURCING_TRIES) {
        return void gs.warn(`[x_daas_ham] ${number} not sourced again after ${tries} tries (${why}): check its lines`)
    }
    gs.info(`[x_daas_ham] ${number} sourced again in ${SOURCING_RETRY_SECONDS} s: ${why}`)
    const when = new GlideDateTime()
    when.addSeconds(SOURCING_RETRY_SECONDS)
    gs.eventQueueScheduled(EVENT.sourceOrder, order, '', String(tries + 1), when)
}

/**
 * Run `work` holding the Order line's lock (domain/sourcing `orderLineLockName`) and return true, or false when other
 * holders kept it through every try. Taking the lock throws only when an insert is refused with no lock row
 * (platform/locks `withLockTries` tries again, and that error escapes only when every try threw), as does an error
 * from `work`.
 */
export function withOrderLineLock(lineId: string, work: (lock: HeldLock) => void): boolean {
    // What `work` did counts once it ran, so whatever it returns never gives the try up (platform/locks).
    return withLockTries(orderLineLockName(lineId), LINE_LOCK_ATTEMPTS, (lock) => {
        work(lock)
    })
}

/**
 * Run `work` holding the lock of every line in `lineIds` (`withOrderLineLock` each), taken one under another in sys_id
 * order (ADR 0013), and return true, or false, with nothing run, when one stayed held through its tries.
 */
function withOrderLineLocks(lineIds: readonly string[], work: (locks: HeldLock[]) => void): boolean {
    const ids = [...lineIds].sort()
    // Set where `work` runs: each withOrderLineLock is true once its own work ran, whether or not the locks it then
    // tried to take under it were taken, so their results say nothing about the innermost.
    let ran = false as boolean
    const holdFrom = (next: number, held: HeldLock[]): void => {
        if (next < ids.length) return void withOrderLineLock(ids[next], (lock) => holdFrom(next + 1, [...held, lock]))
        ran = true
        work(held)
    }
    holdFrom(0, [])
    return ran
}

function warnLineLockLost(number: string): void {
    gs.warn(`[x_daas_ham] ${number}: lines cancelled after a line's lock was lost: check them for units received meanwhile`)
}

/** What sourcing found and did for a line outside its lock: what `settleHolding` routes, buys and saves. */
interface Sourced {
    lineId: string
    modelId: string
    /** Routes what is still missing when the line is saved (domain/returns `shortfallRoute`). */
    route: (missing: number) => ShortfallRoute
    /** The Asset a break-fix line replaces, which an OEM advance replacement is asked for. */
    replaced: GlideRecord | null
    /** What the pass would buy by its own read: the shortfall less the stock it claimed. */
    toPurchase: number
    /** Claimed units put back for want of a transfer order: missing again, but not bought (`shortfallOutcome`). */
    putBack: number
    planSummary: string
    unmoved: UnmovedStock[]
    transfers: string[]
}

/** Source one line holding the Order's `orderLock`; see `LineSourcing`. */
function sourceLine(orderLock: HeldLock, order: GlideRecord, line: GlideRecord): LineSourcing {
    // A pass that outlasted the Order's lock (ADR 0013) may overlap the one that took it over: it sources nothing more.
    if (!orderLock.held()) return leftUnsaved(line, 'lock lost', [])
    const lineId = line.getUniqueValue()
    // Read under the line's lock, where a receipt takes its unit off order and allocates it: seen whole or not at all.
    let shortfall = null as number | null
    const read = withOrderLineLock(lineId, () => {
        shortfall = lineShortfall(lineId)
    })
    if (!read) return 'line busy'
    if (shortfall === null || shortfall <= 0) return 'done'

    const modelId = str(line, 'model')
    const customerId = str(order, 'customer')
    const breakFix = str(order, 'order_type') === 'device_replace'
    const purpose = breakFix ? 'replace' : 'new'
    const request: SourcingRequest = { modelId, quantity: shortfall, customerId, siteId: str(order, 'site'), purpose }
    const plan = planSourcing(request, stockCandidates(request, shortfall * 5 + 50))

    const stagingId = stagingStockroom()
    const reservation = { orderLineId: lineId, customerId, agreementId: str(order, 'agreement') }
    const toStage: GlideRecord[] = []
    const toTransfer = new Map<string, Array<{ asset: GlideRecord; source: Source }>>()
    let reserved = 0
    for (const pick of plan.picks) {
        // A hot spare already at the customer site needs no staging or shipping: it is installed from where it is.
        if (pick.source === 'customer_site_stock') {
            if (linkHotSpare(pick.assetId, reservation)) reserved++
            continue
        }
        const asset = reserveAsset(pick.assetId, reservation)
        if (!asset) continue
        reserved++
        const from = str(asset, 'stockroom')
        if (stagingId && from && from !== stagingId) appendTo(toTransfer, from, { asset, source: pick.source })
        else toStage.push(asset)
    }
    // Stock outside the staging centre is in transfer to it once its transfer order exists; without one it goes back.
    const transfers: string[] = []
    const unmoved: UnmovedStock[] = []
    const inTransfer: GlideRecord[] = []
    let putBack = 0
    for (const [from, picked] of toTransfer) {
        const assets = picked.map(({ asset }) => asset)
        const transfer = requestTransfer({ fromStockroomId: from, toStockroomId: stagingId, modelId, assets })
        if (transfer.ok) {
            transfers.push(transfer.transferId)
            inTransfer.push(...assets)
            continue
        }
        unmoved.push({ units: picked.length, from: picked[0].asset.getDisplayValue('stockroom'), reason: transfer.reason })
        for (const { asset, source } of picked) {
            // As Inventory left it once its line was removed (platform/transfers `requestTransfer`).
            const fresh = findById('alm_hardware', asset.getUniqueValue())
            if (fresh && unreserve(fresh, source)) putBack++
        }
    }
    // An Asset whose Staging task could not be opened stays reserved for the line rather than staging with no task to
    // finish. So does one whose move into staging is refused (moveAndSave warns): the task just opened is skipped
    // (logged when refused), so the unit is reserved for its line with no task, not reserved under an open task.
    for (const asset of toStage) {
        if (!openStagingTask(asset, lineId) || moveAndSave(asset, 'staging', 'sourcing')) continue
        closeOpenStagingTasks(asset.getUniqueValue(), 'Not moved into staging at sourcing')
    }
    // A unit in transfer gets its Staging task now and goes into staging when its line is received at the staging
    // centre (entry/assets `onTransferReleased`); without the task it is reserved for the line there.
    for (const asset of inTransfer) openStagingTask(asset, lineId)
    // Unmoved stock is not bought (see shortfallOutcome).
    const toPurchase = shortfall - reserved
    // Only a break-fix line for the same Model can be served by the OEM's advance replacement; a
    // refresh line also names the Asset it replaces, but that Asset is healthy.
    const replaced = breakFix ? findById('alm_hardware', str(line, 'replaces_asset')) : null
    const sameModel = !!replaced && str(replaced, 'model') === modelId
    const coveredToday = !!replaced && sameModel && str(replaced, 'x_daas_ham_coverage_end') >= todayIso()
    const route = (missing: number) => shortfallRoute({ missing, purpose: sameModel ? 'replace' : 'new', coveredToday })
    const planSummary = plan.summary
    const sourced: Sourced = { lineId, modelId, route, replaced, toPurchase, putBack, planSummary, unmoved, transfers }
    // Set inside the line's lock.
    let settled = 'line busy' as Exclude<LineSourcing, 'done'> | 'saved' | 'unsaved' | 'closed'
    withOrderLineLock(lineId, (lineLock) => {
        settled = settleHolding(orderLock, lineLock, order, sourced)
    })
    if (settled === 'saved') recomputeLine(lineId)
    if (settled === 'closed') leftClosed(line, transfers)
    if (settled === 'saved' || settled === 'unsaved' || settled === 'closed') return 'done'
    return leftUnsaved(line, settled, transfers)
}

/**
 * Units the line still needs, read afresh: not allocated, on order (bought, not received) or under an open OEM RMA.
 * Null for a line gone or no longer open, so nothing is reserved for it.
 */
function lineShortfall(lineId: string): number | null {
    const line = openLine(lineId)
    return line ? shortfallOf(line, countAllocated(lineId)) : null
}

/** Units the open `line` still needs beside its `allocated` ones (see `lineShortfall`). */
function shortfallOf(line: GlideRecord, allocated: number): number {
    return num(line, 'quantity') - allocated - num(line, 'quantity_to_purchase') - openRmaCount(line.getUniqueValue())
}

/**
 * Units to buy when the line is saved: what the pass planned (`toPurchase`), less any need met since it read the line,
 * as when a receipt is allocated with nothing left on order to take it off. `shortfall` is read afresh at the save and
 * counts the stock the pass `putBack` (not bought). A need grown meanwhile is left to a later pass, which picks stock
 * before it buys.
 */
function stillToBuy(toPurchase: number, shortfall: number, putBack: number): number {
    return Math.max(0, Math.min(toPurchase, shortfall - putBack))
}

/**
 * The line read afresh while it and its Order are still open (domain/sourcing `lineStillOpen`), else null. Cancel
 * order takes turns with sourcing under the Order's lock, but a rejected Order's lines are cancelled without that lock,
 * a cancel may overlap a pass that outlasted it (ADR 0013), and a line whose cancel was refused stays open on its
 * cancelled Order; so sourcing checks the line here before it reserves, buys or saves. The Order is saved as cancelled
 * or rejected before its lines, so it is checked too.
 */
function openLine(lineId: string): GlideRecord | null {
    const line = findById('x_daas_ham_order_line', lineId)
    const open = line && lineStillOpen({ lineStage: str(line, 'line_stage'), orderStage: str(line, 'order.stage') })
    return open ? line : null
}

/**
 * Route what the line still misses and save it, holding its `lineLock` and the Order's. The stock pick ran outside the
 * line's lock, so receipts may have changed its counts since: what is bought is worked out again from a fresh read
 * (`stillToBuy`) and added to the on-order count and purchase orders as they now stand. 'closed' when the line is gone
 * or no longer open (`openLine`), 'unsaved' when its save is refused (logged).
 */
function settleHolding(
    orderLock: HeldLock,
    lineLock: HeldLock,
    order: GlideRecord,
    sourced: Sourced,
): 'saved' | 'unsaved' | 'closed' | 'lock lost' {
    // Buying is what two overlapping passes must not both do.
    if (!orderLock.held()) return 'lock lost'
    const line = openLine(sourced.lineId)
    if (!line) return 'closed'
    const number = str(line, 'number')
    const allocated = countAllocated(sourced.lineId)
    const missing = stillToBuy(sourced.toPurchase, shortfallOf(line, allocated), sourced.putBack)
    const route = sourced.route(missing)
    const advance = route === 'oem_advance_replacement' && sourced.replaced
    const rmaNote = advance ? putUnderRma(order, line, advance) : ''
    const { toPurchase, unmoved, transfers } = sourced
    // The plan's summary counts what the pass would buy by its own read.
    const met = toPurchase - missing
    const planSummary =
        met > 0 ? `${sourced.planSummary} (${met} not bought: met since the line was counted)` : sourced.planSummary
    const purchase = () =>
        requestPurchase({
            modelId: sourced.modelId,
            quantity: missing,
            description: `${str(order, 'number')} ${number}: ${missing} x ${str(line, 'model.display_name')}`,
        })
    const outcome = shortfallOutcome(route, { planSummary, missing, unmoved }, purchase)
    if (transfers.length > 0) {
        line.setValue('transfer_orders', [str(line, 'transfer_orders'), ...transfers].filter(Boolean).join(','))
    }
    if (outcome.purchaseOrder) {
        // Every purchase order stays listed, so units of an earlier one are still allocated to the line on receipt.
        const listed = [str(line, 'purchase_orders'), outcome.purchaseOrder].filter(Boolean)
        line.setValue('purchase_order', outcome.purchaseOrder)
        line.setValue('purchase_orders', listed.join(','))
    }
    // Counted again: a receipt may have allocated a unit to the line since this pass read it.
    line.setValue('quantity_allocated', allocated)
    line.setValue('quantity_to_purchase', num(line, 'quantity_to_purchase') + outcome.purchased)
    line.setValue('sourcing_summary', `${outcome.summary}${rmaNote}`)
    line.setValue('line_stage', outcome.stage)
    if (!line.update()) {
        // Unlisted, a purchase order's units are not allocated on receipt, and the next run buys the shortfall again.
        const unlisted = [outcome.purchaseOrder ?? '', ...transfers].filter(Boolean)
        const listThem = unlisted.length > 0 ? `; it does not list ${unlisted.join(', ')}, add them by hand` : ''
        saveRefused(line, `${number} not saved after sourcing${listThem}`)
        return 'unsaved'
    }
    // A holder that outlasted the line's lock (ADR 0013) may have saved beside a receipt that took it over.
    if (!lineLock.held()) gs.warn(`[x_daas_ham] ${number} saved after its lock was lost: check its On order count`)
    return 'saved'
}

/**
 * Put the line's shortfall under an OEM advance replacement for the Asset it `replaced`: the RMA already open for that
 * unit when there is one to reuse (domain/sourcing `advanceReplacementRma`), else a new one. What the line's sourcing
 * summary adds. Unrecorded, the line would wait for a replacement nobody asked the OEM for: logged and in its summary.
 */
function putUnderRma(order: GlideRecord, line: GlideRecord, replaced: GlideRecord): string {
    const lineId = line.getUniqueValue()
    const serial = str(replaced, 'serial_number')
    const reuse = advanceReplacementRma(lineId, openRmasFor(replaced.getUniqueValue()))
    if (reuse) {
        const which = `RMA ${reuse.rma.rmaNumber || '(no number yet)'} already open for ${serial}`
        if (!reuseOemRma(reuse, lineId)) return ` (${which} not put under the line: do it by hand)`
        return reuse.askAgain ? ` (${which}: its replacement was received, ask the vendor for another)` : ` (${which})`
    }
    if (openOemRma({ defectiveAsset: replaced, orderLineId: lineId, caseId: str(order, 'case') })) return ''
    gs.warn(`[x_daas_ham] ${str(line, 'number')}: no OEM RMA saved for ${serial}`)
    return ' (none saved: open it by hand)'
}

/**
 * Log a line gone or closed while this pass picked stock for it (see `openLine`): nothing is bought or saved for it,
 * and what the pass reserved and requested meanwhile is named, to undo by hand.
 */
function leftClosed(line: GlideRecord, transfers: readonly string[]): void {
    const units = countAllocated(line.getUniqueValue())
    const release = units > 0 ? `; release the ${units} unit(s) still on it` : ''
    const cancel = transfers.length > 0 ? `; cancel ${transfers.join(', ')}` : ''
    gs.warn(`[x_daas_ham] ${str(line, 'number')} closed while it was sourced: nothing bought for it${release}${cancel}`)
}

/** Log a line left to the pass queued again, naming the transfer orders it does not list. */
function leftUnsaved(line: GlideRecord, why: keyof typeof AGAIN_BECAUSE, transfers: readonly string[]): LineSourcing {
    const listThem = transfers.length > 0 ? `; it does not list ${transfers.join(', ')}, add them by hand` : ''
    gs.warn(`[x_daas_ham] ${str(line, 'number')} left to the next sourcing pass (${AGAIN_BECAUSE[why]})${listThem}`)
    return why
}

function countAllocated(lineId: string): number {
    return count('alm_hardware', `x_daas_ham_order_line=${lineId}`)
}

/**
 * Put back stock reserved for a line but never moved to staging: Spare-pool stock to the pool, the rest to free stock.
 * False when the platform refuses (logged with `why`): the Asset stays on the line.
 */
function unreserve(asset: GlideRecord, source: Source, why = 'no transfer order'): boolean {
    asset.setValue('x_daas_ham_order_line', '')
    if (source === 'spare_pool') return moveAndSave(asset, 'spare_pool', why)
    asset.setValue('company', stringProperty(PROPERTY.providerCompany))
    asset.setValue('x_daas_ham_agreement', '')
    return moveAndSave(asset, 'available', why)
}

/**
 * After-update rule's work for a unit whose transfer to the staging centre fell through (entry/assets
 * `onAllocatedAssetStageChange`): Inventory let it go short of the staging centre, its transfer order line cancelled
 * or deleted, and it was reserved for its line again where it was, which nothing moves it on from (domain/lifecycle
 * `transferFellThrough`). So it is put back as stock is for want of a transfer order, as free stock: the Source it was
 * picked from is no longer known (the spare-pool top-up replaces a spare). Its Staging task is skipped, its line
 * derived again (back to awaiting stock) and its Order sourced again, queued, which picks stock again and may raise a
 * new transfer order for the same unit. Logged. A unit the platform refuses to put back stays reserved for its line
 * (logged), which is then not sourced again.
 */
export function putBackUntransferred(current: GlideRecord, lineId: string): void {
    const where = current.getDisplayValue('stockroom')
    const what = `${str(current, 'serial_number')} left its transfer to the staging centre in ${where}`
    const orderId = str(current, 'x_daas_ham_order_line.order')
    // A fresh record, read past the user's rules: saving `current` again from its own after rule would run its rules
    // twice, and an inventory tech of the staging centre who cancelled the line does not see a unit stored elsewhere.
    const asset = new GlideRecord('alm_hardware')
    if (!beyondVisibility(asset, () => asset.get(current.getUniqueValue()))) return
    if (!unreserve(asset, 'central_stock', `${what}, so it is put back`)) return
    closeOpenStagingTasks(asset.getUniqueValue(), 'Transfer to the staging centre fell through')
    recomputeLine(lineId)
    gs.warn(`[x_daas_ham] ${what}: put back as free stock, its line sourced again`)
    resourceOrder(orderId)
}

/**
 * Give an allocated Asset back to stock: hot spares stay in the Spare pool, the rest become free stock. A unit in
 * transfer stays in transfer (domain/lifecycle `checkTransition`): only its reservation goes, and it is free stock
 * once Inventory lets it go (entry/assets `onTransferReleased`). False when the platform refuses that or the closing
 * of its Staging tasks (logged).
 */
function releaseAsset(asset: GlideRecord): boolean {
    const closed = closeOpenStagingTasks(asset.getUniqueValue(), 'Order cancelled')
    const serial = str(asset, 'serial_number')
    const stage = readStage(asset)
    asset.setValue('x_daas_ham_order_line', '')
    // Still linked to the line, the spare is never picked again.
    if (stage === 'spare_pool') return saveReleased(asset, `${serial} still linked to its line, unlink it`) && closed
    asset.setValue('company', stringProperty(PROPERTY.providerCompany))
    asset.setValue('x_daas_ham_agreement', '')
    // Left on the line, it would go into staging once received.
    if (stage === 'in_transfer') {
        return saveReleased(asset, `${serial} still on its line, release it once received`) && closed
    }
    return moveAndSave(asset, 'available', 'order cancelled') && closed
}

/** Save an Asset Cancel order releases at its stage; false when the platform refuses (logged with what is `left`). */
function saveReleased(asset: GlideRecord, left: string): boolean {
    if (asset.update()) return true
    saveRefused(asset, `order cancelled: ${left}`)
    return false
}

/**
 * Skip the Asset's open Staging tasks, noting `why`; false when the platform refuses one (logged). Read past the
 * user's rules (ADR 0005): an inventory tech sees only the tasks of Assets in their stockrooms.
 */
function closeOpenStagingTasks(assetId: string, why: string): boolean {
    const task = new GlideRecord('x_daas_ham_staging_task')
    task.addQuery('asset', assetId)
    task.addQuery('active', true)
    beyondVisibility(task, () => task.query())
    let closed = true
    while (task.next()) {
        task.setValue('state', 7)
        task.setValue('work_notes', `${why}; staging skipped.`)
        if (task.update()) continue
        // Left open, it asks a technician to stage a unit that is back in stock.
        saveRefused(task, `${why.toLowerCase()}: ${str(task, 'number')} left open, close it`)
        closed = false
    }
    return closed
}

/** The Order's lines that have not shipped, queried. */
function openLines(orderId: string): GlideRecord {
    const line = new GlideRecord('x_daas_ham_order_line')
    line.addQuery('order', orderId)
    line.addQuery('line_stage', 'IN', OPEN_LINE_STAGES.join(','))
    line.query()
    return line
}

function openLineIds(orderId: string): string[] {
    const line = openLines(orderId)
    const ids: string[] = []
    while (line.next()) ids.push(line.getUniqueValue())
    return ids
}

/** The purchase orders of the Order's lines that have not shipped, to cancel in Procurement. */
function openPurchaseOrders(orderId: string): string[] {
    const line = openLines(orderId)
    const purchases: string[] = []
    while (line.next()) {
        if (str(line, 'purchase_orders')) purchases.push(line.getDisplayValue('purchase_orders'))
    }
    return purchases
}

/**
 * Cancel every line that has not shipped, releasing its stock; false when the platform refused any of it (logged). The
 * `lockedIds` are the lines read as open before their locks were taken: each is cancelled and its units released
 * whatever stage it is read in now, as a stage derived beside the cancel may already show it cancelled
 * (platform/fulfilment `deriveLine`). A line added to the Order since is new, which no receipt or sourcing reaches, so
 * it is cancelled without its lock.
 */
function cancelOpenLines(orderId: string, lockedIds: readonly string[]): boolean {
    let done = true
    for (const lineId of lockedIds) {
        const line = findById('x_daas_ham_order_line', lineId)
        if (line) done = cancelLine(line) && done
    }
    const added = openLines(orderId)
    while (added.next()) {
        if (!lockedIds.includes(added.getUniqueValue())) done = cancelLine(added) && done
    }
    return done
}

/** Release the line's stock and cancel it; false when the platform refused any of it (logged). */
function cancelLine(line: GlideRecord): boolean {
    let done = true
    const asset = new GlideRecord('alm_hardware')
    asset.addQuery('x_daas_ham_order_line', line.getUniqueValue())
    asset.query()
    while (asset.next()) done = releaseAsset(asset) && done
    if (str(line, 'line_stage') === 'cancelled') return done
    line.setValue('line_stage', 'cancelled')
    if (line.update()) return done
    // Left open, it is still given the units received on its purchase orders, unless its Order's stage is read too.
    saveRefused(line, `order cancelled: ${str(line, 'number')} left open, cancel it`)
    return false
}

/**
 * UI action "Cancel order": only before anything has shipped (a Return order brings it back then); releases stock and
 * staging work. The Order is saved first, with the purchase orders to cancel: one the platform refuses keeps its
 * lines, stock and approvals.
 *
 * A sourcing pass running meanwhile would reserve stock for, or buy for, lines just cancelled, and its purchase orders
 * would not be listed to cancel. So the cancel holds the Order's sourcing lock (`sourceOrder`) and the two take turns;
 * a cancel that finds it held changes nothing and tells the user to try again. A Ship running between the cancel's
 * shipped check and its release of the lines would send units of lines being cancelled, so the cancel holds the
 * Order's Ship lock too (`ship_order_<sys_id>`, entry/delivery `shipOrder`), taken under the sourcing lock as in ADR
 * 0013's order (Ship never takes the sourcing lock); one that finds it held changes nothing and says a Ship is running.
 * A receipt allocating its unit to a line between the cancel's read of the line's units and the line's cancel would
 * leave the unit on a cancelled line, so under the Ship lock the cancel holds each open line's lock too
 * (`withOrderLineLocks`), which a receipt takes to allocate and stage its unit (entry/warehouse `receiveAsset`); one
 * that finds a line's lock held changes nothing and tells the user to try again. Taking a lock throws only when an
 * insert is refused with no lock row (platform/locks): that error escapes.
 */
export function cancelOrder(order: GlideRecord): void {
    const orderId = order.getUniqueValue()
    // Set inside the sourcing lock.
    let busy = '' as string
    const taken = withLock(sourcingLockName(orderId), (sourcing) => {
        const shipTaken = withLock(`ship_order_${orderId}`, (ship) => {
            const lineIds = openLineIds(orderId)
            const held = withOrderLineLocks(lineIds, (lines) => cancelHolding({ sourcing, ship, lines }, order, lineIds))
            if (!held) busy = 'Order not cancelled: a unit is being received for one of its lines. Try again shortly'
        })
        if (!shipTaken) busy = 'Order not cancelled: a Ship of the Order is running. Try again once it is done'
    })
    if (!taken) return void gs.addErrorMessage('Order not cancelled: sourcing is running on it. Try again in a minute')
    if (busy) gs.addErrorMessage(busy)
}

/**
 * The cancel, holding the Order's sourcing and Ship `locks` and those of its open lines, `lineIds`. It is refused once
 * anything of the Order has shipped (domain/fulfilment `anythingShipped`), a unit of a line not delivered whole
 * included, whoever presses it.
 */
function cancelHolding(locks: { sourcing: HeldLock; ship: HeldLock; lines: HeldLock[] }, order: GlideRecord, lineIds: readonly string[]): void {
    if (anythingShipped(orderShipment(order.getUniqueValue()))) {
        return void gs.addErrorMessage('Order not cancelled: equipment has already shipped. Use a Return order instead')
    }
    const purchases = openPurchaseOrders(order.getUniqueValue())
    order.setValue('stage', 'cancelled')
    order.setValue('state', 7)
    if (purchases.length > 0) order.setValue('work_notes', `Cancel these purchase orders in Procurement: ${purchases.join(', ')}`)
    if (!order.update()) {
        const reason = saveRefused(order, `${str(order, 'number')} not cancelled`)
        return void gs.addErrorMessage(`Order not cancelled: ${reason}`)
    }
    if (!cancelOpenLines(order.getUniqueValue(), lineIds)) {
        gs.addErrorMessage('Order cancelled; some lines, stock or staging tasks were left as they were (see the log)')
    }
    // A cancel that outlasted a lock (ADR 0013) may have overlapped the pass or Ship that took it over. A pass skips
    // the lines it reads after the Order was saved cancelled (`openLine`), not those it reached first; a Ship may have
    // sent units before the cancel released them.
    const number = str(order, 'number')
    if (!locks.sourcing.held()) {
        const check = 'check its lines for stock reserved or bought meanwhile'
        gs.warn(`[x_daas_ham] ${number} cancelled after its sourcing lock was lost: ${check}`)
    }
    if (!locks.ship.held()) {
        gs.warn(`[x_daas_ham] ${number} cancelled after its Ship lock was lost: check for units shipped meanwhile`)
    }
    if (!locks.lines.every((lock) => lock.held())) warnLineLockLost(number)
    // After the save, so the approval rule each cancellation runs finds the Order no longer awaiting approval: it takes
    // no lock then, nor rejects the Order, which takes these lines' locks.
    cancelPendingApprovals(order.getUniqueValue())
}

/**
 * Source the Order again for a line that lost an allocated Asset (failed staging, a unit that left in transit) or a
 * unit received for it.
 */
export function resourceOrder(orderId: string): void {
    const order = findById('x_daas_ham_order', orderId)
    if (order) fire(EVENT.sourceOrder, order)
}
