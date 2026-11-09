import { GlideDateTime, GlideRecord, GlideSchedule, gs } from '@servicenow/glide'
import { planShipment, replacementInstalled, type OnSiteWork } from '../domain/delivery.ts'
import { awaitsInstall, type InstallState } from '../domain/install-confirmation.ts'
import type { HeldLock } from '../domain/job-lock.ts'
import { isDeployed, stagesQuery } from '../domain/lifecycle.ts'
import { LOCK } from '../domain/lock-names.ts'
import { checkJobWindow } from '../domain/scheduling.ts'
import type { InstallMode, OrderStage, OrderType } from '../domain/vocabulary.ts'
import { moveAndSave, moveAsset, readStage } from '../platform/assets.ts'
import { beyondVisibility } from '../platform/beyond-visibility.ts'
import { glideToMs } from '../platform/clock.ts'
import { openFieldWork, type WorkContext } from '../platform/field-work.ts'
import { lineAssetStages, recomputeOrder } from '../platform/fulfilment.ts'
import { withLock } from '../platform/locks.ts'
import { findById, num, refusal, str } from '../platform/records.ts'
import { returnReplacedAssets } from './returns.ts'
import { labelOrder, shippingEnabled } from './shipping.ts'

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
 * What the install confirmation rules read of `order` (domain/install-confirmation). Its shipped units are counted at
 * most once, and as `completeInstall` finds them for the same user, so a confirmation offered has units to move.
 */
export function installState(order: GlideRecord): InstallState {
    const orderId = order.getUniqueValue()
    let shipped: number | undefined
    return {
        stage: str(order, 'stage') as OrderStage,
        installMode: str(order, 'install_mode') as InstallMode,
        shippedUnits: () => {
            if (shipped === undefined) shipped = countShipped(orderId)
            return shipped
        },
    }
}

function countShipped(orderId: string): number {
    const asset = orderAssets(orderId)
    let count = 0
    while (asset.next()) if (awaitsInstall(readStage(asset))) count++
    return count
}

/**
 * UI action "Ship": send every staged Asset the lifecycle lets ship to the Site (buying the label for
 * those when the aggregator is on) and open the on-site work. Hot spares already at the Site are handed
 * over as shipped, without a package. Which Assets may ship is checked before a label is bought.
 *
 * Two users pressing Ship while the first label purchase is in flight would both find the Order unshipped, and both
 * buy a label and open a change and work order. So Ship runs under a lock on the Order, from the Order read again
 * there; one that finds the lock held ships nothing and is told another Ship is running. Taking the lock throws only
 * when an insert is refused with no lock row (platform/locks); that error escapes.
 */
export function shipOrder(order: GlideRecord): void {
    const orderId = order.getUniqueValue()
    const ship = withLock(LOCK.shipOrder(orderId), (lock) => {
        // A Ship that ran meanwhile has put its tracking number and work order on the Order, and shipped its units.
        const fresh = findById('x_daas_ham_order', orderId)
        if (!fresh) return void gs.addErrorMessage('Order not found')
        shipHolding(lock, fresh)
    })
    if (!ship.ran) gs.addErrorMessage('Another Ship of this Order is running: reload the Order to see what it shipped')
}

/** Ship, holding the Order's `lock` (the label is bought only while it is held, entry/shipping). */
function shipHolding(lock: HeldLock, order: GlideRecord): void {
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
        const label = labelOrder(order, plan.labelPackages, lock)
        if (!label.ok) return void gs.addErrorMessage(`No shipping label: ${label.error}`)
        // The label is paid for and its Shipment saved, so the units still ship; only the Order lacks its tracking.
        if (!order.update()) {
            const tracking = str(order, 'tracking_number')
            gs.addErrorMessage(`Tracking number ${tracking} not saved on the Order: ${refusal(order)}`)
        }
    }
    const hotSpares = new Set(found.hotSpares)
    const asset = new GlideRecord('alm_hardware')
    // Found past the visibility rules as shippable() found them; saved with every rule, so the line moves on.
    asset.addQuery('sys_id', 'IN', [...found.staged, ...found.hotSpares].join(','))
    beyondVisibility(asset, () => asset.query())
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
    // Only tried, never saved.
    asset.addEncodedQuery(stagesQuery(['staged', 'spare_pool'], `x_daas_ham_order_line.order=${orderId}`))
    beyondVisibility(asset, () => asset.query())
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

