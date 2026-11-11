import { GlideRecord } from '@servicenow/glide'
import { approversToAsk } from '../domain/approvals.ts'
import type { NamedRecord } from '../domain/customer-parties.ts'
import {
    approversFor,
    assessOrder,
    ownershipFindings,
    raiserRefusal,
    readsUsage,
    siteTemplateOffered,
    type Orderer,
    type OrderParties,
    type RequestedLine,
} from '../domain/entitlement.ts'
import { anythingShipped, endedUnfulfilled, OPEN_LINE_STAGES, ORDER_TASK_STATE } from '../domain/fulfilment.ts'
import { LONG_HOLD_LOCK_TRIES, REQUEUE, type HeldLock } from '../domain/job-lock.ts'
import { LOCK } from '../domain/lock-names.ts'
import { cancelledUnit } from '../domain/sourcing.ts'
import { type EntitlementVerdict, type InstallMode, LINE_STAGE, ORDER_STAGE, type OrderType } from '../domain/vocabulary.ts'
import { entitlementContext } from './agreements.ts'
import {
    cancelPendingApprovals,
    customerAdminIds,
    providerApproverIds,
    putToApproval,
    rollUpApprovals,
    type ApprovalFlow,
    type ApprovalRollup,
} from './approvals.ts'
import { moveAndSave, readStage } from './assets.ts'
import { requeueCounted } from './events.ts'
import { EVENT } from '../domain/events.ts'
import { orderShipment, queueSourcing } from './fulfilment.ts'
import { withLock, withLockTries, type LockRun } from './locks.ts'
import { addOrderLines, cancelLine, type NewLine, type RefusedLine } from './order-lines.ts'
import { bool, findById, num, refusal, str, warnRefused } from './records.ts'
import { creatorOf } from './session.ts'
import { withOrderLineLock } from './sourcing.ts'
import { skipOpenStagingTasks } from './staging-tasks.ts'
import { releaseToProviderStock, takeOffOrderLine } from './stock.ts'
import { SITE_FIELD } from '../domain/fleet.ts'
import { log } from './log.ts'

/**
 * Orders up to sourcing (ADR 0004): raise an Order with its lines, submit it (entitlement, then approval or sourcing),
 * roll its approvals up, and cancel it. None of it tells the user anything: each gives what came of it, for the
 * trigger that asked (a form button, the record producer, the refresh job) to report.
 */

/**
 * Remove an Order raised in vain (one its raiser may not raise, or none of whose lines was saved): why the platform
 * kept it ('' once removed), for the caller to name it for cancelling.
 */
function removeOrder(order: GlideRecord): string {
    return order.deleteRecord() ? '' : refusal(order, 'the delete was refused')
}

/** An Order to raise for a Customer's Site under its Agreement. */
export interface NewOrder {
    orderType: OrderType
    customerId: string
    siteId: string
    agreementId: string
    installMode: InstallMode
    /** The CSM case a replacement is raised for. */
    caseId?: string
    shortDescription: string
}

/**
 * What came of raising an Order: the draft with the lines the platform saved (and those it refused), or none, because
 * the platform refused the Order itself (`order`) or every one of its lines (`lines`).
 */
export type OrderCreation =
    | { created: true; order: GlideRecord; refused: RefusedLine[] }
    | { created: false; step: 'order'; reason: string }
    | {
          created: false
          step: 'lines'
          number: string
          refused: RefusedLine[]
          /** Why the platform kept the Order left without lines ('' once removed): it is then to cancel by hand. */
          kept: string
      }

/**
 * Raise a draft Order with its lines. One left with none of its lines orders nothing and could never be submitted, so
 * it is removed again and may be raised afresh. Nothing is logged or shown here.
 */
