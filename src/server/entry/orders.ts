import { GlideDateTime, GlideRecord, gs } from '@servicenow/glide'
import { groupDecisions, rollupApprovals } from '../domain/approvals'
import { appendTo } from '../domain/collections'
import {
    approversFor,
    assessOrder,
    OPEN_LINE_STAGES,
    ownershipFindings,
    raiserRefusal,
    siteTemplateOffered,
    type EntitlementVerdict,
    type NamedRecord,
    type Orderer,
    type OrderParties,
    type RequestedLine,
} from '../domain/entitlement'
import type { LineStage } from '../domain/fulfilment'
import { shortfallRoute, type ShortfallRoute } from '../domain/returns'
import {
    orderLineLockName,
    planSourcing,
    shortfallOutcome,
    sourcingLockName,
    type Source,
    type SourcingRequest,
    type UnmovedStock,
} from '../domain/sourcing'
import { entitlementContext } from '../platform/agreements'
import {
    approvalsOf,
    cancelPendingApprovals,
    customerAdminIds,
    providerApproverIds,
    requestApprovals,
} from '../platform/approvals'
import { moveAndSave, readStage } from '../platform/assets'
import { EVENT, fire } from '../platform/events'
import { recomputeLine, recomputeOrder } from '../platform/fulfilment'
import { todayIso } from '../platform/clock'
import { withLock, withLockTries, type HeldLock } from '../platform/locks'
import { openOemRma, openRmaCount } from '../platform/oem-rma'
import { requestPurchase } from '../platform/procurement'
import { PROPERTY, stagingStockroom, stringProperty } from '../platform/properties'
import { bool, count, findById, num, refusal, str } from '../platform/records'
import { currentSession } from '../platform/session'
import { openStagingTask } from '../platform/staging-tasks'
import { linkHotSpare, reserveAsset, stockCandidates } from '../platform/stock'
import { requestTransfer } from '../platform/transfers'

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
    submitAsRaised(order, parties, raiser, missing)
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
 * UI action "Submit" on a draft Order, and the end of break-fix and refresh Orders. Returns whether the Order went
 * ahead (to approval or sourcing); otherwise it stays a draft.
 */
export function submitOrder(order: GlideRecord): boolean {
    return submitAsRaised(order, orderParties(order), orderingUser(order))
}

/**
 * Submit the Order unless it cannot go ahead as raised (domain/entitlement `ownershipFindings`, or the `unsaved`
 * lines); then it stays a draft, and the user is told why and the reasons are noted on it.
 */
function submitAsRaised(order: GlideRecord, parties: OrderParties, raiser: Orderer, unsaved: string[] = []): boolean {
    const findings = [...ownershipFindings(parties, raiser), ...unsaved]
    if (findings.length === 0) return submitAccepted(order)
    gs.addErrorMessage(`Order not submitted. ${findings.join('. ')}.`)
    order.setValue('work_notes', `Not submitted:\n${findings.join('\n')}`)
    order.update()
    return false
}

function submitAccepted(order: GlideRecord): boolean {
    const lines = requestedLines(order.getUniqueValue())
    if (lines.length === 0) {
        gs.addErrorMessage('Add at least one order line before submitting')
        return false
    }
    const assessment = assessOrder(
        { siteTemplateId: str(order, 'site_template') || undefined, lines },
        entitlementContext(str(order, 'customer'), str(order, 'agreement'), order.getUniqueValue()),
    )
    order.setValue('entitlement_verdict', assessment.verdict)
    order.setValue('entitlement_findings', assessment.findings.join('\n'))

    if (assessment.approvers.length === 0) {
        const refused = startSourcing(order)
        if (refused) gs.addErrorMessage(`Order not submitted: ${refused}`)
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
        order.update()
        return false
    }
    order.setValue('stage', 'awaiting_approval')
    order.setValue('approval', 'requested')
    if (order.update()) return true
    // The requests would wait on a draft, whose decisions roll up to nothing: they are taken back.
    const reason = saveRefused(order, `${str(order, 'number')} not saved as awaiting approval, its requests cancelled`)
    cancelPendingApprovals(order.getUniqueValue())
    gs.addErrorMessage(`Order not submitted: ${reason}`)
    return false
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
    if (!order || str(order, 'stage') !== 'awaiting_approval') return
    const decisions = groupDecisions(approvalsOf(order.getUniqueValue()), customerAdminIds(str(order, 'customer')))
    const outcome = rollupApprovals(approversFor(str(order, 'entitlement_verdict') as EntitlementVerdict), decisions)
    if (outcome === 'requested') return
    const refused = outcome === 'approved' ? startSourcing(order) : rejectOrder(order)
    // Each cancellation runs this rule again, which stops once the Order is saved out of awaiting approval. A refused
    // save keeps it awaiting approval with its requests, so the next decision tries again.
    if (!refused) cancelPendingApprovals(order.getUniqueValue())
}