/** Open the Order's change and work order; when the platform refuses either, link neither and say so. */
function openOnSiteWork(order: GlideRecord, work: OnSiteWork): void {
    const context: WorkContext = {
        customerId: str(order, 'customer'),
        siteId: str(order, 'site'),
        description: `${str(order, 'number')}: ${str(order, 'order_type')} at ${str(order, 'site.name')}`,
        sourceId: order.getUniqueValue(),
    }
    const opened = openFieldWork(context, work)
    if (!opened) return void gs.addErrorMessage('On-site work not opened (see the system log): open it by hand')
    order.setValue('change_request', opened.changeId)
    order.setValue('work_order', opened.workOrderId)
    // Unlinked, the next Ship opens the work again; the change and work order name the Order, to link them by hand.
    if (!order.update()) gs.addErrorMessage(`On-site work opened but not linked to the Order: ${refusal(order)}`)
}

/**
 * UI action "Confirm installed" and the FSM work-order completion rule. How many units the platform refused to move
 * (logged): they and their line stay where they were, and so does the Asset their line replaces, so confirming again
 * retries only them and then retires it.
 *
 * Only shipped units move (domain/install-confirmation `awaitsInstall`): on an Order held back by a line filled again
 * after a unit was lost in transit, that line's new units, a hot spare allocated to it included, wait for Ship.
 */
export function completeInstall(order: GlideRecord): number {
    const now = new GlideDateTime().getValue()
    const asset = orderAssets(order.getUniqueValue())
    let refused = 0
    while (asset.next()) {
        if (!awaitsInstall(readStage(asset))) continue
        asset.setValue('x_daas_ham_install_completed', now)
        asset.setValue('x_daas_ham_site', str(order, 'site'))
        if (!moveAndSave(asset, 'pending_in_service', `install ${str(order, 'number')}`)) refused++
    }
    retireReplacedAssets(order)
    recomputeOrder(order.getUniqueValue())
    return refused
}

/**
 * The Assets an Order replaced (break-fix, refresh) come out of service and go back on a Return order, each once its
 * own line's replacement is installed: retired beside a replacement still shipped, the Site would lose the device.
 * The line's units are read past the user's before-query rules, as when its stage is derived (ADR 0005).
 */
function retireReplacedAssets(order: GlideRecord): void {
    const line = new GlideRecord('x_daas_ham_order_line')
    line.addQuery('order', order.getUniqueValue())
    line.addNotNullQuery('replaces_asset')
    line.query()
    const replaced: string[] = []
    while (line.next()) {
        const replacement = { quantity: num(line, 'quantity'), assetStages: lineAssetStages(line.getUniqueValue()) }
        if (!replacementInstalled(replacement)) continue
        const asset = findById('alm_hardware', str(line, 'replaces_asset'))
        const stage = asset ? readStage(asset) : null
        // Already pending return: an earlier completion (UI action, then work order close) raised it.
        if (asset && isDeployed(stage) && stage !== 'pending_return') replaced.push(asset.getUniqueValue())
    }
    returnReplacedAssets(order, replaced)
}

/** After-update rule on wm_order closed complete for a NaaS Order: the work order was initiated from it. */
export function onWorkOrderClosed(current: GlideRecord): void {
    const order = findById('x_daas_ham_order', str(current, 'initiated_from'))
    if (order && ['install', 'swap'].includes(str(current, 'x_daas_ham_purpose'))) completeInstall(order)
}

/**
 * Why the on-site work a NaaS Order's work order plans does not fit its change window and the Site's maintenance
 * window (domain/scheduling `checkJobWindow`), or null when it fits. Only interactive saves are checked (background
 * processes are not), and only once the work has a planned start. Only reads.
 */
function workWindowRefusal(current: GlideRecord): string | null {
    const jobStart = glideToMs(str(current, 'expected_start'))
    const jobEnd = glideToMs(str(current, 'estimated_end')) ?? jobStart
    if (jobStart === undefined || jobEnd === undefined || !gs.isInteractive()) return null
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
    return verdict.ok ? null : verdict.reason
}

/**
 * Condition of the before rule on wm_order (br_work_order_window), once a NaaS Order's planned start or end changes:
 * whether the save must be refused. The rule refuses it with its Abort action, not with current.setAbortAction, which
 * the platform refuses from a scoped app on a record of a global table and saves anyway (as for racks.ts
 * refusesRackPlacement).
 */
export function refusesWorkWindow(current: GlideRecord): boolean {
    return workWindowRefusal(current) !== null
}

/** Script of that rule, run only when its condition refuses the save: why, as the error message. */
export function explainWorkWindowRefusal(current: GlideRecord): void {
    gs.addErrorMessage(workWindowRefusal(current) ?? 'This work order schedule is refused')
}
