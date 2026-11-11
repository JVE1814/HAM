import { gs, type GlideRecord } from '@servicenow/glide'
import { isFleetAsset } from '../platform/assets.ts'
import { raiseReplacement } from '../platform/breakfix.ts'
import { returnDefectiveToOem } from '../platform/oem-rma.ts'
import { findById, str, type ForeignRecord } from '../platform/records.ts'

/** Break-fix: a CSM case about a failed Asset drives a device-replace Order (P2.3, D58). */

/**
 * Before insert/update rule on cases naming a failed Asset: take the customer and service level from it. A failed
 * asset outside the fleet (ADR 0016), set by a script past the field's reference qualifier, gives the case nothing.
 */
export function onCaseFailedAsset(current: ForeignRecord): void {
    const asset = findById('alm_hardware', str(current, 'x_daas_ham_failed_asset'))
    if (!asset || !isFleetAsset(asset)) return
    current.setValue('x_daas_ham_replacement_tier', str(asset, 'x_daas_ham_agreement.replacement_tier'))
    if (!str(current, 'account')) current.setValue('account', str(asset, 'company'))
}

export function uiRaiseReplacement(current: GlideRecord): void {
    // A refused form save (the platform says why) raises nothing: the failed asset and linked Order would be values the
    // case does not hold.
    if (!current.update()) return
    const replacement = raiseReplacement(current)
    switch (replacement.outcome) {
        case 'raised':
            if (replacement.already) gs.addInfoMessage(replacement.already)
            return void gs.addInfoMessage(`Replacement order ${replacement.number} raised`)
        case 'already_raised':
            return void gs.addInfoMessage(`Replacement order ${replacement.number} is already raised (${replacement.stageLabel})`)
        case 'draft':
            gs.addErrorMessage(replacement.why)
            return void gs.addInfoMessage(`Replacement order ${replacement.number} is left as a draft: correct it and submit it`)
        case 'not_raised':
            return void gs.addErrorMessage(replacement.why)
    }
}

export function uiDefectiveReturnedToOem(current: GlideRecord): void {
    const problem = returnDefectiveToOem(current)
    if (problem) gs.addErrorMessage(problem)
}