/**
 * A rejected Order cancels its lines, so they stop counting as usage. The Order is saved first: one the platform
 * refuses keeps its lines. Why it was refused ('' once saved).
 */
function rejectOrder(order: GlideRecord): string {
    order.setValue('approval', 'rejected')
    order.setValue('stage', 'rejected')
    order.setValue('state', 4)
    if (!order.update()) return saveRefused(order, `${str(order, 'number')} not saved as rejected`)
    cancelOpenLines(order.getUniqueValue())
    return ''
}

/** How many times a request to source an Order is queued again, a minute apart, while it cannot run (`sourceOrder`). */
const SOURCING_TRIES = 15

const SOURCING_RETRY_SECONDS = 60

/**
 * Tries at taking an Order line's lock before giving up: a holder keeps it for a receipt (the Asset, the line and the
 * reservation saved) or for sourcing's read of the line or its purchase and save, so a few more than a counter's.
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
 * request transfers and purchases.
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
    // Stock outside the staging centre is only staged once its transfer order exists; without one it goes back.
    const transfers: string[] = []
    const unmoved: UnmovedStock[] = []
    let putBack = 0
    for (const [from, picked] of toTransfer) {
        const transfer = requestTransfer({ fromStockroomId: from, toStockroomId: stagingId, assets: picked.map(({ asset }) => ({ assetId: asset.getUniqueValue(), modelId })) })
        if (transfer.ok) {
            transfers.push(transfer.transferId)
            toStage.push(...picked.map(({ asset }) => asset))
            continue
        }
        unmoved.push({ units: picked.length, from: picked[0].asset.getDisplayValue('stockroom'), reason: transfer.reason })
        for (const { asset, source } of picked) {
            if (unreserve(asset, source)) putBack++
        }
    }
    // An Asset whose Staging task could not be opened stays reserved for the line rather than staging with no task to finish.
    for (const asset of toStage) {
        if (openStagingTask(asset, lineId)) moveAndSave(asset, 'staging', 'sourcing')
    }
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

/** Order stages in which nothing is sourced, even for a line a refused save left open. */
const ENDED_ORDER_STAGES: readonly string[] = ['cancelled', 'rejected']

/**
 * The line read afresh while it and its Order are still open (not shipped, cancelled or rejected), else null. Cancel
 * order takes turns with sourcing under the Order's lock, but a rejected Order's lines are cancelled without that lock,
 * a cancel may overlap a pass that outlasted it (ADR 0013), and a line whose cancel was refused stays open on its
 * cancelled Order; so sourcing checks the line here before it reserves, buys or saves. The Order is saved as cancelled
 * or rejected before its lines, so it is checked too.
 */
