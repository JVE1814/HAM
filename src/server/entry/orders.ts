import { GlideRecord, gs } from '@servicenow/glide'
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
import { shortfallRoute } from '../domain/returns'
import {
    planSourcing,
    shortfallOutcome,
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

/** Script action on x_daas_ham.order.source: allocate stock, request transfers and purchases. */
export function sourceOrder(event: GlideRecord, current: GlideRecord): void {
    const line = new GlideRecord('x_daas_ham_order_line')
    line.addQuery('order', current.getUniqueValue())
    line.addQuery('line_stage', 'IN', 'new,awaiting_stock')
    line.query()
    while (line.next()) sourceLine(current, line)
    recomputeOrder(current.getUniqueValue())
}

function sourceLine(order: GlideRecord, line: GlideRecord): void {
    const quantity = num(line, 'quantity')
    const allocated = countAllocated(line.getUniqueValue())
    // Units bought and not yet received: receiving one takes it off (warehouse allocateToWaitingLine).
    const onOrder = num(line, 'quantity_to_purchase')
    const shortfall = quantity - allocated - onOrder - openRmaCount(line.getUniqueValue())
    if (shortfall <= 0) return

    const modelId = str(line, 'model')
    const customerId = str(order, 'customer')
    const breakFix = str(order, 'order_type') === 'device_replace'
    const purpose = breakFix ? 'replace' : 'new'
    const request: SourcingRequest = { modelId, quantity: shortfall, customerId, siteId: str(order, 'site'), purpose }
    const plan = planSourcing(request, stockCandidates(request, shortfall * 5 + 50))

    const stagingId = stagingStockroom()
    const reservation = { orderLineId: line.getUniqueValue(), customerId, agreementId: str(order, 'agreement') }
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
    let released = 0
    for (const [from, picked] of toTransfer) {
        const transfer = requestTransfer({ fromStockroomId: from, toStockroomId: stagingId, assets: picked.map(({ asset }) => ({ assetId: asset.getUniqueValue(), modelId })) })
        if (transfer.ok) {
            transfers.push(transfer.transferId)
            toStage.push(...picked.map(({ asset }) => asset))
            continue
        }
        unmoved.push({ units: picked.length, from: picked[0].asset.getDisplayValue('stockroom'), reason: transfer.reason })
        for (const { asset, source } of picked) unreserve(asset, source)
        released += picked.length
    }
    // An Asset whose Staging task could not be opened stays reserved for the line rather than staging with no task to finish.
    for (const asset of toStage) {
        if (openStagingTask(asset, line.getUniqueValue())) moveAndSave(asset, 'staging', 'sourcing')
    }
    if (transfers.length > 0) {
        line.setValue('transfer_orders', [str(line, 'transfer_orders'), ...transfers].filter(Boolean).join(','))
    }
    // Unmoved stock is not bought (see shortfallOutcome).
    const toPurchase = shortfall - reserved
    // Only a break-fix line for the same Model can be served by the OEM's advance replacement; a
    // refresh line also names the Asset it replaces, but that Asset is healthy.
    const replaced = breakFix ? findById('alm_hardware', str(line, 'replaces_asset')) : null
    const sameModel = !!replaced && str(replaced, 'model') === modelId
    const route = shortfallRoute({
        missing: toPurchase,
        purpose: sameModel ? 'replace' : 'new',
        coveredToday: !!replaced && sameModel && str(replaced, 'x_daas_ham_coverage_end') >= todayIso(),
    })
    let rmaRefused = false
    if (route === 'oem_advance_replacement' && replaced) {
        // Unrecorded, the line would wait for a replacement nobody asked the OEM for: logged and in its summary.
        const rma = { defectiveAsset: replaced, orderLineId: line.getUniqueValue(), caseId: str(order, 'case') }
        if (!openOemRma(rma)) {
            rmaRefused = true
            gs.warn(`[x_daas_ham] ${str(line, 'number')}: no OEM RMA saved for ${str(replaced, 'serial_number')}`)
        }
    }
    const purchase = () =>
        requestPurchase({
            modelId,
            quantity: toPurchase,
            description: `${str(order, 'number')} ${str(line, 'number')}: ${toPurchase} x ${str(line, 'model.display_name')}`,
        })
    const outcome = shortfallOutcome(route, { planSummary: plan.summary, missing: toPurchase, onOrder, unmoved }, purchase)
    if (outcome.purchaseOrder) {
        // Every purchase order stays listed, so units of an earlier one are still allocated to the line on receipt.
        const listed = [str(line, 'purchase_orders'), outcome.purchaseOrder].filter(Boolean)
        line.setValue('purchase_order', outcome.purchaseOrder)
        line.setValue('purchase_orders', listed.join(','))
    }
    line.setValue('quantity_allocated', allocated + reserved - released)
    line.setValue('quantity_to_purchase', outcome.quantityToPurchase)
    line.setValue('sourcing_summary', rmaRefused ? `${outcome.summary} (none saved: open it by hand)` : outcome.summary)
    line.setValue('line_stage', outcome.stage)
    if (!line.update()) {
        // Unlisted, a purchase order's units are not allocated on receipt, and the next run buys the shortfall again.
        const unlisted = [outcome.purchaseOrder ?? '', ...transfers].filter(Boolean)
        const listThem = unlisted.length > 0 ? `; it does not list ${unlisted.join(', ')}, add them by hand` : ''
        saveRefused(line, `${str(line, 'number')} not saved after sourcing${listThem}`)
        return
    }
    recomputeLine(line.getUniqueValue())
}

function countAllocated(lineId: string): number {
    return count('alm_hardware', `x_daas_ham_order_line=${lineId}`)
}

/** Put back stock reserved for a line but never moved to staging: Spare-pool stock to the pool, the rest to free stock. */
function unreserve(asset: GlideRecord, source: Source): void {
    asset.setValue('x_daas_ham_order_line', '')
    if (source === 'spare_pool') {
        moveAndSave(asset, 'spare_pool', 'no transfer order')
        return
    }
    asset.setValue('company', stringProperty(PROPERTY.providerCompany))
    asset.setValue('x_daas_ham_agreement', '')
    moveAndSave(asset, 'available', 'no transfer order')
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
 */
export function cancelOrder(order: GlideRecord): void {
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
    // After the save, so the approval rule each cancellation runs finds the Order no longer awaiting approval.
    cancelPendingApprovals(order.getUniqueValue())
}

/** Re-source a line that lost an allocated Asset (failed staging). */
export function resourceOrder(orderId: string): void {
    const order = findById('x_daas_ham_order', orderId)
    if (order) fire(EVENT.sourceOrder, order)
}