export function createOrder(header: NewOrder, lines: readonly NewLine[]): OrderCreation {
    const order = new GlideRecord('x_daas_ham_order')
    order.initialize()
    order.setValue('order_type', header.orderType)
    order.setValue('customer', header.customerId)
    order.setValue('site', header.siteId)
    order.setValue('agreement', header.agreementId)
    order.setValue('install_mode', header.installMode)
    if (header.caseId) order.setValue('case', header.caseId)
    order.setValue('short_description', header.shortDescription)
    if (!order.insert()) return { created: false, step: 'order', reason: refusal(order) }
    const refused = addOrderLines(order, lines)
    if (refused.length < lines.length) return { created: true, order, refused }
    return { created: false, step: 'lines', number: str(order, 'number'), refused, kept: removeOrder(order) }
}

/**
 * What came of submitting an Order. It went ahead (to approval or sourcing): `already` says so, for the user, when
 * another submission of it had taken it ahead. Or it did not, with why as the user is told: as information (`info`)
 * rather than an error when the Order is saved and is submitted again without them (`submitLater`).
 */
export type Submission = { submitted: true; already?: string } | { submitted: false; message: string; info?: true }

function notSubmitted(message: string): Submission {
    return { submitted: false, message }
}

/**
 * Give the Order the record producer just saved its lines (its Site template's non-optional items, then the `devices`
 * asked for) and submit it. The producer does not apply the Order create rule, so an Order its requester may not raise
 * for that Customer is removed again (one the platform keeps is logged, to cancel). One that names records that are
 * not its Customer's stays a draft to correct, without the lines of a Site template not offered to it, and so does one
 * missing a line the platform refused (logged), or whose devices could not be read (`devicesUnread` says why, '' when
 * they were; logged): it would be assessed and sourced short of what was asked for.
 */
export function submitProducedOrder(order: GlideRecord, devices: readonly NewLine[], devicesUnread: string): Submission {
    const parties = orderParties(order)
    const raiser = orderingUser(order)
    const number = str(order, 'number')
    const mayNot = raiserRefusal(parties.customerId, raiser)
    if (mayNot) {
        const kept = removeOrder(order)
        if (kept) warnRefused(order, `${number} not removed (${mayNot}), cancel it`)
        return notSubmitted(`Order not raised. ${mayNot}.`)
    }
    const fromTemplate = parties.siteTemplate && siteTemplateOffered(parties) ? siteTemplateLines(parties.siteTemplate.id) : []
    const refused = addOrderLines(order, [...fromTemplate, ...devices])
    for (const { line, reason } of refused) log.warn(`${number}: no line for model ${line.modelId}: ${reason}`)
    const missing = refused.length > 0 ? [`${refused.length} order line(s) not saved (see the system log): add them`] : []
    if (devicesUnread) {
        log.warn(`${number}: the devices asked for could not be read, so it has no line for them: ${devicesUnread}`)
        missing.push('The devices asked for could not be read (see the system log): add them as order lines')
    }
    return submitAsRaised(order, parties, raiser, missing, { via: 'producer', tries: 0 })
}

/** The Site template's non-optional items, as lines. */
function siteTemplateLines(siteTemplateId: string): NewLine[] {
    const item = new GlideRecord('x_daas_ham_site_template_item')
    item.addQuery('site_template', siteTemplateId)
    item.addQuery('optional', false)
    item.query()
    const lines: NewLine[] = []
    while (item.next()) lines.push({ modelId: str(item, 'model'), quantity: num(item, 'quantity'), fromSiteTemplate: true })
    return lines
}

/** The signed-in user as the raiser of `order`: an Order raiser when the Order create rule lets them create it. */
function orderingUser(order: GlideRecord): Orderer {
    const { permitted, scope, customerId } = creatorOf(order)
    return { mayRaise: permitted, scope, customerId }
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
        site: site && { ...site, isSite: bool(order, `site.${SITE_FIELD}`) },
        siteTemplate: named('site_template', 'x_daas_ham_site_template', 'customer'),
    }
}

/**
 * How a submission came, which says who is told its outcome: the record producer (its raiser, often a Customer admin,
 * has no Submit action), a submission queued again (`submitLater`, run as the system), or any other (Submit, Raise
 * replacement, the refresh run); and how many times it was queued again.
 */
interface SubmissionSource {
    via: 'submit' | 'producer' | 'queued'
    tries: number
}

