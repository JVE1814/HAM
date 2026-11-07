import { GlideRecord, gs } from '@servicenow/glide'
import { groupDecisions, rollupApprovals } from '../domain/approvals'
import { approversFor, assessOrder, type EntitlementVerdict, type RequestedLine } from '../domain/entitlement'
import { shortfallOutcome, shortfallRoute, type RoutedShortfall } from '../domain/returns'
import { planSourcing } from '../domain/sourcing'
import { entitlementContext } from '../platform/agreements'
import { approvalsOf, cancelPendingApprovals, customerAdminIds, providerApproverIds, requestApproval } from '../platform/approvals'
import { moveAndSave, moveAsset, readStage } from '../platform/assets'
import { EVENT, fire } from '../platform/events'
import { recomputeLine, recomputeOrder } from '../platform/fulfilment'
import { todayIso } from '../platform/clock'
import { openOemRma, openRmaCount } from '../platform/oem-rma'
import { requestPurchase } from '../platform/procurement'
import { PROPERTY, stringProperty } from '../platform/properties'
import { bool, count, findById, num, str } from '../platform/records'
import { openStagingTask } from '../platform/staging-tasks'
import { reserveAsset, stockCandidates } from '../platform/stock'
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
 * Record producer post-insert script: create the lines and submit the Order.
 * (`current` is typed unknown because the SDK passes its own GlideRecord type here.)
 */
export function afterOrderProduced(producer: Record<string, unknown>, current: unknown): void {
    const order = current as GlideRecord
    const siteTemplateId = str(order, 'site_template')
    if (siteTemplateId) addLinesFromSiteTemplate(order.getUniqueValue(), siteTemplateId)
    for (const row of parseRows(producer.devices)) {
        if (row.model) addLine(order.getUniqueValue(), String(row.model), Math.max(1, Number(row.quantity) || 1), false)
    }
    submitOrder(order)
}

function parseRows(value: unknown): DeviceRow[] {
    try {
        const rows = JSON.parse(String(value ?? '[]'))
        return Array.isArray(rows) ? rows : []
    } catch {
        return []
    }
}

function addLinesFromSiteTemplate(orderId: string, siteTemplateId: string): void {
    const item = new GlideRecord('x_daas_ham_site_template_item')
    item.addQuery('site_template', siteTemplateId)
    item.addQuery('optional', false)
    item.query()
    while (item.next()) addLine(orderId, str(item, 'model'), num(item, 'quantity'), true)
}

function addLine(orderId: string, modelId: string, quantity: number, fromSiteTemplate: boolean): void {
    const line = new GlideRecord('x_daas_ham_order_line')
    line.initialize()
    line.setValue('order', orderId)
    line.setValue('model', modelId)
    line.setValue('quantity', quantity)
    line.setValue('from_site_template', fromSiteTemplate)
    line.insert()
}

