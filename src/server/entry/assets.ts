import { gs } from '@servicenow/glide'
import { stageChangeRefusal, voidsWipeEvidence } from '../domain/lifecycle.ts'
import { ROLE } from '../domain/roles.ts'
import { clearWipeEvidence, readStage, transitionFacts } from '../platform/assets.ts'
import type { ForeignRecord } from '../platform/records.ts'
import { onTransferOrderLine } from '../platform/transfers.ts'

/**
 * Why a save that changes the stage breaks the lifecycle, or null when it may
 * be saved (docs/spec/p1-fulfilment.md, Lifecycle stages): a save a user without admin makes in their own transaction
 * must follow it, a form edit or out-of-box logic that user's action runs (Inventory pushing a transfer order line's
 * stage to its Asset, external-contracts N38: In transfer only while the Asset is on an open line); background
 * processes and administrators are not checked.
 */
function lifecycleRefusal(current: ForeignRecord, previous: ForeignRecord): string | null {
    if (!gs.isInteractive() || gs.hasRole(ROLE.admin)) return null
    const facts = { ...transitionFacts(current), onTransferOrderLine: onTransferOrderLine(current) }
    return stageChangeRefusal(readStage(previous), readStage(current), facts)
}

/**
 * Condition of the before-update rule on alm_hardware (br_asset_enforce_lifecycle), once the stage changes: whether
 * the save must be refused. The rule refuses it with its Abort action, not with current.setAbortAction, which the
 * platform refuses from a scoped app on a record of a global table and saves anyway.
 */
export function refusesLifecycleChange(current: ForeignRecord, previous: ForeignRecord): boolean {
    return lifecycleRefusal(current, previous) !== null
}

/** Script of that rule, run only when its condition refuses the save: why, as the error message. */
export function explainLifecycleRefusal(current: ForeignRecord, previous: ForeignRecord): void {
    gs.addErrorMessage(lifecycleRefusal(current, previous) ?? 'This stage change is refused')
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