/**
 * Submit a draft Order (the form's Submit, a break-fix or refresh Order just raised): it goes ahead, to approval or
 * sourcing, also when another submission of it took it ahead; otherwise it stays a draft.
 */
export function submitOrder(order: GlideRecord): Submission {
    return submitAsRaised(order, orderParties(order), orderingUser(order), [], { via: 'submit', tries: 0 })
}

/**
 * Submit the Order unless it cannot go ahead as raised (domain/entitlement `ownershipFindings`, or the `unsaved`
 * lines); then it stays a draft and the reasons are noted on it.
 */
function submitAsRaised(order: GlideRecord, parties: OrderParties, raiser: Orderer, unsaved: string[], source: SubmissionSource): Submission {
    const findings = [...ownershipFindings(parties, raiser), ...unsaved]
    if (findings.length === 0) return submitAccepted(order, source)
    order.setValue('work_notes', `Not submitted:\n${findings.join('\n')}`)
    // A refresh Order the daily job raised has only this note to say why it is a draft.
    if (!order.update()) warnRefused(order, `${str(order, 'number')} not submitted (${findings.join('; ')}), and its note not saved`)
    return notSubmitted(`Order not submitted. ${findings.join('. ')}.`)
}

/**
 * Assess and submit the Order. Two submissions of one Agreement reading its usage at once would each miss the other
 * and could both go ahead within a Contracted quantity only one fits, so an Order whose lines read usage
 * (domain/entitlement `readsUsage`) is assessed and saved out of draft holding the Agreement's job lock
 * (domain/lock-names `agreementUsage`, ADR 0013); one replacing Assets only reads none and takes no lock. A holder
 * keeps the lock only to read the Order, its lines and the Agreement's usage, ask approvers and save the Order, so it
 * is tried as often as an Order line's. A submission that finds the lock held through every try is queued again
 * (`submitLater`). Taking the lock throws only when an insert is refused with no lock row (platform/locks): that error
 * escapes.
 */
function submitAccepted(order: GlideRecord, source: SubmissionSource): Submission {
    const lines = requestedLines(order.getUniqueValue())
    if (lines.length === 0) return notSubmitted('Add at least one order line before submitting')
    if (!readsUsage(lines)) return submitUnderOrderLock(null, order)
    const usageLock = LOCK.agreementUsage(str(order, 'agreement'))
    const underUsage = withLockTries(usageLock, (lock) => submitUnderOrderLock(lock, order), LONG_HOLD_LOCK_TRIES)
    return underUsage.ran ? underUsage.value : submitLater(order, source)
}

/**
 * The submission holding the Order's sourcing lock (domain/lock-names `sourceOrder`), which Cancel order holds
 * (`cancelOrder`): a cancel saved between the submission's read of the Order as a draft and its save out of draft would
 * be overwritten, its lines cancelled under an Order sourcing or awaiting approval. One that finds the lock held
 * through every try submits nothing.
 */
function submitUnderOrderLock(usageLock: HeldLock | null, order: GlideRecord): Submission {
    const underOrder = withLockTries(LOCK.sourceOrder(order.getUniqueValue()), () => submitHolding(usageLock, order), LONG_HOLD_LOCK_TRIES)
    return underOrder.ran ? underOrder.value : notSubmitted('Order not submitted: it is being cancelled. Try again shortly')
}

/**
 * The submission, holding the Agreement's `usageLock` (null for an Order that reads no usage). The Order, its lines and
 * the Agreement's quantities and usage are read afresh here, so what is assessed is what is saved; it goes on only
 * from draft, under the Agreement and Customer whose lock and ownership check were taken. The caller's `order` is
 * saved, so its in-memory record shows the outcome.
 */
