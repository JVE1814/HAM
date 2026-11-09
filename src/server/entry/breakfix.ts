import { gs, type GlideRecord } from '@servicenow/glide'
import { replacementProblem, replacementStep } from '../domain/breakfix.ts'
import type { OrderStage } from '../domain/vocabulary.ts'
import { isFleetAsset, readStage } from '../platform/assets.ts'
import { returnDefectiveToOem } from '../platform/oem-rma.ts'
import { createOrder, submitOrder } from '../platform/orders.ts'
import { findById, refusal, str } from '../platform/records.ts'

/** Break-fix: a CSM case about a failed Asset drives a device-replace Order (P2.3, D58). */

/**
 * Before insert/update rule on cases naming a failed Asset: take the customer and service level from it. A failed
 * asset outside the fleet (ADR 0016), set by a script past the field's reference qualifier, gives the case nothing.
 */
export function onCaseFailedAsset(current: GlideRecord): void {
    const asset = findById('alm_hardware', str(current, 'x_daas_ham_failed_asset'))
    if (!asset || !isFleetAsset(asset)) return
    current.setValue('x_daas_ham_replacement_tier', str(asset, 'x_daas_ham_agreement.replacement_tier'))
    if (!str(current, 'account')) current.setValue('account', str(asset, 'company'))
}

/**
 * UI action "Raise replacement" on a case: an Order replacing the failed Asset like-for-like. One that cannot be
 * submitted as raised stays a draft, still linked to the case so a second one is not raised, for the user to correct.
 * The action is offered while the case links no Order or one rejected or cancelled, but a form opened before then can
 * still send it: then a linked draft is submitted again and a linked Order going ahead is kept (domain/breakfix).
 */
export function uiRaiseReplacement(current: GlideRecord): void {
    // A refused form save (the platform says why) raises nothing: the failed asset and linked Order would be values the
    // case does not hold.
    if (!current.update()) return
    const linked = findById('x_daas_ham_order', str(current, 'x_daas_ham_replacement_order'))
    const step = replacementStep(linked ? (str(linked, 'stage') as OrderStage) : null)
    if (linked && step === 'submit_draft') return submitReplacement(linked)
    if (linked && step === 'keep') {
        gs.addInfoMessage(`Replacement order ${str(linked, 'number')} is already raised (${linked.getDisplayValue('stage')})`)
        return
    }
    const failed = findById('alm_hardware', str(current, 'x_daas_ham_failed_asset'))
    if (!failed) return void gs.addErrorMessage('Set the failed asset on the case first')
    const problem = replacementProblem({ fleet: isFleetAsset(failed), stage: readStage(failed) })
    if (problem) return void gs.addErrorMessage(problem)
    const raised = createOrder(
        {
            orderType: 'device_replace',
            customerId: str(failed, 'company'),
            siteId: str(failed, 'x_daas_ham_site'),
            agreementId: str(failed, 'x_daas_ham_agreement'),
            installMode: 'fsm_engineer',
            caseId: current.getUniqueValue(),
            shortDescription: `Replace ${str(failed, 'asset_tag') || str(failed, 'serial_number')} (${str(current, 'number')})`,
        },
        [{ modelId: str(failed, 'model'), quantity: 1, replacesAssetId: failed.getUniqueValue() }],
    )
    if (!raised.created && raised.step === 'order') return void gs.addErrorMessage(`Replacement order not raised: ${raised.reason}`)
    if (!raised.created) {
        // Without its line the Order replaces nothing: it was removed again, so the case can raise one afresh.
        const why = raised.refused.map(({ reason }) => reason).join('; ')
        const kept = raised.kept ? `; ${raised.number} is left without it, cancel it` : ''
        return void gs.addErrorMessage(`Replacement order not raised, its line was not saved: ${why}${kept}`)
    }
    const order = raised.order

    current.setValue('x_daas_ham_replacement_order', order.getUniqueValue())
    // Unlinked, the case would offer Raise replacement again, so the Order stays a draft (it names the case).
    if (!current.update()) {
        const draft = `Replacement order ${str(order, 'number')} is a draft not linked to the case`
        return void gs.addErrorMessage(`${draft}: ${refusal(current)}. Link it and submit it`)
    }
    submitReplacement(order)
}

function submitReplacement(order: GlideRecord): void {
    const submission = submitOrder(order)
    if (submission.submitted) return void gs.addInfoMessage(`Replacement order ${str(order, 'number')} raised`)
    gs.addErrorMessage(submission.message)
    gs.addInfoMessage(`Replacement order ${str(order, 'number')} is left as a draft: correct it and submit it`)
}

/** UI action on an OEM RMA: the defective unit went back to the manufacturer (platform/oem-rma `returnDefectiveToOem`). */
export function uiDefectiveReturnedToOem(current: GlideRecord): void {
    const problem = returnDefectiveToOem(current)
    if (problem) gs.addErrorMessage(problem)
}