/** UI action "Submit" on a draft Order, and the end of the record producer. */
export function submitOrder(order: GlideRecord): void {
    const lines = requestedLines(order.getUniqueValue())
    if (lines.length === 0) {
        gs.addErrorMessage('Add at least one order line before submitting')
        return
    }
    const assessment = assessOrder(
        { siteTemplateId: str(order, 'site_template') || undefined, lines },
        entitlementContext(str(order, 'customer'), str(order, 'agreement'), order.getUniqueValue()),
    )
    order.setValue('entitlement_verdict', assessment.verdict)
    order.setValue('entitlement_findings', assessment.findings.join('\n'))

    if (assessment.approvers.length === 0) {
        startSourcing(order)
        return
    }
    order.setValue('stage', 'awaiting_approval')
    order.setValue('approval', 'requested')
    order.update()
    const approvers = approverIds(order, assessment.verdict)
    if (approvers.length === 0) {
        order.setValue('work_notes', 'No customer admin, account manager or asset manager to approve; add an approver manually.')
        order.update()
    }
    for (const approverId of approvers) requestApproval(order, approverId)
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
function approverIds(order: GlideRecord, verdict: EntitlementVerdict): string[] {
    const provider = providerApproverIds(str(order, 'agreement.account_manager'))
    const ids = new Set<string>()
    for (const group of approversFor(verdict)) {
        const admins = group === 'customer_admin' ? customerAdminIds(str(order, 'customer')) : []
        for (const id of admins.length > 0 ? admins : provider) ids.add(id)
    }
    return [...ids]
}

function startSourcing(order: GlideRecord): void {
    order.setValue('approval', 'approved')
    order.setValue('stage', 'sourcing')
    order.setValue('state', 2)
    order.update()
    fire(EVENT.sourceOrder, order)
}

/** After-update rule on sysapproval_approver: roll the decisions up to the Order. */
export function onOrderApprovalDecision(current: GlideRecord): void {
    const order = findById('x_daas_ham_order', str(current, 'document_id'))
    if (!order || str(order, 'stage') !== 'awaiting_approval') return
    const decisions = groupDecisions(approvalsOf(order.getUniqueValue()), customerAdminIds(str(order, 'customer')))
    const outcome = rollupApprovals(approversFor(str(order, 'entitlement_verdict') as EntitlementVerdict), decisions)
    if (outcome === 'requested') return
    cancelPendingApprovals(order.getUniqueValue())
    if (outcome === 'approved') {
        startSourcing(order)
        return
    }
    cancelOpenLines(order.getUniqueValue())
    order.setValue('approval', 'rejected')
    order.setValue('stage', 'rejected')
    order.setValue('state', 4)
    order.update()
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
    const onOrder = str(line, 'purchase_order') ? num(line, 'quantity_to_purchase') : 0
    const shortfall = quantity - allocated - onOrder - openRmaCount(line.getUniqueValue())
    if (shortfall <= 0) return

    const modelId = str(line, 'model')
    const customerId = str(order, 'customer')
    const breakFix = str(order, 'order_type') === 'device_replace'
    const plan = planSourcing(
        { modelId, quantity: shortfall, customerId, purpose: breakFix ? 'replace' : 'new' },
        stockCandidates(modelId, shortfall * 5 + 50),
    )

    const stagingStockroom = stringProperty(PROPERTY.stagingStockroom)
    const toTransfer = new Map<string, Array<{ assetId: string; modelId: string }>>()
    let reserved = 0
    for (const pick of plan.picks) {
        const reservation = { orderLineId: line.getUniqueValue(), customerId, agreementId: str(order, 'agreement') }
        if (pick.source === 'customer_site_stock') {
            if (linkHotSpare(pick.assetId, reservation)) reserved++
            continue
        }
        const asset = reserveAsset(pick.assetId, reservation)
        if (!asset) continue
        reserved++
        const from = str(asset, 'stockroom')
        if (stagingStockroom && from && from !== stagingStockroom) {
            toTransfer.set(from, [...(toTransfer.get(from) ?? []), { assetId: pick.assetId, modelId }])
        }
        openStagingTask(asset, line.getUniqueValue())
        moveAndSave(asset, 'staging', 'sourcing')
    }
    const transfers = [...toTransfer].map(([from, assets]) =>
        requestTransfer({ fromStockroomId: from, toStockroomId: stagingStockroom, assets }),
    )
    if (transfers.length > 0) {
        line.setValue('transfer_orders', [str(line, 'transfer_orders'), ...transfers].filter(Boolean).join(','))
    }
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
    if (route === 'oem_advance_replacement' && replaced) {
        openOemRma({ defectiveAsset: replaced, orderLineId: line.getUniqueValue(), caseId: str(order, 'case') })
    }
    // Without a staging stockroom, or when Procurement creates no PO, the line waits for stock.
    const routed: RoutedShortfall =
        route === 'purchase'
            ? {
                  route,
                  purchase: requestPurchase({
                      modelId,
                      quantity: toPurchase,
                      shipToStockroomId: stagingStockroom,
                      description: `${str(order, 'number')} ${str(line, 'number')}: ${toPurchase} x ${str(line, 'model.display_name')}`,
                  }),
              }
            : { route }
    const outcome = shortfallOutcome(routed, { planSummary: plan.summary, missing: toPurchase, onOrder })
    if (outcome.purchaseOrder) line.setValue('purchase_order', outcome.purchaseOrder)
    line.setValue('quantity_allocated', allocated + reserved)
    line.setValue('quantity_to_purchase', outcome.quantityToPurchase)
    line.setValue('sourcing_summary', outcome.summary)
    line.setValue('line_stage', outcome.stage)
    line.update()
    recomputeLine(line.getUniqueValue())
}

function countAllocated(lineId: string): number {
    return count('alm_hardware', `x_daas_ham_order_line=${lineId}`)
}

/**
 * A hot spare already at the customer site needs no staging or shipping; it is installed from where
 * it is. Stock in a customer-site stockroom is that Customer's spare pool by definition.
 */
function linkHotSpare(assetId: string, reservation: { orderLineId: string; customerId: string; agreementId: string }): boolean {
    const asset = findById('alm_hardware', assetId)
    if (!asset || !moveAsset(asset, 'spare_pool').allowed) return false
    asset.setValue('x_daas_ham_order_line', reservation.orderLineId)
    asset.setValue('company', reservation.customerId)
    asset.setValue('x_daas_ham_agreement', reservation.agreementId)
    asset.update()
    return true
}

/** Give an allocated Asset back to stock: hot spares stay in the Spare pool, the rest become free stock. */
function releaseAsset(asset: GlideRecord): void {
    closeOpenStagingTasks(asset.getUniqueValue())
    asset.setValue('x_daas_ham_order_line', '')
    if (readStage(asset) === 'spare_pool') {
        asset.update()
        return
    }
    asset.setValue('company', stringProperty(PROPERTY.providerCompany))
    asset.setValue('x_daas_ham_agreement', '')
    moveAndSave(asset, 'available', 'order cancelled')
}

function closeOpenStagingTasks(assetId: string): void {
    const task = new GlideRecord('x_daas_ham_staging_task')
    task.addQuery('asset', assetId)
    task.addQuery('active', true)
    task.query()
    while (task.next()) {
        task.setValue('state', 7)
        task.setValue('work_notes', 'Order cancelled; staging skipped.')
        task.update()
    }
}

/** Cancel every line that has not shipped, releasing its stock. Returns the purchase orders left to cancel. */
function cancelOpenLines(orderId: string): string[] {
    const purchases: string[] = []
    const line = new GlideRecord('x_daas_ham_order_line')
    line.addQuery('order', orderId)
    line.addQuery('line_stage', 'IN', CANCELLABLE_LINE_STAGES)
    line.query()
    while (line.next()) {
        const asset = new GlideRecord('alm_hardware')
        asset.addQuery('x_daas_ham_order_line', line.getUniqueValue())
        asset.query()
        while (asset.next()) releaseAsset(asset)
        if (str(line, 'purchase_order')) purchases.push(line.getDisplayValue('purchase_order'))
        line.setValue('line_stage', 'cancelled')
        line.update()
    }
    return purchases
}

const CANCELLABLE_LINE_STAGES = 'new,awaiting_stock,sourced,staging,ready_to_ship'

/** UI action "Cancel order": only before anything has shipped; releases stock and staging work. */
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
    const purchases = cancelOpenLines(order.getUniqueValue())
    cancelPendingApprovals(order.getUniqueValue())
    order.setValue('stage', 'cancelled')
    order.setValue('state', 7)
    if (purchases.length > 0) order.setValue('work_notes', `Cancel these purchase orders in Procurement: ${purchases.join(', ')}`)
    order.update()
}

/** Re-source a line that lost an allocated Asset (failed staging). */
export function resourceOrder(orderId: string): void {
    const order = findById('x_daas_ham_order', orderId)
    if (order) fire(EVENT.sourceOrder, order)
}