function submitHolding(usageLock: HeldLock | null, order: GlideRecord): Submission {
    const fresh = findById('x_daas_ham_order', order.getUniqueValue())
    if (!fresh) return notSubmitted('Order not submitted: it can no longer be read')
    if (str(fresh, 'stage') !== ORDER_STAGE.draft) return alreadySubmitted(fresh)
    if (str(fresh, 'agreement') !== str(order, 'agreement') || str(fresh, 'customer') !== str(order, 'customer')) {
        return notSubmitted('Order not submitted: its Customer or Agreement changed while it was submitted. Submit it again')
    }
    const lines = requestedLines(order.getUniqueValue())
    if (lines.length === 0) return notSubmitted('Order not submitted: add at least one order line first')
    if (!usageLock && readsUsage(lines)) return notSubmitted('Order not submitted: a line was added while it was submitted. Submit it again')
    const assessment = assessOrder(
        { siteTemplateId: str(order, 'site_template') || undefined, lines },
        entitlementContext(str(order, 'customer'), str(order, 'agreement'), order.getUniqueValue()),
    )
    order.setValue('entitlement_verdict', assessment.verdict)
    order.setValue('entitlement_findings', assessment.findings.join('\n'))

    if (assessment.approvers.length === 0) {
        const refused = startSourcing(order)
        if (refused) return notSubmitted(`Order not submitted: ${refused}`)
        warnIfUsageLockLost(usageLock, order)
        return { submitted: true }
    }
    const customerAdmins = customerAdminIds(str(order, 'customer'))
    // The account manager, or else the asset managers, on the Provider's side.
    const provider = providerApproverIds(str(order, 'agreement.account_manager'))
    const asked = putToApproval(order, {
        awaitingStage: ORDER_APPROVAL.awaitingStage,
        approverIds: approversToAsk(assessment.approvers, customerAdmins, provider),
        required: assessment.approvers,
        customerAdmins,
        noApprover: 'no account manager or asset manager to approve it',
    })
    if (asked.awaiting) {
        warnIfUsageLockLost(usageLock, order)
        return { submitted: true }
    }
    if (asked.step === 'save') return notSubmitted(`Order not submitted: ${asked.reason}`)
    order.setValue('work_notes', `Not submitted: ${asked.reason}`)
    if (!order.update()) warnRefused(order, `${str(order, 'number')} not submitted (${asked.reason}), and its note not saved`)
    return notSubmitted(`Order not submitted: ${asked.reason}.`)
}

/** An Order a submission finds out of draft: gone ahead, through another submission of it (submitted), or ended (not). */
function alreadySubmitted(fresh: GlideRecord): Submission {
    const stage = fresh.getDisplayValue('stage')
    if (endedUnfulfilled(str(fresh, 'stage'))) return notSubmitted(`Order not submitted: it is ${stage}`)
    return { submitted: true, already: `Order ${str(fresh, 'number')} was already submitted (${stage})` }
}

/** A holder that outlasted the lock (ADR 0013) may have assessed beside a submission that took it over. */
function warnIfUsageLockLost(usageLock: HeldLock | null, order: GlideRecord): void {
    usageLock?.lostAfter(`${str(order, 'number')} submitted`, { check: "check the Agreement's Orders against its contracted quantities" })
}

/**
 * parm1 of the sourcing event (domain/events `EVENT.sourceOrder`) when it carries a submission queued again
 * (`submitLater`), which its script action runs instead of a sourcing pass (`submitQueuedOrder`).
 */
export const SUBMIT_AGAIN = 'submit'

/**
 * A submission that found its Agreement's usage lock held through every try. Unless another submission of this same
 * Order took it ahead (then it went ahead), the Order stays a draft for now, noted, and is submitted again a minute
 * later from the event queue, as often as a sourcing request is queued again (domain/job-lock `REQUEUE`), then left
 * for staff to submit (logged). Each is told in words that fit them: the record producer's raiser has no Submit action,
 * so is told, as information, not to raise it again.
 */
