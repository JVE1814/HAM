import { GlideRecord, gs } from '@servicenow/glide'
import { approversToAsk } from '../domain/approvals.ts'
import type { NamedRecord } from '../domain/customer-parties.ts'
import {
    approversFor,
    assessOrder,
    ownershipFindings,
    raiserRefusal,
    siteTemplateOffered,
    type Orderer,
    type OrderParties,
    type RequestedLine,
} from '../domain/entitlement.ts'
import { anythingShipped, OPEN_LINE_STAGES, ORDER_TASK_STATE } from '../domain/fulfilment.ts'
import type { HeldLock } from '../domain/job-lock.ts'
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
import { orderShipment, queueSourcing } from './fulfilment.ts'
import { withLock } from './locks.ts'
import { addOrderLines, cancelLine, type NewLine, type RefusedLine } from './order-lines.ts'
import { bool, findById, num, refusal, str, warnRefused } from './records.ts'
import { creatorOf } from './session.ts'
import { skipOpenStagingTasks } from './staging-tasks.ts'
import { releaseToProviderStock, takeOffOrderLine } from './stock.ts'
import { SITE_FIELD } from '../domain/fleet.ts'

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

/** What came of submitting an Order: it went ahead (to approval or sourcing), or it did not, with why as the user is told. */
export type Submission = { submitted: true } | { submitted: false; message: string }

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
    for (const { line, reason } of refused) gs.warn(`[x_daas_ham] ${number}: no line for model ${line.modelId}: ${reason}`)
    const missing = refused.length > 0 ? [`${refused.length} order line(s) not saved (see the system log): add them`] : []
    if (devicesUnread) {
        gs.warn(`[x_daas_ham] ${number}: the devices asked for could not be read, so it has no line for them: ${devicesUnread}`)
        missing.push('The devices asked for could not be read (see the system log): add them as order lines')
    }
    return submitAsRaised(order, parties, raiser, missing)
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
 * Submit a draft Order (the form's Submit, a break-fix or refresh Order just raised): it goes ahead, to approval or
 * sourcing, or stays a draft.
 */
export function submitOrder(order: GlideRecord): Submission {
    return submitAsRaised(order, orderParties(order), orderingUser(order))
}

/**
 * Submit the Order unless it cannot go ahead as raised (domain/entitlement `ownershipFindings`, or the `unsaved`
 * lines); then it stays a draft and the reasons are noted on it.
 */
function submitAsRaised(order: GlideRecord, parties: OrderParties, raiser: Orderer, unsaved: string[] = []): Submission {
    const findings = [...ownershipFindings(parties, raiser), ...unsaved]
    if (findings.length === 0) return submitAccepted(order)
    order.setValue('work_notes', `Not submitted:\n${findings.join('\n')}`)
    // A refresh Order the daily job raised has only this note to say why it is a draft.
    if (!order.update()) warnRefused(order, `${str(order, 'number')} not submitted (${findings.join('; ')}), and its note not saved`)
    return notSubmitted(`Order not submitted. ${findings.join('. ')}.`)
}

function submitAccepted(order: GlideRecord): Submission {
    const lines = requestedLines(order.getUniqueValue())
    if (lines.length === 0) return notSubmitted('Add at least one order line before submitting')
    const assessment = assessOrder(
        { siteTemplateId: str(order, 'site_template') || undefined, lines },
        entitlementContext(str(order, 'customer'), str(order, 'agreement'), order.getUniqueValue()),
    )
    order.setValue('entitlement_verdict', assessment.verdict)
    order.setValue('entitlement_findings', assessment.findings.join('\n'))

    if (assessment.approvers.length === 0) {
        const refused = startSourcing(order)
        return refused ? notSubmitted(`Order not submitted: ${refused}`) : { submitted: true }
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
    if (asked.awaiting) return { submitted: true }
    if (asked.step === 'save') return notSubmitted(`Order not submitted: ${asked.reason}`)
    order.setValue('work_notes', `Not submitted: ${asked.reason}`)
    if (!order.update()) warnRefused(order, `${str(order, 'number')} not submitted (${asked.reason}), and its note not saved`)
    return notSubmitted(`Order not submitted: ${asked.reason}.`)
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
 * refuses keeps its lines. Why it was refused ('' once saved).
 */
function rejectOrder(order: GlideRecord): string {
    order.setValue('approval', 'rejected')
    order.setValue('stage', ORDER_STAGE.rejected)
    order.setValue('state', ORDER_TASK_STATE.rejected)
    if (!order.update()) return warnRefused(order, `${str(order, 'number')} not saved as rejected`)
    cancelOpenLines(order.getUniqueValue())
    return ''
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

/** The purchase orders of the Order's lines that have not shipped, to cancel in Procurement. */
function openPurchaseOrders(orderId: string): string[] {
    const line = openLines(orderId)
    const purchases: string[] = []
    while (line.next()) {
        if (str(line, 'purchase_orders')) purchases.push(line.getDisplayValue('purchase_orders'))
    }
    return purchases
}

/** Cancel every line that has not shipped, releasing its stock; false when the platform refused any of it (logged). */
function cancelOpenLines(orderId: string): boolean {
    let done = true
    const line = openLines(orderId)
    while (line.next()) {
        const asset = new GlideRecord('alm_hardware')
        asset.addQuery('x_daas_ham_order_line', line.getUniqueValue())
        asset.query()
        while (asset.next()) done = releaseAsset(asset) && done
        if (cancelLine(line)) continue
        // Left open, it is still given the units received on its purchase orders.
        warnRefused(line, `order cancelled: ${str(line, 'number')} left open, cancel it`)
        done = false
    }
    return done
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
 * and the two take turns; a cancel that finds it held changes nothing and says so. A Ship running between the cancel's
 * shipped check and its release of the lines would send units of lines being cancelled, so the cancel holds the
 * Order's Ship lock too (platform/delivery `shipOrder`), taken under the sourcing lock as in ADR 0013's order (Ship
 * never takes the sourcing lock); one that finds it held changes nothing and says a Ship is running. Taking either lock
 * throws only when an insert is refused with no lock row (platform/locks): that error escapes.
 */
export function cancelOrder(order: GlideRecord): Cancellation {
    const orderId = order.getUniqueValue()
    const underSourcing = withLock(LOCK.sourceOrder(orderId), (sourcing) => {
        return withLock(LOCK.shipOrder(orderId), (ship) => cancelHolding({ sourcing, ship }, order))
    })
    if (!underSourcing.ran) return notCancelled('sourcing is running on it. Try again in a minute')
    const underShip = underSourcing.value
    return underShip.ran ? underShip.value : notCancelled('a Ship of the Order is running. Try again once it is done')
}

/**
 * The cancel, holding the Order's sourcing and Ship `locks`. It is refused once anything of the Order has shipped
 * (domain/fulfilment `anythingShipped`), a unit of a line not delivered whole included, whoever asks for it.
 */
function cancelHolding(locks: { sourcing: HeldLock; ship: HeldLock }, order: GlideRecord): Cancellation {
    if (anythingShipped(orderShipment(order.getUniqueValue()))) {
        return notCancelled('equipment has already shipped. Use a Return order instead')
    }
    const purchases = openPurchaseOrders(order.getUniqueValue())
    order.setValue('stage', ORDER_STAGE.cancelled)
    order.setValue('state', ORDER_TASK_STATE.cancelled)
    if (purchases.length > 0) order.setValue('work_notes', `Cancel these purchase orders in Procurement: ${purchases.join(', ')}`)
    if (!order.update()) return notCancelled(warnRefused(order, `${str(order, 'number')} not cancelled`))
    const complete = cancelOpenLines(order.getUniqueValue())
    // A cancel that outlasted a lock (ADR 0013) may have overlapped the pass or Ship that took it over. A pass skips
    // the lines it reads after the Order was saved cancelled (platform/sourcing `openLine`), not those it reached
    // first; a Ship may have sent units before the cancel released them.
    const cancelled = `${str(order, 'number')} cancelled`
    locks.sourcing.lostAfter(cancelled, { check: 'check its lines for stock reserved or bought meanwhile' })
    locks.ship.lostAfter(cancelled, { check: 'check for units shipped meanwhile' })
    // After the save, so the approval rule each cancellation runs finds the Order no longer awaiting approval.
    cancelPendingApprovals(order.getUniqueValue())
    return { cancelled: true, complete }
}
