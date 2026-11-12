import { gs, type GlideRecord } from '@servicenow/glide'
import { confirmerFor, type InstallRefusal } from '../domain/install-confirmation.ts'
import { confirmInstall, shipOrder } from '../platform/delivery.ts'
import { workWindowRefusal } from '../platform/field-work.ts'
import type { ForeignRecord } from '../platform/records.ts'
import { currentSession } from '../platform/session.ts'

export function uiShipOrder(current: GlideRecord): void {
    // A refused form save (the platform says why) ships nothing: Ship reads the Order afresh, so a tracking number
    // typed but not saved would go unused.
    if (!current.update()) return
    const outcome = shipOrder(current.getUniqueValue())
    for (const problem of outcome.problems) gs.addErrorMessage(problem)
    if (outcome.shipped) gs.addInfoMessage(`${outcome.shipped.units} asset(s) shipped to ${outcome.shipped.siteName}`)
}

/** A form opened earlier still offers Confirm installed once its units are confirmed (by a work order closed, say). */
const INSTALL_REFUSAL: Record<InstallRefusal, string> = {
    nothing_waiting: 'Nothing shipped is waiting to be installed',
    not_self_install: 'Only a self-install can be confirmed here; other installs complete when their work order is closed',
}

export function uiConfirmInstalled(current: GlideRecord): void {
    const outcome = confirmInstall(current, confirmerFor(currentSession().scope), () => !!current.update())
    if (outcome.confirmed) {
        if (outcome.refused > 0) gs.addErrorMessage(`${outcome.refused} unit(s) not confirmed installed (see the system log): try again`)
    } else if (outcome.why !== 'unsaved') gs.addErrorMessage(INSTALL_REFUSAL[outcome.why])
}

/**
 * Condition of the before rule on wm_order (br_work_order_window), once a NaaS Order's planned start or end changes:
 * whether the save must be refused. The rule refuses it with its Abort action, not with current.setAbortAction, which
 * the platform refuses from a scoped app on a record of a global table and saves anyway.
 */
export function refusesWorkWindow(current: ForeignRecord): boolean {
    return workWindowRefusal(current) !== null
}

/** Script of that rule, run only when its condition refuses the save: why, as the error message. */
export function explainWorkWindowRefusal(current: ForeignRecord): void {
    gs.addErrorMessage(workWindowRefusal(current) ?? 'This work order schedule is refused')
}
