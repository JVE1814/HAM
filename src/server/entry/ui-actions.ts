import { gs, type GlideRecord } from '@servicenow/glide'
import { beingInstalled, mayConfirmInstall } from '../domain/install-confirmation'
import { currentSession } from '../platform/session'
import { completeInstall, installState, shipOrder } from './delivery'
import { cancelOrder, recheckApprovals, submitOrder } from './orders'

// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.

/*
 * Server-side UI action handlers. Each saves the form before it acts so values typed before clicking
 * (tracking number, carrier, Site, ...) are not lost, and stops when that save is refused (the platform says why).
 */

export function uiSubmitOrder(current: GlideRecord): void {
    // Submit assesses the Order as the form holds it and may ask approvers to decide it: never on values not saved.
    if (!current.update()) return
    submitOrder(current)
}

export function uiCancelOrder(current: GlideRecord): void {
    // Cancel saves this same record again: going on after a refused save could store the values just refused.
    if (!current.update()) return
    cancelOrder(current)
}

/** "Re-check approvals": rolls an Order's approvals up again, as a decision does (entry/orders `recheckApprovals`). */
export function uiRecheckApprovals(current: GlideRecord): void {
    // A refused form save (the platform says why) re-checks nothing: the rollup reads the Order afresh, so it would
    // decide without what the form did not save.
    if (!current.update()) return
    recheckApprovals(current.getUniqueValue())
}

export function uiShipOrder(current: GlideRecord): void {
    // A refused form save (the platform says why) ships nothing: Ship reads the Order afresh, so a tracking number
    // typed but not saved would go unused.
    if (!current.update()) return
    shipOrder(current)
}

/**
 * "Confirm installed" is also offered to Customer contacts, who may only confirm a self-install (as on the customer
 * page), and on an Order a line filled again holds back, for the units already shipped (domain/install-confirmation).
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
