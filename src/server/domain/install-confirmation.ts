import type { Stage } from './lifecycle.ts'
import type { VisibilityScope } from './visibility.ts'
import type { InstallMode, OrderStage } from './vocabulary.ts'

/**
 * Who may record an Order as installed (P1 fulfilment, Q49). An install by an FSM engineer, a subcontractor or
 * remote hands completes when its work order is closed; a self-install waits for the Customer to confirm it.
 */

export interface InstallState {
    stage: OrderStage
    installMode: InstallMode
    shippedUnits(): number
}

/**
 * Whether a unit is one that confirming the install moves to pending in service: shipped, a hot spare handed over at
 * Ship included. A unit not shipped yet (one for a line filled again, a hot spare not yet handed over) waits for Ship.
 */
export function awaitsInstall(stage: Stage | null): boolean {
    return stage === 'shipped'
}

/**
 * Order stages a line not shipped yet holds an Order back in while units already shipped wait at the Site: a line
 * filled again after a unit was lost in transit (domain/fulfilment `refillsLine`) sends it back to preparing, and it
 * is delivering until Ship sends the replacement. An Order is delivering too after a Ship that refused some units.
 */
const HELD_BACK: readonly string[] = ['preparing', 'delivering']

function beingInstalled(order: InstallState): boolean {
    return order.stage === 'installing' || (HELD_BACK.includes(order.stage) && order.shippedUnits() > 0)
}

export function awaitsSelfInstallConfirmation(order: InstallState): boolean {
    return order.installMode === 'self_install' && beingInstalled(order)
}

/**
 * Who records an Order as installed. Staff record any Order being installed (for instance when its work order was
 * closed elsewhere); a Customer contact only confirms a self-install, and so does anyone on the customer page.
 */
export type InstallConfirmer = 'staff' | 'customer'

export function confirmerFor(scope: VisibilityScope): InstallConfirmer {
    return scope === 'everything' ? 'staff' : 'customer'
}

export type InstallRefusal = 'nothing_waiting' | 'not_self_install'

export function installRefusal(confirmer: InstallConfirmer, order: InstallState): InstallRefusal | null {
    if (confirmer === 'staff' ? beingInstalled(order) : awaitsSelfInstallConfirmation(order)) return null
    return beingInstalled(order) ? 'not_self_install' : 'nothing_waiting'
}
