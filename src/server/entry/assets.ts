import { gs, type GlideRecord } from '@servicenow/glide'
import { billingChange, checkTransition, voidsWipeEvidence } from '../domain/lifecycle'
import { clearWipeEvidence, readStage, transitionFacts } from '../platform/assets'
import { glideToIsoDate, todayIso } from '../platform/clock'
import { recomputeLine } from '../platform/fulfilment'
import { str } from '../platform/records'
import { closeServiceIntervals, openServiceInterval } from '../platform/service-intervals'
import { ROLE } from '../domain/visibility'

// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.

/**
 * Before-update rule on alm_hardware: people editing the stage on a form must follow the lifecycle
 * (ADR 0002). Background processes and administrators are not checked, but every save into staging
 * clears the wipe evidence, theirs too: one that sets the stage without moveAsset stages the Asset all the same.
 */
export function enforceLifecycle(current: GlideRecord, previous: GlideRecord): void {
    const from = readStage(previous)
    const to = readStage(current)
    if (to !== null && voidsWipeEvidence(from, to)) clearWipeEvidence(current)
    if (!gs.isInteractive() || gs.hasRole(ROLE.admin)) return
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
 * After-update rule on alm_hardware stage changes: billing (the Service interval) starts when an Asset
 * enters service and stops when it leaves, on the day billingChange gives (D52, ADR 0009).
 */
export function onAssetServiceChange(current: GlideRecord, previous: GlideRecord): void {
    const change = billingChange(readStage(previous), readStage(current), {
        inServiceDate: glideToIsoDate(str(current, 'x_daas_ham_in_service_date')),
        today: todayIso(),
    })
    if (!change) return
    const lineId = str(current, 'x_daas_ham_subscription_line')
    if ('stop' in change) closeServiceIntervals(current.getUniqueValue(), change.stop)
    else if (lineId) openServiceInterval(current, lineId, change.start)
}
