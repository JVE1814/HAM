import type { GlideRecord } from '@servicenow/glide'
import { completeInstall, shipOrder } from './delivery'
import { cancelOrder, submitOrder } from './orders'

// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.

/*
 * Server-side UI action handlers. Each saves the form first so values typed before clicking
 * (tracking number, carrier, ...) are not lost.
 */

export function uiSubmitOrder(current: GlideRecord): void {
    current.update()
    submitOrder(current)
}

export function uiCancelOrder(current: GlideRecord): void {
    current.update()
    cancelOrder(current)
}

export function uiShipOrder(current: GlideRecord): void {
    current.update()
    shipOrder(current)
}

export function uiConfirmInstalled(current: GlideRecord): void {
    current.update()
    completeInstall(current)
}