function openLine(lineId: string): GlideRecord | null {
    const line = findById('x_daas_ham_order_line', lineId)
    if (!line || ENDED_ORDER_STAGES.includes(str(line, 'order.stage'))) return null
    return OPEN_LINE_STAGES.includes(str(line, 'line_stage') as LineStage) ? line : null
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
    let rmaRefused = false
    if (route === 'oem_advance_replacement' && sourced.replaced) {
        // Unrecorded, the line would wait for a replacement nobody asked the OEM for: logged and in its summary.
        const rma = { defectiveAsset: sourced.replaced, orderLineId: sourced.lineId, caseId: str(order, 'case') }
        if (!openOemRma(rma)) {
            rmaRefused = true
            gs.warn(`[x_daas_ham] ${number}: no OEM RMA saved for ${str(sourced.replaced, 'serial_number')}`)
        }
    }
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
    line.setValue('sourcing_summary', rmaRefused ? `${outcome.summary} (none saved: open it by hand)` : outcome.summary)
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
 * False when the platform refuses (logged): the Asset stays on the line.
 */
function unreserve(asset: GlideRecord, source: Source): boolean {
    asset.setValue('x_daas_ham_order_line', '')
    if (source === 'spare_pool') return moveAndSave(asset, 'spare_pool', 'no transfer order')
    asset.setValue('company', stringProperty(PROPERTY.providerCompany))
    asset.setValue('x_daas_ham_agreement', '')
    return moveAndSave(asset, 'available', 'no transfer order')
}

/**
 * Give an allocated Asset back to stock: hot spares stay in the Spare pool, the rest become free stock. False when
 * the platform refuses that or the closing of its Staging tasks (logged).
 */
function releaseAsset(asset: GlideRecord): boolean {
    const closed = closeOpenStagingTasks(asset.getUniqueValue())
    asset.setValue('x_daas_ham_order_line', '')
    if (readStage(asset) === 'spare_pool') {
        // Still linked to the line, the spare is never picked again.
        if (asset.update()) return closed
        saveRefused(asset, `order cancelled: ${str(asset, 'serial_number')} still linked to its line, unlink it`)
        return false
    }
    asset.setValue('company', stringProperty(PROPERTY.providerCompany))
    asset.setValue('x_daas_ham_agreement', '')
    return moveAndSave(asset, 'available', 'order cancelled') && closed
}

/** Skip the Asset's open Staging tasks; false when the platform refuses one (logged). */
function closeOpenStagingTasks(assetId: string): boolean {
    const task = new GlideRecord('x_daas_ham_staging_task')
    task.addQuery('asset', assetId)
    task.addQuery('active', true)
    task.query()
    let closed = true
    while (task.next()) {
        task.setValue('state', 7)
        task.setValue('work_notes', 'Order cancelled; staging skipped.')
        if (task.update()) continue
        // Left open, it asks a technician to stage a unit that is back in stock.
        saveRefused(task, `order cancelled: ${str(task, 'number')} left open, close it`)
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
        line.setValue('line_stage', 'cancelled')
        if (line.update()) continue
        // Left open, it is still given the units received on its purchase orders.
        saveRefused(line, `order cancelled: ${str(line, 'number')} left open, cancel it`)
        done = false
    }
    return done
}

/**
 * UI action "Cancel order": only before anything has shipped; releases stock and staging work. The Order is saved
 * first, with the purchase orders to cancel: one the platform refuses keeps its lines, stock and approvals.
 *
 * A sourcing pass running meanwhile would reserve stock for, or buy for, lines just cancelled, and its purchase orders
 * would not be listed to cancel. So the cancel holds the Order's sourcing lock (`sourceOrder`) and the two take turns;
 * a cancel that finds it held changes nothing and tells the user to try again. Taking the lock throws only when an
 * insert is refused with no lock row (platform/locks): that error escapes.
 */
export function cancelOrder(order: GlideRecord): void {
    const taken = withLock(sourcingLockName(order.getUniqueValue()), (lock) => cancelHolding(lock, order))
    if (!taken) gs.addErrorMessage('Order not cancelled: sourcing is running on it. Try again in a minute')
}

/** The cancel, holding the Order's sourcing `lock`. */
function cancelHolding(lock: HeldLock, order: GlideRecord): void {
    const shipped = new GlideRecord('x_daas_ham_order_line')
    shipped.addQuery('order', order.getUniqueValue())
    shipped.addQuery('line_stage', 'IN', 'shipped,installed,in_service')
    shipped.setLimit(1)
    shipped.query()
    if (shipped.hasNext()) {
        gs.addErrorMessage('Equipment has already shipped; return it with a return order instead of cancelling')
        return
    }
    const purchases = openPurchaseOrders(order.getUniqueValue())
    order.setValue('stage', 'cancelled')
    order.setValue('state', 7)
    if (purchases.length > 0) order.setValue('work_notes', `Cancel these purchase orders in Procurement: ${purchases.join(', ')}`)
    if (!order.update()) {
        const reason = saveRefused(order, `${str(order, 'number')} not cancelled`)
        return void gs.addErrorMessage(`Order not cancelled: ${reason}`)
    }
    if (!cancelOpenLines(order.getUniqueValue())) {
        gs.addErrorMessage('Order cancelled; some lines, stock or staging tasks were left as they were (see the log)')
    }
    // A cancel that outlasted the lock (ADR 0013) may have overlapped a pass that took it over; that pass skips the
    // lines it reads after the Order was saved cancelled (`openLine`), not those it reached first.
    if (!lock.held()) {
        const check = 'check its lines for stock reserved or bought meanwhile'
        gs.warn(`[x_daas_ham] ${str(order, 'number')} cancelled after its sourcing lock was lost: ${check}`)
    }
    // After the save, so the approval rule each cancellation runs finds the Order no longer awaiting approval.
    cancelPendingApprovals(order.getUniqueValue())
}

/** Source the Order again for a line that lost an allocated Asset (failed staging) or a unit received for it. */
export function resourceOrder(orderId: string): void {
    const order = findById('x_daas_ham_order', orderId)
    if (order) fire(EVENT.sourceOrder, order)
}
