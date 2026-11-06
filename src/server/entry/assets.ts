import { gs, type GlideRecord } from '@servicenow/glide'
import { checkTransition, stageOf } from '../domain/lifecycle'
import { readStage, transitionFacts } from '../platform/assets'
import { recomputeLine } from '../platform/fulfilment'
import { str } from '../platform/records'
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
