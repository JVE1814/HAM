import { gs, type GlideRecord } from '@servicenow/glide'
import { mayConfirmInstall } from '../domain/install-confirmation'
import { str } from '../platform/records'
import { currentSession } from '../platform/session'
import { completeInstall, shipOrder } from './delivery'
import { cancelOrder, submitOrder } from './orders'

// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.

/*
 * Server-side UI action handlers. Each saves the form before it acts so values typed before clicking
 * (tracking number, carrier, Site, ...) are not lost. Submit, Ship and Confirm installed, which use them, stop when that
 * save is refused (the platform says why). Cancel order does not use them, and saves the Order itself first.
 */

export function uiSubmitOrder(current: GlideRecord): void {
    // Submit assesses the Order as the form holds it and may ask approvers to decide it: never on values not saved.
    if (!current.update()) return
    submitOrder(current)
}

export function uiCancelOrder(current: GlideRecord): void {
    current.update()
    cancelOrder(current)
}

export function uiShipOrder(current: GlideRecord): void {
    // A refused form save (the platform says why) ships nothing: Ship reads the Order afresh, so a tracking number
    // typed but not saved would go unused.
    if (!current.update()) return
    shipOrder(current)
}

/** "Confirm installed" is also offered to Customer contacts, who may only confirm a self-install (as on the customer page). */
export function uiConfirmInstalled(current: GlideRecord): void {
    if (!mayConfirmInstall(currentSession().scope, { stage: str(current, 'stage'), installMode: str(current, 'install_mode') })) {
        gs.addErrorMessage('Only a self-install can be confirmed here; other installs complete when their work order is closed')
        return
    }
    // Each unit takes the Order's Site as the form holds it: one not saved is not where it was installed.
    if (!current.update()) return
    const refused = completeInstall(current)
    if (refused > 0) gs.addErrorMessage(`${refused} unit(s) not confirmed installed (see the system log): try again`)
}