function submitLater(order: GlideRecord, source: SubmissionSource): Submission {
    const fresh = findById('x_daas_ham_order', order.getUniqueValue())
    if (!fresh) return notSubmitted('Order not submitted: it can no longer be read')
    if (str(fresh, 'stage') !== ORDER_STAGE.draft) return alreadySubmitted(fresh)
    const number = str(order, 'number')
    const lockName = LOCK.agreementUsage(str(order, 'agreement'))
    if (!requeueCounted(EVENT.sourceOrder, order, SUBMIT_AGAIN, source.tries)) {
        log.warn(`${number} left a draft: ${lockName} stayed held through ${source.tries} submissions queued again; submit it`)
        const kept = 'other Orders of its Agreement kept being submitted at the same time. Submit it'
        noteDraft(order, `Not submitted: ${kept}`)
        return notSubmitted(`Order not submitted: ${kept}`)
    }
    const busy = 'another Order of its Agreement was being submitted at the same time. It is submitted again automatically'
    if (source.tries === 0) noteDraft(order, `Not submitted yet: ${busy}`)
    log.info(`${number} submitted again in ${REQUEUE.delaySeconds} s: another submission holds ${lockName}`)
    if (source.via !== 'producer') return notSubmitted(`Order not submitted yet: ${busy} in a minute`)
    const saved = `Order ${number} is saved and is submitted within a few minutes: another order of the same agreement was being submitted at that moment`
    return { submitted: false, message: `${saved}. There is no need to raise it again`, info: true }
}

/** Note on a draft why it is one; a refused note is logged. */
function noteDraft(order: GlideRecord, note: string): void {
    order.setValue('work_notes', note)
    if (!order.update()) warnRefused(order, `${str(order, 'number')} left a draft, its note not saved (${note})`)
}

/**
 * A submission queued again (`submitLater`) `tries` times, run as the system from the event queue: the Order read
 * afresh is submitted as Submit does, its records' ownership checked again, unless it is no longer a draft (submitted
 * or cancelled meanwhile).
 */
export function submitQueuedOrder(orderId: string, tries: number): void {
    const order = findById('x_daas_ham_order', orderId)
    if (!order || str(order, 'stage') !== ORDER_STAGE.draft) return
    submitAsRaised(order, orderParties(order), orderingUser(order), [], { via: 'queued', tries })
}

