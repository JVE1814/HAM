// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.
import { GlideRecord, gs } from '@servicenow/glide'
import { toIsoDate } from '../domain/calendar'
import type { LegalOwner } from '../domain/lifecycle'
import { evaluationTarget, overdueStep, returnRequestFindings, type EvaluationOutcome, type RequestedReturn, type ReturnRequester } from '../domain/returns'
import { clearRackPlacement, moveAndSave, moveAsset, readStage } from '../platform/assets'
import { customerAdminIds } from '../platform/approvals'
import { runTableJob } from '../platform/chunked'
import { EVENT } from '../platform/events'
import { nowMs, todayIso } from '../platform/clock'
import { intProperty, PROPERTY, stringProperty } from '../platform/properties'
import { bool, findById, str } from '../platform/records'
import { currentSession } from '../platform/session'
import {
    closeReturnIfDone,
    completeReturn,
    expectedReturnLine,
    installedAssetIds,
    raiseReturn,
    recordFee,
    stampNow,
    type ReturnTrigger,
    waiveOpenFees,
} from '../platform/returns'

/** Returns, decommissions, depot evaluation and overdue chasing (P2.4). */

/**
 * Record producer "Return or decommission equipment". A site decommission returns everything
 * installed at the Site; a device removal returns the chosen Assets. The producer does not apply the
 * Return create rule and its Customer and Site are only qualified in the browser, so a Return its
 * requester may not raise, or for a Site that is not its Customer's, is removed again
 * (domain/returns `returnRequestFindings`).
 */
