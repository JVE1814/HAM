import { GlideDateTime, GlideRecord, GlideSchedule, gs } from '@servicenow/glide'
import { planShipment, type InstallMode, type OnSiteWork, type OrderType } from '../domain/delivery'
import { isDeployed, stagesQuery } from '../domain/lifecycle'
import { checkJobWindow } from '../domain/scheduling'
import { moveAndSave, moveAsset, readStage } from '../platform/assets'
import { glideToMs } from '../platform/clock'
import { openChange, openWorkOrder, type WorkContext } from '../platform/field-work'
import { recomputeOrder } from '../platform/fulfilment'
import { findById, str } from '../platform/records'
import { returnReplacedAssets } from './returns'
import { labelOrder, shippingEnabled } from './shipping'

// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.

/** Shipping Orders to their Site, on-site work and install completion (P1.7). */

function orderAssets(orderId: string): GlideRecord {
    const asset = new GlideRecord('alm_hardware')
    asset.addQuery('x_daas_ham_order_line.order', orderId)
    asset.query()
    return asset
}

/**
 * UI action "Ship": send every staged Asset the lifecycle lets ship to the Site (buying the label for
 * those when the aggregator is on) and open the on-site work. Hot spares already at the Site are handed
 * over as shipped, without a package. Which Assets may ship is checked before a label is bought.
 */
export function shipOrder(order: GlideRecord): void {
    const siteId = str(order, 'site')
    const found = shippable(order.getUniqueValue(), siteId)
    const trackingNumber = str(order, 'tracking_number')
    const plan = planShipment({
        orderType: str(order, 'order_type') as OrderType,
        installMode: str(order, 'install_mode') as InstallMode,
        hasTrackingNumber: !!trackingNumber,
        trackingNumberBought: !!trackingNumber && labelBought(order.getUniqueValue(), trackingNumber),
        hasWorkOrder: !!str(order, 'work_order'),
        staged: found.staged.length,
        refused: found.refused,
        refusedReason: found.reason,
        hotSpares: found.hotSpares.length,
        shippingEnabled: shippingEnabled(),
    })
    for (const error of plan.errors) gs.addErrorMessage(error)
    if (!plan.ok) return
    if (plan.labelPackages !== null) {
        const label = labelOrder(order, plan.labelPackages)
        if (!label.ok) return void gs.addErrorMessage(`No shipping label: ${label.error}`)
        order.update()
    }
    const hotSpares = new Set(found.hotSpares)
    const asset = new GlideRecord('alm_hardware')
    // Found past the user's rules as shippable() found them, then saved with the rules on so the line moves on.
    asset.setWorkflow(false)
    asset.addQuery('sys_id', 'IN', [...found.staged, ...found.hotSpares].join(','))
    asset.query()
    asset.setWorkflow(true)
    let shipped = 0
    while (asset.next()) {
        // The label purchase takes time: an Asset moved on meanwhile is left alone.
        if (readStage(asset) !== (hotSpares.has(asset.getUniqueValue()) ? 'spare_pool' : 'staged')) continue
        placeAtSite(asset, siteId)
        // A hot spare is handed over where it is, as shipped: otherwise its line never gets past ready to ship.
        if (moveAndSave(asset, 'shipped', `ship ${str(order, 'number')}`)) shipped++
    }
    if (plan.onSiteWork) openOnSiteWork(order, plan.onSiteWork)
    gs.addInfoMessage(`${shipped} asset(s) shipped to ${str(order, 'site.name')}`)
    recomputeOrder(order.getUniqueValue())
}

/**
 * The Order's staged Assets and hot spares that may ship to `siteId` (sys_ids), with how many are refused
 * and the first reason. Each is tried with the move Ship makes, on the Site Ship gives it, without saving.
 * They are read past the user's before-query rules (ADR 0005): an inventory tech sees only the Assets of
 * their stockrooms, and a hot spare sits in the customer-site stockroom.
 */
function shippable(orderId: string, siteId: string): { staged: string[]; hotSpares: string[]; refused: number; reason: string } {
    const asset = new GlideRecord('alm_hardware')
    // Only tried, never saved, so the rules need not be turned back on.
    asset.setWorkflow(false)
    asset.addEncodedQuery(stagesQuery(['staged', 'spare_pool'], `x_daas_ham_order_line.order=${orderId}`))
    asset.query()
    const found = { staged: [] as string[], hotSpares: [] as string[], refused: 0, reason: '' }
    while (asset.next()) {
        const hotSpare = readStage(asset) === 'spare_pool'
        placeAtSite(asset, siteId)
        const verdict = moveAsset(asset, 'shipped')
        if (verdict.allowed) (hotSpare ? found.hotSpares : found.staged).push(asset.getUniqueValue())
        else {
            found.refused++
            found.reason ||= verdict.reason
        }
    }
    return found
}