function requestedLines(orderId: string): RequestedLine[] {
    const line = new GlideRecord('x_daas_ham_order_line')
    line.addQuery('order', orderId)
    line.addQuery('line_stage', '!=', LINE_STAGE.cancelled)
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

/** Approve the Order and source it; why the platform refused the save ('' once saved), when nothing is sourced. */
function startSourcing(order: GlideRecord): string {
    order.setValue('approval', 'approved')
    order.setValue('stage', ORDER_STAGE.sourcing)
    order.setValue('state', ORDER_TASK_STATE.inProgress)
    if (!order.update()) return warnRefused(order, `${str(order, 'number')} not saved as approved, not sourced`)
    queueSourcing(order)
    return ''
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
    const underLines = withOrderLineLocks(lineIds, (locks) => {
        order.setValue('approval', 'rejected')
        order.setValue('stage', ORDER_STAGE.rejected)
        order.setValue('state', ORDER_TASK_STATE.rejected)
        if (!order.update()) return warnRefused(order, `${number} not saved as rejected`)
        cancelOpenLines(orderId, lineIds)
        warnIfLineLockLost(locks, number)
        return ''
    })
    if (underLines.ran) return underLines.value
    log.warn(`${number} not rejected: a line's lock stayed held through every try; re-check its approvals`)
    return 'one of its lines is being received or cancelled: re-check its approvals shortly'
}

/**
 * Run `work` holding the lock of every line in `lineIds` (platform/sourcing `withOrderLineLock` each), taken one under
 * another in sys_id order (ADR 0013), and give what it returned, or `ran: false`, with nothing run, when one stayed
 * held through its tries.
 */
function withOrderLineLocks<T>(lineIds: readonly string[], work: (locks: HeldLock[]) => T): LockRun<T> {
    const ids = [...lineIds].sort()
    const holdFrom = (next: number, held: HeldLock[]): LockRun<T> => {
        if (next === ids.length) return { ran: true, value: work(held) }
        const under = withOrderLineLock(ids[next], (lock) => holdFrom(next + 1, [...held, lock]))
        return under.ran ? under.value : { ran: false }
    }
    return holdFrom(0, [])
}

/** A cancel or rejection that outlasted a line's lock (ADR 0013) may have overlapped a receipt that took it over: logged once. */
function warnIfLineLockLost(locks: readonly HeldLock[], number: string): void {
    locks.some((lock) => lock.lostAfter(`${number}: lines cancelled`, { check: 'check them for units received meanwhile' }))
}

/** How an Order's approvals are decided (platform/approvals): by its entitlement verdict, approved and sourced or rejected. */
const ORDER_APPROVAL: ApprovalFlow = {
    awaitingStage: ORDER_STAGE.awaiting_approval,
    required: (order) => approversFor(str(order, 'entitlement_verdict') as EntitlementVerdict),
    decide: (order, outcome) => (outcome === 'approved' ? startSourcing(order) : rejectOrder(order)),
}

/**
 * Roll the approvals of the Order up and save the outcome (platform/approvals `rollUpApprovals`): what a decision on
 * one of its requests does, and Re-check approvals. Null when the Order is gone or not awaiting approval. The Order is
 * read afresh: a decision may have moved it since a form was opened.
 */
export function rollUpOrderApprovals(orderId: string): ApprovalRollup | null {
    const order = findById('x_daas_ham_order', orderId)
    return order ? rollUpApprovals(order, ORDER_APPROVAL) : null
}

/**
 * Give an allocated Asset back to stock (domain/sourcing `cancelledUnit`): hot spares stay in the Spare pool, the rest
 * become free stock. A unit in transfer stays in transfer (domain/lifecycle `checkTransition`): only its reservation
 * goes, and it is free stock once Inventory lets it go (entry/assets `onTransferReleased`). False when the platform
 * refuses that or the closing of its Staging tasks (logged).
 */
function releaseAsset(asset: GlideRecord): boolean {
    const closed = skipOpenStagingTasks(asset.getUniqueValue(), 'Order cancelled')
    const serial = str(asset, 'serial_number')
    const release = cancelledUnit(readStage(asset))
    if (release === 'stays_spare') {
        takeOffOrderLine(asset)
        // Still linked to the line, the spare is never picked again.
        return saveReleased(asset, `${serial} still linked to its line, unlink it`) && closed
    }
    releaseToProviderStock(asset)
    // Left on the line, it would go into staging once received.
    if (release === 'stays_in_transfer') {
        return saveReleased(asset, `${serial} still on its line, release it once received`) && closed
    }
    return moveAndSave(asset, 'available', 'order cancelled') && closed
}

/** Save an Asset Cancel order releases at its stage; false when the platform refuses (logged with what is `left`). */
function saveReleased(asset: GlideRecord, left: string): boolean {
    if (asset.update()) return true
    warnRefused(asset, `order cancelled: ${left}`)
    return false
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
        if (line) done = releaseAndCancel(line) && done
    }
    const added = openLines(orderId)
    while (added.next()) {
        if (!lockedIds.includes(added.getUniqueValue())) done = releaseAndCancel(added) && done
    }
    return done
}

/** Release the line's stock and cancel it; false when the platform refused any of it (logged). */
function releaseAndCancel(line: GlideRecord): boolean {
    let done = true
    const asset = new GlideRecord('alm_hardware')
    asset.addQuery('x_daas_ham_order_line', line.getUniqueValue())
    asset.query()
    while (asset.next()) done = releaseAsset(asset) && done
    if (str(line, 'line_stage') === LINE_STAGE.cancelled) return done
    if (cancelLine(line)) return done
    // Left open, it is still given the units received on its purchase orders, unless its Order's stage is read too.
    warnRefused(line, `order cancelled: ${str(line, 'number')} left open, cancel it`)
    return false
}

/**
 * What came of Cancel order: the Order is cancelled, `complete` unless a line, unit or Staging task was left as it was
 * (logged), or it is not, and why.
 */
export type Cancellation = { cancelled: true; complete: boolean } | { cancelled: false; reason: string }

function notCancelled(reason: string): Cancellation {
    return { cancelled: false, reason }
}

