import { gs, type GlideRecord } from '@servicenow/glide'
import { beingInstalled, mayConfirmInstall } from '../domain/install-confirmation.ts'
import { completeInstall, completeInstallOfWork, installState, shipOrder } from '../platform/delivery.ts'
import { workWindowRefusal } from '../platform/field-work.ts'
import type { ForeignRecord } from '../platform/records.ts'
import { currentSession } from '../platform/session.ts'

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
    const outcome = shipOrder(current.getUniqueValue())
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

/** After-update rule on wm_order closed complete for a NaaS Order (platform/delivery `completeInstallOfWork`). */
export function onWorkOrderClosed(current: ForeignRecord): void {
    completeInstallOfWork(current)
}

/**
 * Condition of the before rule on wm_order (br_work_order_window), once a NaaS Order's planned start or end changes:
 * whether the save must be refused (platform/field-work `workWindowRefusal`). The rule refuses it with its Abort action, not with current.setAbortAction, which
 * the platform refuses from a scoped app on a record of a global table and saves anyway (as for racks.ts
 * refusesRackPlacement).
 */
export function refusesWorkWindow(current: ForeignRecord): boolean {
    return workWindowRefusal(current) !== null
}

/** Script of that rule, run only when its condition refuses the save: why, as the error message. */
export function explainWorkWindowRefusal(current: ForeignRecord): void {
    gs.addErrorMessage(workWindowRefusal(current) ?? 'This work order schedule is refused')
}
