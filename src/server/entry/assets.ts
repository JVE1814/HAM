import { gs, type GlideRecord } from '@servicenow/glide'
import { billingChange, stageAfterTransfer, stageChangeRefusal, voidsWipeEvidence } from '../domain/lifecycle.ts'
import { clearWipeEvidence, moveAsset, readStage, transitionFacts } from '../platform/assets.ts'
import { glideToIsoDate, todayIso } from '../platform/clock.ts'
import { onLineAssetMoved } from '../platform/fulfilment.ts'
import { str } from '../platform/records.ts'
import { closeServiceIntervals, openServiceInterval } from '../platform/service-intervals.ts'
import { putBackUntransferred } from '../platform/sourcing.ts'
import { fellShortOfStagingCentre, onTransferOrderLine, transferContext } from '../platform/transfers.ts'
import { ROLE } from '../domain/visibility.ts'

/**
 * Why a save that changes the stage breaks the lifecycle (domain/lifecycle `stageChangeRefusal`), or null when it may
 * be saved (docs/spec/p1-fulfilment.md, Lifecycle stages): a save a user without admin makes in their own transaction
 * must follow it, a form edit or out-of-box logic that user's action runs (Inventory pushing a transfer order line's
 * stage to its Asset, external-contracts N38: In transfer only while the Asset is on an open line); background
 * processes and administrators are not checked. Only reads: the wipe evidence a save into staging voids is cleared by
 * a rule of its own (clearVoidedWipeEvidence), and only a move out of the Provider reads that evidence, never one into
 * staging.
 */
function lifecycleRefusal(current: GlideRecord, previous: GlideRecord): string | null {
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
export function refusesLifecycleChange(current: GlideRecord, previous: GlideRecord): boolean {
    return lifecycleRefusal(current, previous) !== null
}

/** Script of that rule, run only when its condition refuses the save: why, as the error message. */
export function explainLifecycleRefusal(current: GlideRecord, previous: GlideRecord): void {
    gs.addErrorMessage(lifecycleRefusal(current, previous) ?? 'This stage change is refused')
}

/**
 * Before-update rule on alm_hardware once Inventory's *Active transfer order* flag changes (br_asset_transfer_released),
 * ahead of the lifecycle rule. When Inventory lets the Asset go from its transfer order line, it clears the flag and
 * saves it In stock: Available (Reserved for a line requested for a user) in the transfer order's to-stockroom once
 * received, Available where it was when the line is cancelled or deleted (external-contracts N38, N39). The Asset takes
 * back the stage it left instead (domain/lifecycle `stageAfterTransfer`), in the same save, so the lifecycle rule
 * checks that move and the after rules see it; the stockroom Inventory set is kept. A unit whose transfer to the
 * staging centre fell through is reserved again here and put back by the after rule (`onAllocatedAssetStageChange`).
 * Any other save is left as it is: one putting the Asset onto a line, or one leaving it in transfer with the flag
 * cleared (its line received after its last task was closed skipped), for its stage to be set by hand.
 */
export function onTransferReleased(current: GlideRecord, previous: GlideRecord): void {
    const now = readStage(current)
    const released = readStage(previous) === 'in_transfer' && now !== 'in_transfer' && !onTransferOrderLine(current)
    if (!released) return
    const stage = stageAfterTransfer(transferContext(current))
    // From the stock Inventory made it: each stage it can take back is a move the matrix allows from there.
    const verdict = moveAsset(current, stage)
    if (verdict.allowed) return
    gs.warn(`[x_daas_ham] ${str(current, 'serial_number')} left its transfer as ${now}, not ${stage}: ${verdict.reason}`)
}

/**
 * Before-update rule on alm_hardware stage changes: every save into staging clears the wipe evidence, whoever makes it
 * (administrators and background processes too): one that sets the stage without moveAsset stages the Asset all the
 * same. A save the lifecycle rule refuses is not written, so neither is this.
 */
export function clearVoidedWipeEvidence(current: GlideRecord, previous: GlideRecord): void {
    const to = readStage(current)
    if (to !== null && voidsWipeEvidence(readStage(previous), to)) clearWipeEvidence(current)
}

/**
 * After-update rule on alm_hardware: an allocated Asset changed stage, so its Order line may advance. A unit that left
 * the line in transit is taken off it and the line goes back to awaiting stock (platform/fulfilment
 * `onLineAssetMoved`): its Order is then sourced again, queued as after a failed staging, so this save takes no
 * sourcing lock. So is the Order of a unit whose transfer to the staging centre fell through, once it is put back
 * (platform/sourcing `putBackUntransferred`).
 */
export function onAllocatedAssetStageChange(current: GlideRecord, previous: GlideRecord): void {
    const lineId = str(current, 'x_daas_ham_order_line')
    if (!lineId) return
    const from = readStage(previous)
    if (from === 'in_transfer' && fellShortOfStagingCentre(current)) return void putBackUntransferred(current, lineId)
    onLineAssetMoved(current, lineId, from, readStage(current))
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