/**
 * Cancel an Order: only before anything has shipped (a Return order brings it back then); releases stock and staging
 * work. The Order is saved first, with the purchase orders to cancel: one the platform refuses keeps its lines, stock
 * and approvals.
 *
 * A sourcing pass running meanwhile would reserve stock for, or buy for, lines just cancelled, and its purchase orders
 * would not be listed to cancel. So the cancel holds the Order's sourcing lock (platform/sourcing `runSourcingPass`)
 * and the two take turns, as it does with a submission (`submitUnderOrderLock`); a cancel that finds it held changes
 * nothing and says so. A Ship running between the cancel's shipped check and its release of the lines would send units
 * of lines being cancelled, so the cancel holds the Order's Ship lock too (platform/delivery `shipOrder`), taken under
 * the sourcing lock as in ADR 0013's order (Ship never takes the sourcing lock); one that finds it held changes nothing
 * and says a Ship is running. A receipt
 * allocating its unit to a line between the cancel's read of the line's units and the line's cancel would leave the
 * unit on a cancelled line, so under the Ship lock the cancel holds each open line's lock too (`withOrderLineLocks`),
 * which a receipt takes to allocate and stage its unit (platform/receiving `receive`); one that finds a line's lock
 * held changes nothing and asks to try again. Taking a lock throws only when an insert is refused with no lock row
 * (platform/locks): that error escapes.
 */
export function cancelOrder(order: GlideRecord): Cancellation {
    const orderId = order.getUniqueValue()
    const underSourcing = withLock(LOCK.sourceOrder(orderId), (sourcing) => {
        return withLock(LOCK.shipOrder(orderId), (ship) => {
            const lineIds = openLineIds(orderId)
            return withOrderLineLocks(lineIds, (lines) => cancelHolding({ sourcing, ship, lines }, order, lineIds))
        })
    })
    if (!underSourcing.ran) return notCancelled('it is being submitted or sourced. Try again in a minute')
    const underShip = underSourcing.value
    if (!underShip.ran) return notCancelled('a Ship of the Order is running. Try again once it is done')
    const underLines = underShip.value
    return underLines.ran ? underLines.value : notCancelled('a unit is being received for one of its lines. Try again shortly')
}

/**
 * The cancel, holding the Order's sourcing and Ship `locks` and those of its open lines, `lineIds`. It is refused once
 * anything of the Order has shipped (domain/fulfilment `anythingShipped`), a unit of a line not delivered whole
 * included, whoever asks for it.
 */
function cancelHolding(
    locks: { sourcing: HeldLock; ship: HeldLock; lines: HeldLock[] },
    order: GlideRecord,
    lineIds: readonly string[],
): Cancellation {
    if (anythingShipped(orderShipment(order.getUniqueValue()))) {
        return notCancelled('equipment has already shipped. Use a Return order instead')
    }
    const purchases = openPurchaseOrders(order.getUniqueValue())
    order.setValue('stage', ORDER_STAGE.cancelled)
    order.setValue('state', ORDER_TASK_STATE.cancelled)
    if (purchases.length > 0) order.setValue('work_notes', `Cancel these purchase orders in Procurement: ${purchases.join(', ')}`)
    if (!order.update()) return notCancelled(warnRefused(order, `${str(order, 'number')} not cancelled`))
    const complete = cancelOpenLines(order.getUniqueValue(), lineIds)
    // A cancel that outlasted a lock (ADR 0013) may have overlapped the pass or Ship that took it over. A pass skips
    // the lines it reads after the Order was saved cancelled (platform/sourcing `openLine`), not those it reached
    // first; a Ship may have sent units before the cancel released them.
    const cancelled = `${str(order, 'number')} cancelled`
    locks.sourcing.lostAfter(cancelled, { check: 'check its lines for stock reserved or bought meanwhile' })
    locks.ship.lostAfter(cancelled, { check: 'check for units shipped meanwhile' })
    warnIfLineLockLost(locks.lines, str(order, 'number'))
    // After the save, so the approval rule each cancellation runs finds the Order no longer awaiting approval: it takes
    // no lock then, nor rejects the Order, which takes these lines' locks.
    cancelPendingApprovals(order.getUniqueValue())
    return { cancelled: true, complete }
}
