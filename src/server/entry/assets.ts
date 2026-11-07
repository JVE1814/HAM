import { gs, type GlideRecord } from '@servicenow/glide'
import { checkTransition, isBillable, stageOf } from '../domain/lifecycle'
import { readStage, transitionFacts } from '../platform/assets'
import { todayIso } from '../platform/clock'
import { recomputeLine } from '../platform/fulfilment'
import { str } from '../platform/records'
import { closeServiceIntervals } from '../platform/service-intervals'
import { ROLE } from '../domain/visibility'

// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.

/**
 * Before-update rule on alm_hardware: people editing the stage on a form must follow the lifecycle
 * (ADR 0002). Background processes and administrators are not checked.
 */
export function enforceLifecycle(current: GlideRecord, previous: GlideRecord): void {
    if (!gs.isInteractive() || gs.hasRole(ROLE.admin)) return
    const from = stageOf({ installStatus: str(previous, 'install_status'), substatus: str(previous, 'substatus') })
    const to = readStage(current)
    if (to === null) {
        gs.addErrorMessage('This install status / substatus combination is not used by NaaS asset management')
        current.setAbortAction(true)
        return
    }
    const verdict = checkTransition(from, to, transitionFacts(current))
    if (!verdict.allowed) {
        gs.addErrorMessage(verdict.reason)
        current.setAbortAction(true)
    }
}

/** After-update rule on alm_hardware: an allocated Asset changed stage, so its Order line may advance. */
export function onAllocatedAssetStageChange(current: GlideRecord): void {
    const lineId = str(current, 'x_daas_ham_order_line')
    if (lineId) recomputeLine(lineId)
}

/**
 * After-update rule on alm_hardware stage changes: billing stops the day an Asset leaves service
 * (goes on a Return order, is declared missing, or is moved by hand), whatever moved it (D52).
 */
export function onAssetLeftService(current: GlideRecord, previous: GlideRecord): void {
    const before = stageOf({ installStatus: str(previous, 'install_status'), substatus: str(previous, 'substatus') })
    if (isBillable(before) && !isBillable(readStage(current))) closeServiceIntervals(current.getUniqueValue(), todayIso())
}