/**
 * Whether `trackingNumber` is a label an earlier Ship of the Order bought, not one entered by hand: that
 * label covers only the boxes it was bought for, so Assets staged since need one of their own.
 */
function labelBought(orderId: string, trackingNumber: string): boolean {
    const shipment = new GlideRecord('x_daas_ham_shipment')
    shipment.addQuery('order', orderId)
    shipment.addQuery('direction', 'to_site')
    shipment.addQuery('tracking_number', trackingNumber)
    shipment.setLimit(1)
    shipment.query()
    return shipment.hasNext()
}

/** Put an Asset at the Order's Site (the caller saves). */
function placeAtSite(asset: GlideRecord, siteId: string): void {
    asset.setValue('x_daas_ham_site', siteId)
    asset.setValue('location', siteId)
}

function openOnSiteWork(order: GlideRecord, work: OnSiteWork): void {
    const context: WorkContext = {
        customerId: str(order, 'customer'),
        siteId: str(order, 'site'),
        description: `${str(order, 'number')}: ${str(order, 'order_type')} at ${str(order, 'site.name')}`,
        source: { field: 'x_daas_ham_order', id: order.getUniqueValue() },
    }
    const changeId = openChange(context, work.changeType)
    const workOrderId = openWorkOrder(context, work.purpose, changeId, work.subcontracted)
    order.setValue('change_request', changeId)
    order.setValue('work_order', workOrderId)
    order.update()
}

/** UI action "Confirm installed" and the FSM work-order completion rule. */
export function completeInstall(order: GlideRecord): void {
    const now = new GlideDateTime().getValue()
    const asset = orderAssets(order.getUniqueValue())
    while (asset.next()) {
        const stage = readStage(asset)
        if (stage !== 'shipped' && stage !== 'spare_pool') continue
        asset.setValue('x_daas_ham_install_completed', now)
        asset.setValue('x_daas_ham_site', str(order, 'site'))
        moveAndSave(asset, 'pending_in_service', `install ${str(order, 'number')}`)
    }
    retireReplacedAssets(order)
    recomputeOrder(order.getUniqueValue())
}

/** The Assets an Order replaced (break-fix, refresh) come out of service and go back on a Return order. */
function retireReplacedAssets(order: GlideRecord): void {
    const line = new GlideRecord('x_daas_ham_order_line')
    line.addQuery('order', order.getUniqueValue())
    line.addNotNullQuery('replaces_asset')
    line.query()
    const replaced: string[] = []
    while (line.next()) {
        const asset = findById('alm_hardware', str(line, 'replaces_asset'))
        const stage = asset ? readStage(asset) : null
        // Already pending return: an earlier completion (UI action, then work order close) raised it.
        if (asset && isDeployed(stage) && stage !== 'pending_return') replaced.push(asset.getUniqueValue())
    }
    returnReplacedAssets(order, replaced)
}

/** After-update rule on wm_order closed complete for a NaaS Order. */
export function onWorkOrderClosed(current: GlideRecord): void {
    const order = findById('x_daas_ham_order', str(current, 'x_daas_ham_order'))
    if (order && ['install', 'swap'].includes(str(current, 'x_daas_ham_purpose'))) completeInstall(order)
}

/** Before-update rule on wm_order: on-site work must fit its change window and the Site maintenance window. */
export function guardWorkWindow(current: GlideRecord): void {
    const jobStart = glideToMs(str(current, 'expected_start'))
    const jobEnd = glideToMs(str(current, 'estimated_end')) ?? jobStart
    if (jobStart === undefined || jobEnd === undefined || !gs.isInteractive()) return
    const change = findById('change_request', str(current, 'parent'))
    const changeStart = change ? glideToMs(str(change, 'start_date')) : undefined
    const changeEnd = change ? glideToMs(str(change, 'end_date')) : undefined
    const scheduleId = str(current, 'location.x_daas_ham_maintenance_schedule')
    const schedule = scheduleId ? new GlideSchedule(scheduleId) : null
    const verdict = checkJobWindow({
        jobStart,
        jobEnd,
        change: changeStart !== undefined && changeEnd !== undefined ? { start: changeStart, end: changeEnd } : undefined,
        inMaintenanceWindow:
            !schedule ||
            (schedule.isInSchedule(new GlideDateTime(str(current, 'expected_start'))) &&
                schedule.isInSchedule(new GlideDateTime(str(current, 'estimated_end') || str(current, 'expected_start')))),
    })
    if (!verdict.ok) {
        gs.addErrorMessage(verdict.reason)
        current.setAbortAction(true)
    }
}