export function afterReturnProduced(producer: Record<string, unknown>, current: unknown): void {
    const order = current as GlideRecord
    const findings = returnRequestFindings(requestedReturn(order), returnRequester(order))
    if (findings.length > 0) {
        gs.addErrorMessage(`Return not raised. ${findings.join('. ')}.`)
        order.deleteRecord()
        return
    }
    const decommission = str(order, 'trigger') === 'site_decommission'
    const siteId = str(order, 'site')
    // Only devices actually at the chosen Site: the list collector cannot be qualified by the Site.
    const chosen = String(producer.assets ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter((id) => {
            const asset = id ? findById('alm_hardware', id) : null
            return !!asset && str(asset, 'x_daas_ham_site') === siteId
        })
    const assetIds = decommission ? installedAssetIds({ siteId }) : chosen
    completeReturn(order, {
        trigger: str(order, 'trigger') as ReturnTrigger,
        customerId: str(order, 'customer'),
        siteId,
        agreementId: str(order, 'agreement') || agreementOf(assetIds[0]),
        method: (str(order, 'method') || 'ship_back') as 'fsm_deinstall' | 'ship_back',
        assetIds,
        openFieldWork: true,
        description: str(order, 'short_description') || `Return from ${order.getDisplayValue('site')}`,
    })
}

/** The Customer the produced Return is for and its Site, with the Customer the Site belongs to. */
function requestedReturn(order: GlideRecord): RequestedReturn {
    const customerId = str(order, 'customer')
    const siteId = str(order, 'site')
    if (!siteId) return { customerId }
    const site = findById('cmn_location', siteId)
    return { customerId, site: { id: siteId, customerId: site ? str(site, 'company') : null, isSite: !!site && bool(site, 'x_daas_ham_is_site') } }
}

/** The signed-in user as the requester of `order`: a Return requester when the Return create rule lets them create it. */
function returnRequester(order: GlideRecord): ReturnRequester {
    const { scope, customerId } = currentSession()
    return { mayRequest: order.canCreate(), scope, customerId }
}

function agreementOf(assetId: string | undefined): string {
    const asset = assetId ? findById('alm_hardware', assetId) : null
    return asset ? str(asset, 'x_daas_ham_agreement') : ''
}

/**
 * A returned Asset arrived at the depot: it awaits evaluation, its subscription line no longer
 * includes it, and a late return is charged.
 */
export function receiveReturnedAsset(asset: GlideRecord, stockroomId: string): boolean {
    if (readStage(asset) !== 'pending_return' && readStage(asset) !== 'missing') return false
    const line = expectedReturnLine(asset.getUniqueValue())
    const subscriptionLine = str(asset, 'x_daas_ham_subscription_line')
    asset.setValue('stockroom', stockroomId)
    asset.setValue('x_daas_ham_site', '')
    asset.setValue('x_daas_ham_subscription_line', '')
    clearRackPlacement(asset)
    if (!moveAndSave(asset, 'pending_evaluation', 'return received')) return false
    endLineIfEmpty(subscriptionLine)
    if (!line) return true
    const turnedUp = str(line, 'status') === 'missing'
    line.setValue('status', 'received')
    stampNow(line, 'received_at')
    line.update()
    const returnOrder = findById('x_daas_ham_return_order', str(line, 'return_order'))
    if (!returnOrder) return true
    if (turnedUp) {
        // Declared missing, then found: it is late, not lost, and its line needs evaluating again.
        waiveOpenFees('lost', asset.getUniqueValue(), returnOrder.getUniqueValue())
        returnOrder.setValue('state', 2)
        returnOrder.update()
    }
    if (str(returnOrder, 'due_date') && todayIso() > str(returnOrder, 'due_date')) {
        recordFee('late_return', asset, returnOrder.getUniqueValue())
    }
    return true
}

/**
 * A site package whose last Asset came back ends on the day of receipt. Its remaining Assets are counted past the
 * before-query visibility rules (ADR 0005): the receiving tech sees only Assets in their stockrooms, so the units
 * still at the Site would be missed and the line would end on the first unit back.
 */
function endLineIfEmpty(lineId: string): void {
    if (!lineId) return
    const remaining = new GlideRecord('alm_hardware')
    // Only counted, never updated, so the rules need not be turned back on.
    remaining.setWorkflow(false)
    remaining.addQuery('x_daas_ham_subscription_line', lineId)
    remaining.setLimit(1)
    remaining.query()
    if (remaining.hasNext()) return
    const line = findById('x_daas_ham_subscription_line', lineId)
    if (!line || str(line, 'line_type') !== 'site_package' || str(line, 'status') === 'ended') return
    line.setValue('status', 'ended')
    line.setValue('end_date', toIsoDate(nowMs()))
    line.update()
}

/** After-update rule on return lines whose evaluation was set: route the Asset onward. */
export function onReturnEvaluated(current: GlideRecord): void {
    const asset = findById('alm_hardware', str(current, 'asset'))
    if (!asset || readStage(asset) !== 'pending_evaluation') {
        gs.addErrorMessage('Evaluate the asset after it has been received at the depot')
        return
    }
    const target = evaluationTarget(str(current, 'evaluation') as EvaluationOutcome, str(asset, 'x_daas_ham_legal_owner') as LegalOwner)
    if (str(current, 'condition') === 'damaged') recordFee('damaged', asset, str(current, 'return_order'))
    if (target === 'available') {
        asset.setValue('company', stringProperty(PROPERTY.providerCompany))
        asset.setValue('x_daas_ham_agreement', '')
        asset.setValue('x_daas_ham_order_line', '')
    }
    if (!moveAsset(asset, target).allowed) {
        gs.addErrorMessage(`The asset cannot go to ${target} from its current stage`)
        return
    }
    asset.update()
    current.setValue('status', 'evaluated')
    current.update()
    closeReturnIfDone(str(current, 'return_order'))
}

/** Daily: escalate overdue returns once, then declare the Assets missing and charge the lost-asset fee. */
export function chaseOverdueReturns(): void {
    const today = todayIso()
    const grace = intProperty(PROPERTY.returnGraceDays, 14)
    runTableJob({
        job: 'chase_overdue_returns',
        table: 'x_daas_ham_return_order_line',
        query: `status=awaiting^return_order.due_date<${today}`,
        read: (line) => ({
            assetId: str(line, 'asset'),
            returnOrderId: str(line, 'return_order'),
            dueDate: str(line, 'return_order.due_date'),
        }),
        handle: (line, lineId) => {
            // Read the header fresh: an earlier line of the same order may have escalated it in this batch.
            const returnOrder = findById('x_daas_ham_return_order', line.returnOrderId)
            if (!returnOrder) return
            const step = overdueStep({ dueDate: line.dueDate, today, graceDays: grace, received: false, escalated: bool(returnOrder, 'escalated') })
            if (step === 'escalate') {
                returnOrder.setValue('escalated', true)
                returnOrder.setValue('work_notes', `Return overdue since ${line.dueDate}; customer and account manager notified.`)
                returnOrder.update()
                const recipients = [...customerAdminIds(str(returnOrder, 'customer')), str(returnOrder, 'agreement.account_manager')]
                gs.eventQueue(EVENT.returnOverdue, returnOrder, recipients.filter(Boolean).join(','), line.assetId)
            } else if (step === 'declare_missing') {
                const asset = findById('alm_hardware', line.assetId)
                if (asset) clearRackPlacement(asset)
                if (asset && moveAndSave(asset, 'missing', `return ${returnOrder.getDisplayValue('number')} overdue`)) {
                    recordFee('lost', asset, line.returnOrderId)
                }
                const record = findById('x_daas_ham_return_order_line', lineId)
                record?.setValue('status', 'missing')
                record?.update()
                closeReturnIfDone(line.returnOrderId)
            }
        },
    })
}

/** Daily: agreements past their end date and temporary deployments ending soon bring their equipment back. */
export function raiseScheduledReturns(): void {
    const today = todayIso()
    const agreement = new GlideRecord('x_daas_ham_agreement')
    agreement.addQuery('ends', '<', today)
    agreement.addQuery('end_return_raised', false)
    agreement.addNotNullQuery('ends')
    agreement.setLimit(50)
    agreement.query()
    while (agreement.next()) {
        const assets = installedAssetIds({ agreementId: agreement.getUniqueValue() })
        if (assets.length > 0) {
            raiseReturn({
                trigger: 'agreement_end',
                customerId: str(agreement, 'customer'),
                siteId: '',
                agreementId: agreement.getUniqueValue(),
                method: 'fsm_deinstall',
                assetIds: assets,
                openFieldWork: false,
                description: `Agreement ${str(agreement, 'number')} ended ${str(agreement, 'ends')}: recover all equipment`,
            })
        }
        agreement.setValue('end_return_raised', true)
        agreement.update()
    }

    const leadDays = intProperty(PROPERTY.temporaryReturnLeadDays, 7)
    const horizon = toIsoDate(nowMs() + leadDays * 86_400_000)
    const order = new GlideRecord('x_daas_ham_order')
    order.addQuery('order_type', 'temporary')
    order.addQuery('return_raised', false)
    order.addNotNullQuery('end_date')
    order.addQuery('end_date', '<=', horizon)
    order.addQuery('stage', 'IN', 'installing,complete')
    order.orderBy('end_date')
    order.setLimit(50)
    order.query()
    while (order.next()) {
        const assetIds = installedAssetIds({ orderId: order.getUniqueValue() })
        // Still being installed and not yet ended: wait for the equipment to arrive before raising.
        if (assetIds.length === 0 && str(order, 'stage') === 'installing' && str(order, 'end_date') >= today) continue
        if (assetIds.length > 0) {
            raiseReturn({
                trigger: 'temporary_end',
                customerId: str(order, 'customer'),
                siteId: str(order, 'site'),
                agreementId: str(order, 'agreement'),
                method: str(order, 'install_mode') === 'self_install' ? 'ship_back' : 'fsm_deinstall',
                assetIds,
                sourceOrderId: order.getUniqueValue(),
                openFieldWork: true,
                description: `Temporary deployment ${str(order, 'number')} ends ${str(order, 'end_date')}`,
            })
        }
        order.setValue('return_raised', true)
        order.update()
    }
}

/** UI action "Raise return" on the defective asset of a swap: used by completeInstall for replaced Assets. */
export function returnReplacedAssets(order: GlideRecord, assetIds: readonly string[]): void {
    if (assetIds.length === 0) return
    const refresh = str(order, 'order_type') === 'refresh'
    raiseReturn({
        trigger: refresh ? 'refresh_swap_back' : 'defective_return',
        customerId: str(order, 'customer'),
        siteId: str(order, 'site'),
        agreementId: str(order, 'agreement'),
        method: str(order, 'install_mode') === 'self_install' ? 'ship_back' : 'fsm_deinstall',
        assetIds,
        sourceOrderId: order.getUniqueValue(),
        // The swap work order already collects the old unit.
        openFieldWork: false,
        description: `${refresh ? 'Refresh swap-back' : 'Defective unit'} from ${str(order, 'number')}`,
    })
}
