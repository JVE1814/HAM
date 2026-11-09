// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.
import { GlideRecord, gs } from '@servicenow/glide'
import { replacementStep } from '../domain/breakfix.ts'
import { isFleetAsset, moveAsset, readStage } from '../platform/assets.ts'
import { findById, refusal, str } from '../platform/records.ts'
import { submitOrder } from './orders.ts'

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
    const step = replacementStep(linked ? str(linked, 'stage') : null)
    if (linked && step === 'submit_draft') return submitReplacement(linked)
    if (linked && step === 'keep') {
        gs.addInfoMessage(`Replacement order ${str(linked, 'number')} is already raised (${linked.getDisplayValue('stage')})`)
        return
    }
    const failed = findById('alm_hardware', str(current, 'x_daas_ham_failed_asset'))
    if (!failed) {
        gs.addErrorMessage('Set the failed asset on the case first')
        return
    }
    if (!isFleetAsset(failed)) {
        gs.addErrorMessage('Only a fleet asset is replaced: the failed asset is not one')
        return
    }
    if (!['in_service', 'temporary_deployment', 'pending_in_service'].includes(readStage(failed) ?? '')) {
        gs.addErrorMessage('Only installed assets can be replaced')
        return
    }
    const order = new GlideRecord('x_daas_ham_order')
    order.initialize()
    order.setValue('order_type', 'device_replace')
    order.setValue('customer', str(failed, 'company'))
    order.setValue('site', str(failed, 'x_daas_ham_site'))
    order.setValue('agreement', str(failed, 'x_daas_ham_agreement'))
    order.setValue('install_mode', 'fsm_engineer')
    order.setValue('case', current.getUniqueValue())
    order.setValue('short_description', `Replace ${str(failed, 'asset_tag') || str(failed, 'serial_number')} (${str(current, 'number')})`)
    if (!order.insert()) return void gs.addErrorMessage(`Replacement order not raised: ${refusal(order)}`)

    const line = new GlideRecord('x_daas_ham_order_line')
    line.initialize()
    line.setValue('order', order.getUniqueValue())
    line.setValue('model', str(failed, 'model'))
    line.setValue('quantity', 1)
    line.setValue('replaces_asset', failed.getUniqueValue())
    if (!line.insert()) {
        // Without its line the Order replaces nothing: it is removed again, so the case can raise one afresh.
        const kept = order.deleteRecord() ? '' : `; ${str(order, 'number')} is left without it, cancel it`
        return void gs.addErrorMessage(`Replacement order not raised, its line was not saved: ${refusal(line)}${kept}`)
    }

    current.setValue('x_daas_ham_replacement_order', order.getUniqueValue())
    // Unlinked, the case would offer Raise replacement again, so the Order stays a draft (it names the case).
    if (!current.update()) {
        const draft = `Replacement order ${str(order, 'number')} is a draft not linked to the case`
        return void gs.addErrorMessage(`${draft}: ${refusal(current)}. Link it and submit it`)
    }
    submitReplacement(order)
}

function submitReplacement(order: GlideRecord): void {
    if (submitOrder(order)) gs.addInfoMessage(`Replacement order ${str(order, 'number')} raised`)
    else gs.addInfoMessage(`Replacement order ${str(order, 'number')} is left as a draft: correct it and submit it`)
}

/** UI action on an OEM RMA: the defective unit went back to the manufacturer (a fleet asset only, ADR 0016). */
export function uiDefectiveReturnedToOem(current: GlideRecord): void {
    const asset = findById('alm_hardware', str(current, 'defective_asset'))
    if (!asset) return
    if (!isFleetAsset(asset)) return void gs.addErrorMessage('The defective asset is not a fleet asset: it is not retired here')
    const verdict = moveAsset(asset, 'returned_to_oem')
    if (!verdict.allowed) {
        gs.addErrorMessage(verdict.reason)
        return
    }
    // The RMA records the return only once the unit is retired.
    if (!asset.update()) return void gs.addErrorMessage(`${str(asset, 'serial_number')} not retired: ${refusal(asset)}`)
    current.setValue('state', 'defective_returned')
    // The unit is retired already: the user is told so and why the RMA was not marked, rather than it silently staying
    // open. The action is still offered, and pressed again it finds the unit retired (no move) and marks the RMA.
    if (!current.update()) {
        const reason = refusal(current)
        const serial = str(asset, 'serial_number')
        gs.addErrorMessage(`${serial} is retired, but the RMA was not marked returned: ${reason}. Press again once that is fixed`)
    }
}
