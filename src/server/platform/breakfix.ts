import { gs, type GlideRecord } from '@servicenow/glide'
import { replacementProblem, replacementStep } from '../domain/breakfix.ts'
import { ORDER_STAGE, type OrderStage } from '../domain/vocabulary.ts'
import { isFleetAsset, readStage } from './assets.ts'
import { createOrder, submitOrder } from './orders.ts'
import { bool, findById, refusal, str, warnRefused } from './records.ts'

/**
 * Break-fix replacements (P2.3, D58): the device-replace Order a CSM case raises for its failed Asset. It tells the
 * user nothing: it gives what came of it, for the form button that asked to report (entry/breakfix).
 */

/**
 * What came of "Raise replacement" on a case:
 * - `raised`: the replacement Order went ahead, to approval or sourcing (`already` says so, for the user, when another
 *   submission of it had taken it ahead: platform/orders `Submission`);
 * - `already_raised`: the Order the case links is going ahead, in the stage `stageLabel` names, and is kept;
 * - `draft`: the Order could not be submitted (`why`) and is left a draft, linked to the case, to correct and submit;
 * - `not_raised`: nothing was raised or submitted, and why.
 */
export type Replacement =
    | { outcome: 'raised'; number: string; already?: string }
    | { outcome: 'already_raised'; number: string; stageLabel: string }
    | { outcome: 'draft'; number: string; why: string }
    | { outcome: 'not_raised'; why: string }

function notRaised(why: string): Replacement {
    return { outcome: 'not_raised', why }
}

/**
 * Raise an Order replacing the case's failed Asset like-for-like, link it to the case (saves the case) and submit it.
 * One that cannot be submitted as raised stays a draft, still linked to the case so a second one is not raised, for
 * the user to correct. "Raise replacement" is offered while the case links no Order or one rejected or cancelled, but
 * a form opened before then can still send it: then a linked draft is submitted again and a linked Order going ahead
 * is kept (domain/breakfix).
 */
export function raiseReplacement(kase: GlideRecord): Replacement {
    const linked = findById('x_daas_ham_order', str(kase, 'x_daas_ham_replacement_order'))
    const step = replacementStep(linked ? (str(linked, 'stage') as OrderStage) : null)
    if (linked && step === 'submit_draft') return submitReplacement(linked)
    if (linked && step === 'keep') {
        return { outcome: 'already_raised', number: str(linked, 'number'), stageLabel: linked.getDisplayValue('stage') }
    }
    const failed = findById('alm_hardware', str(kase, 'x_daas_ham_failed_asset'))
    if (!failed) return notRaised('Set the failed asset on the case first')
    const problem = replacementProblem({ fleet: isFleetAsset(failed), stage: readStage(failed) })
    if (problem) return notRaised(problem)
    const raised = createOrder(
        {
            orderType: 'device_replace',
            customerId: str(failed, 'company'),
            siteId: str(failed, 'x_daas_ham_site'),
            agreementId: str(failed, 'x_daas_ham_agreement'),
            installMode: 'fsm_engineer',
            caseId: kase.getUniqueValue(),
            shortDescription: `Replace ${str(failed, 'asset_tag') || str(failed, 'serial_number')} (${str(kase, 'number')})`,
        },
        [{ modelId: str(failed, 'model'), quantity: 1, replacesAssetId: failed.getUniqueValue() }],
    )
    if (!raised.created && raised.step === 'order') return notRaised(`Replacement order not raised: ${raised.reason}`)
    if (!raised.created) {
        // Without its line the Order replaces nothing: it was removed again, so the case can raise one afresh.
        const why = raised.refused.map(({ reason }) => reason).join('; ')
        const kept = raised.kept ? `; ${raised.number} is left without it, cancel it` : ''
        return notRaised(`Replacement order not raised, its line was not saved: ${why}${kept}`)
    }
    const order = raised.order

    kase.setValue('x_daas_ham_replacement_order', order.getUniqueValue())
    // Unlinked, the case would offer Raise replacement again, so the Order stays a draft (it names the case).
    if (!kase.update()) {
        const draft = `Replacement order ${str(order, 'number')} is a draft not linked to the case`
        return notRaised(`${draft}: ${refusal(kase)}. Link it and submit it`)
    }
    return submitReplacement(order)
}

function submitReplacement(order: GlideRecord): Replacement {
    const submission = submitOrder(order)
    const number = str(order, 'number')
    if (!submission.submitted) return { outcome: 'draft', number, why: submission.message }
    return { outcome: 'raised', number, already: submission.already }
}

/**
 * A replacement Order completed: its case is saved with a work note. The replacement SLAs on the case stop once the Order
 * it links is complete (break-fix/break-fix.now.ts), but the SLA engine weighs a case's SLAs only when the case is saved,
 * and completing the Order does not save it. Only an open case that still links this Order, now complete, is saved. A
 * case not found, or a refused save, leaves the SLA running, to breach: that is logged, to save the case by hand.
 *
 * Run from the event queue (platform/events `EVENT.replacementComplete`, fired by platform/fulfilment
 * `recomputeOrder`), never in the save that completes the Order: that save is often made in a user's interactive session
 * (an asset manager moving the unit to in service on the form, a customer contact confirming the install), where
 * Customer Service's before-query rule 'Case query rules' narrows every read of a case to the CSM query rules of a user
 * without case_admin: one whose rules do not grant them the case would not find it. A script action runs as system
 * outside any interactive session, where that rule does not apply (it requires gs.isInteractive()).
 */
export function noteReplacementComplete(orderId: string): void {
    const order = findById('x_daas_ham_order', orderId, { beyondVisibility: true })
    if (!order || str(order, 'stage') !== ORDER_STAGE.complete) return
    const caseId = str(order, 'case')
    if (!caseId) return
    const kase = findById('sn_customerservice_case', caseId)
    if (!kase) return void gs.warn(`[x_daas_ham] ${str(order, 'number')} complete, but its case ${caseId} was not found: save the case to stop its SLA`)
    if (!bool(kase, 'active') || str(kase, 'x_daas_ham_replacement_order') !== order.getUniqueValue()) return
    kase.setValue('work_notes', `Replacement order ${str(order, 'number')} is complete: the replacement is installed.`)
    if (!kase.update()) warnRefused(kase, `${str(kase, 'number')}: replacement SLA not stopped, the case save was refused; save the case`)
}
