import type { Stage } from './lifecycle'
import type { VisibilityScope } from './visibility'

/**
 * Who may record an Order as installed (P1 fulfilment, D49). An install by an FSM engineer, a subcontractor or
 * remote hands completes when its work order is closed; a self-install waits for the Customer to confirm it.
 */

/** What these rules read of an Order. */
export interface InstallState {
    stage: string
    installMode: string
    /** How many of its units are shipped (`awaitsInstall`): read only for an Order held back before installing. */
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

/**
 * Whether the Order has equipment at its Site to confirm installed: it is installing, or a line not shipped yet holds
 * it back while units already shipped wait there. Confirming installs only those; the line waits for its own units.
 */
export function beingInstalled(order: InstallState): boolean {
    return order.stage === 'installing' || (HELD_BACK.includes(order.stage) && order.shippedUnits() > 0)
}

/** Whether the Order waits for its Customer to confirm a self-install. */
export function awaitsSelfInstallConfirmation(order: InstallState): boolean {
    return order.installMode === 'self_install' && beingInstalled(order)
}

/**
 * Whether a user with visibility `scope` may record the Order as installed. Staff who see every Customer may do so
 * for any Order being installed (for instance when its work order was closed elsewhere); everyone else, such as
 * Customer contacts, only confirms a self-install.
 */
export function mayConfirmInstall(scope: VisibilityScope, order: InstallState): boolean {
    if (scope === 'everything') return beingInstalled(order)
    return awaitsSelfInstallConfirmation(order)
}
