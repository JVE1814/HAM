import type { VisibilityScope } from './visibility'

/**
 * Who may record an Order as installed (P1 fulfilment, D49). An install by an FSM engineer, a subcontractor or
 * remote hands completes when its work order is closed; a self-install waits for the Customer to confirm it.
 */

/** What these rules read of an Order. */
export interface InstallState {
    stage: string
    installMode: string
}

/** Whether the Order waits for its Customer to confirm a self-install. */
export function awaitsSelfInstallConfirmation(order: InstallState): boolean {
    return order.stage === 'installing' && order.installMode === 'self_install'
}

/**
 * Whether a user with visibility `scope` may record the Order as installed. Staff who see every Customer may do so
 * for any Order being installed (for instance when its work order was closed elsewhere); everyone else, such as
 * Customer contacts, only confirms a self-install.
 */
export function mayConfirmInstall(scope: VisibilityScope, order: InstallState): boolean {
    if (scope === 'everything') return order.stage === 'installing'
    return awaitsSelfInstallConfirmation(order)
}
