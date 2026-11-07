import { gs, type GlideRecord } from '@servicenow/glide'
import { toIsoDate } from '../domain/calendar'
import { billingChange, checkTransition, stageOf } from '../domain/lifecycle'
import { readStage, transitionFacts } from '../platform/assets'
import { glideToMs, todayIso } from '../platform/clock'
import { recomputeLine } from '../platform/fulfilment'
import { str } from '../platform/records'
import { closeServiceIntervals, openServiceInterval } from '../platform/service-intervals'
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
 * After-update rule on alm_hardware stage changes: billing (the Service interval) starts when an Asset
 * enters service — from its in-service date on first go-live, else today (e.g. found after being
 * missing) — and stops the day it leaves service, whatever moved it (D52, ADR 0009).
 */
export function onAssetServiceChange(current: GlideRecord, previous: GlideRecord): void {
    const before = stageOf({ installStatus: str(previous, 'install_status'), substatus: str(previous, 'substatus') })
    const change = billingChange(before, readStage(current))
    if (change === 'stop') closeServiceIntervals(current.getUniqueValue(), todayIso())
    if (change !== 'start') return
    const inService = glideToMs(str(current, 'x_daas_ham_in_service_date'))
    const start = before === 'pending_in_service' && inService !== undefined ? toIsoDate(inService) : todayIso()
    openServiceInterval(current, str(current, 'x_daas_ham_subscription_line'), start)
}
