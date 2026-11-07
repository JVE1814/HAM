// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.
import { GlideRecord, gs } from '@servicenow/glide'
import { moveAsset, readStage } from '../platform/assets'
import { findById, str } from '../platform/records'
import { submitOrder } from './orders'

/** Break-fix: a CSM case about a failed Asset drives a device-replace Order (P2.3, D58). */

/** Before insert/update rule on cases naming a failed Asset: take the customer and service level from it. */
export function onCaseFailedAsset(current: GlideRecord): void {
    const asset = findById('alm_hardware', str(current, 'x_daas_ham_failed_asset'))
    if (!asset) return
    current.setValue('x_daas_ham_replacement_tier', str(asset, 'x_daas_ham_agreement.replacement_tier'))
    if (!str(current, 'account')) current.setValue('account', str(asset, 'company'))
}

/**
 * UI action "Raise replacement" on a case: an Order replacing the failed Asset like-for-like. One that cannot be
 * submitted as raised stays a draft, still linked to the case so a second one is not raised, for the user to correct.
 */
export function uiRaiseReplacement(current: GlideRecord): void {
    current.update()
    const failed = findById('alm_hardware', str(current, 'x_daas_ham_failed_asset'))
    if (!failed) {
        gs.addErrorMessage('Set the failed asset on the case first')
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
    order.insert()

    const line = new GlideRecord('x_daas_ham_order_line')
    line.initialize()
    line.setValue('order', order.getUniqueValue())
    line.setValue('model', str(failed, 'model'))
    line.setValue('quantity', 1)
    line.setValue('replaces_asset', failed.getUniqueValue())
    line.insert()

    current.setValue('x_daas_ham_replacement_order', order.getUniqueValue())
    current.update()
    if (submitOrder(order)) gs.addInfoMessage(`Replacement order ${str(order, 'number')} raised`)
    else gs.addInfoMessage(`Replacement order ${str(order, 'number')} is left as a draft: correct it and submit it`)
}

/** UI action on an OEM RMA: the defective unit went back to the manufacturer. */
export function uiDefectiveReturnedToOem(current: GlideRecord): void {
    const asset = findById('alm_hardware', str(current, 'defective_asset'))
    if (!asset) return
    const verdict = moveAsset(asset, 'returned_to_oem')
    if (!verdict.allowed) {
        gs.addErrorMessage(verdict.reason)
        return
    }
    asset.update()
    current.setValue('state', 'defective_returned')
    current.update()
}
