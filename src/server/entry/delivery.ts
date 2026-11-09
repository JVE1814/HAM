import { GlideDateTime, GlideSchedule, gs, type GlideRecord } from '@servicenow/glide'
import { beingInstalled, mayConfirmInstall } from '../domain/install-confirmation.ts'
import { checkJobWindow } from '../domain/scheduling.ts'
import { glideToMs } from '../platform/clock.ts'
import { completeInstall, installState, shipOrder } from '../platform/delivery.ts'
import { findById, str } from '../platform/records.ts'
import { currentSession } from '../platform/session.ts'
import { labelOrder, shippingEnabled } from './shipping.ts'

/*
 * Shipping Orders to their Site, on-site work and install completion (P1.7). The form buttons save the form before
 * they act, so values typed before clicking (tracking number, carrier, Site, ...) are not lost, and stop when that save
 * is refused (the platform says why).
 */

/** UI action "Ship" (platform/delivery `shipOrder`). */
export function uiShipOrder(current: GlideRecord): void {
    // A refused form save (the platform says why) ships nothing: Ship reads the Order afresh, so a tracking number
    // typed but not saved would go unused.
    if (!current.update()) return
    const outcome = shipOrder(current.getUniqueValue(), { enabled: shippingEnabled, buy: labelOrder })
    for (const problem of outcome.problems) gs.addErrorMessage(problem)
    if (outcome.shipped) gs.addInfoMessage(`${outcome.shipped.units} asset(s) shipped to ${outcome.shipped.siteName}`)
}

/**
 * UI action "Confirm installed". It is also offered to Customer contacts, who may only confirm a self-install (as on
 * the customer page), and on an Order a line filled again holds back, for the units already shipped
 * (domain/install-confirmation).
 */
export function uiConfirmInstalled(current: GlideRecord): void {
    const order = installState(current)
    if (!mayConfirmInstall(currentSession().scope, order)) {
        // A form opened earlier still offers it after its units were confirmed (by a work order closed, say).
        if (!beingInstalled(order)) return void gs.addErrorMessage('Nothing shipped is waiting to be installed')
        gs.addErrorMessage('Only a self-install can be confirmed here; other installs complete when their work order is closed')
        return
    }
    // Each unit takes the Order's Site as the form holds it: one not saved is not where it was installed.
    if (!current.update()) return
    const refused = completeInstall(current)
    if (refused > 0) gs.addErrorMessage(`${refused} unit(s) not confirmed installed (see the system log): try again`)
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
