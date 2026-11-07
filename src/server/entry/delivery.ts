import { GlideDateTime, GlideRecord, GlideSchedule, gs } from '@servicenow/glide'
import { isDeployed } from '../domain/lifecycle'
import { checkJobWindow } from '../domain/scheduling'
import { moveAndSave, readStage } from '../platform/assets'
import { glideToMs } from '../platform/clock'
import { openChange, openWorkOrder, type WorkContext } from '../platform/field-work'
import { recomputeOrder } from '../platform/fulfilment'
import { findById, str } from '../platform/records'
import { returnReplacedAssets } from './returns'

// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.

/** Shipping Orders to their Site, on-site work and install completion (P1.7). */

const ROUTINE_ORDER_TYPES = ['device_replace']

function orderAssets(orderId: string): GlideRecord {
    const asset = new GlideRecord('alm_hardware')
    asset.addQuery('x_daas_ham_order_line.order', orderId)
    asset.query()
    return asset
}

/** UI action "Ship": send every staged Asset to the Site and open the on-site work. */
export function shipOrder(order: GlideRecord): void {
    if (!str(order, 'tracking_number') && str(order, 'install_mode') !== 'remote_hands') {
        gs.addErrorMessage('Enter the carrier and tracking number before shipping')
        return
    }
    const siteId = str(order, 'site')
    const asset = orderAssets(order.getUniqueValue())
    let shipped = 0
    let hotSpares = 0
    while (asset.next()) {
        const stage = readStage(asset)
        if (stage !== 'staged' && stage !== 'spare_pool') continue
        asset.setValue('x_daas_ham_site', siteId)
        asset.setValue('location', siteId)
        if (stage === 'spare_pool') {
            asset.update()
            hotSpares++
        } else if (moveAndSave(asset, 'shipped', `ship ${str(order, 'number')}`)) {
            shipped++
        }
    }
    if (shipped + hotSpares === 0) {
        gs.addErrorMessage('Nothing is staged for this order yet')
        return
    }
    if (str(order, 'install_mode') !== 'self_install' && !str(order, 'work_order')) openOnSiteWork(order)
    gs.addInfoMessage(`${shipped} asset(s) shipped to ${str(order, 'site.name')}`)
    recomputeOrder(order.getUniqueValue())
}

function openOnSiteWork(order: GlideRecord): void {
    const context: WorkContext = {
        customerId: str(order, 'customer'),
        siteId: str(order, 'site'),
        description: `${str(order, 'number')}: ${str(order, 'order_type')} at ${str(order, 'site.name')}`,
        source: { field: 'x_daas_ham_order', id: order.getUniqueValue() },
    }
    const changeId = openChange(context, ROUTINE_ORDER_TYPES.includes(str(order, 'order_type')) ? 'standard' : 'normal')
    const workOrderId = openWorkOrder(
        context,
        ['device_replace', 'refresh'].includes(str(order, 'order_type')) ? 'swap' : 'install',
        changeId,
        ['subcontractor', 'remote_hands'].includes(str(order, 'install_mode')),
    )
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
