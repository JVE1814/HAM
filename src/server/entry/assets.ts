import { gs } from '@servicenow/glide'
import { billingChange, stageChangeRefusal, voidsWipeEvidence } from '../domain/lifecycle.ts'
import { ROLE } from '../domain/roles.ts'
import { clearWipeEvidence, readStage, transitionFacts } from '../platform/assets.ts'
import { glideToIsoDate, todayIso } from '../platform/clock.ts'
import { onLineAssetMoved } from '../platform/fulfilment.ts'
import { str, type ForeignRecord } from '../platform/records.ts'
import { closeServiceIntervals, openServiceInterval } from '../platform/service-intervals.ts'
import { putBackUntransferred } from '../platform/sourcing.ts'
import { fellShortOfStagingCentre, onTransferOrderLine, takeBackStageAfterTransfer } from '../platform/transfers.ts'

/**
 * Why a save that changes the stage breaks the lifecycle (domain/lifecycle `stageChangeRefusal`), or null when it may
 * be saved (docs/spec/p1-fulfilment.md, Lifecycle stages): a save a user without admin makes in their own transaction
 * must follow it, a form edit or out-of-box logic that user's action runs (Inventory pushing a transfer order line's
 * stage to its Asset, external-contracts N38: In transfer only while the Asset is on an open line); background
 * processes and administrators are not checked. Only reads: the wipe evidence a save into staging voids is cleared by
 * a rule of its own (clearVoidedWipeEvidence), and only a move out of the Provider reads that evidence, never one into
 * staging.
 */
function lifecycleRefusal(current: ForeignRecord, previous: ForeignRecord): string | null {
    if (!gs.isInteractive() || gs.hasRole(ROLE.admin)) return null
    const facts = { ...transitionFacts(current), onTransferOrderLine: onTransferOrderLine(current) }
    return stageChangeRefusal(readStage(previous), readStage(current), facts)
}

/**
 * Condition of the before-update rule on alm_hardware (br_asset_enforce_lifecycle), once the stage changes: whether
 * the save must be refused. The rule refuses it with its Abort action, not with current.setAbortAction, which the
 * platform refuses from a scoped app on a record of a global table and saves anyway (as for racks.ts
 * refusesRackPlacement).
 */
export function refusesLifecycleChange(current: ForeignRecord, previous: ForeignRecord): boolean {
    return lifecycleRefusal(current, previous) !== null
}

/** Script of that rule, run only when its condition refuses the save: why, as the error message. */
export function explainLifecycleRefusal(current: ForeignRecord, previous: ForeignRecord): void {
    gs.addErrorMessage(lifecycleRefusal(current, previous) ?? 'This stage change is refused')
}

/**
 * Before-update rule on alm_hardware once Inventory's *Active transfer order* flag changes (br_asset_transfer_released),
 * ahead of the lifecycle rule: an Asset Inventory lets go from its transfer order line takes back the stage it left
 * (platform/transfers `takeBackStageAfterTransfer`), in the same save, so the lifecycle rule checks that move and the
 * after rules see it. A unit whose transfer to the staging centre fell through is reserved again there and put back by
 * the after rule (`onAllocatedAssetStageChange`).
 */
export function onTransferReleased(current: ForeignRecord, previous: ForeignRecord): void {
    takeBackStageAfterTransfer(current, previous)
}

/**
 * Before-update rule on alm_hardware stage changes: every save into staging clears the wipe evidence, whoever makes it
 * (administrators and background processes too): one that sets the stage without moveAsset stages the Asset all the
 * same. A save the lifecycle rule refuses is not written, so neither is this.
 */
export function clearVoidedWipeEvidence(current: ForeignRecord, previous: ForeignRecord): void {
    const to = readStage(current)
    if (to !== null && voidsWipeEvidence(readStage(previous), to)) clearWipeEvidence(current)
}

export function onAllocatedAssetStageChange(current: ForeignRecord, previous: ForeignRecord): void {
    const lineId = str(current, 'x_daas_ham_order_line')
    if (!lineId) return
    const from = readStage(previous)
    if (from === 'in_transfer' && fellShortOfStagingCentre(current)) return void putBackUntransferred(current, lineId)
    onLineAssetMoved(current, lineId, from, readStage(current))
}

/**
 * After-update rule on alm_hardware stage changes: billing (the Service interval) starts when an Asset
 * enters service and stops when it leaves, on the day billingChange gives (Q52, ADR 0009).
 */
export function onAssetServiceChange(current: ForeignRecord, previous: ForeignRecord): void {
    const change = billingChange(readStage(previous), readStage(current), {
        inServiceDate: glideToIsoDate(str(current, 'x_daas_ham_in_service_date')),
        today: todayIso(),
    })
    if (!change) return
    const lineId = str(current, 'x_daas_ham_subscription_line')
    if ('stop' in change) closeServiceIntervals(current.getUniqueValue(), change.stop)
    else if (lineId) openServiceInterval(current, lineId, change.start)
}
