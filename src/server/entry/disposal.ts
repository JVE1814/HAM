// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.
import { GlideRecord, gs } from '@servicenow/glide'
import { groupDecisions, rollupApprovals } from '../domain/approvals'
import {
    disposalApprovers,
    disposalCustomerFindings,
    disposalLineBlockers,
    disposalScopeRefusal,
    disposalStage,
    type DisposalAsset,
    type DisposalMethod,
} from '../domain/disposal'
import type { LegalOwner, Stage } from '../domain/lifecycle'
import { ROLE } from '../domain/visibility'
import {
    approvalsOf,
    cancelPendingApprovals,
    customerAdminIds,
    providerApproverIds,
    requestApprovals,
} from '../platform/approvals'
import { moveAsset, readStage, transitionFacts } from '../platform/assets'
import { findById, str } from '../platform/records'

/** Disposal orders: approve, then retire each wiped Asset by its method (P2.5, D61). */

/** Line fields that say what is retired and how; the rest (status, blockers, amounts) stays writable after submit. */
const LINE_SCOPE = ['disposal_order', 'asset', 'method']

function lines(orderId: string): GlideRecord {
    const line = new GlideRecord('x_daas_ham_disposal_line')
    line.addQuery('disposal_order', orderId)
    line.query()
    return line
}

function assetsOf(orderId: string): DisposalAsset[] {
    const assets: DisposalAsset[] = []
    const line = lines(orderId)
    while (line.next()) {
        assets.push({
            legalOwner: str(line, 'asset.x_daas_ham_legal_owner') as LegalOwner,
            customerId: str(line, 'asset.company'),
            label: str(line, 'asset.serial_number') || line.getDisplayValue('asset'),
        })
    }
    return assets
}

function ownersOf(orderId: string): LegalOwner[] {
    return assetsOf(orderId).map((asset) => asset.legalOwner)
}

/** UI action "Submit for approval" on a draft disposal order. */
export function uiSubmitDisposal(current: GlideRecord): void {
    // A refused form save (the platform says why) asks nobody: the order is not what the approvers would decide.
    if (!current.update()) return
    const assets = assetsOf(current.getUniqueValue())
    if (assets.length === 0) {
        gs.addErrorMessage('Add the assets to dispose of first')
        return
    }
    const findings = disposalCustomerFindings(str(current, 'customer'), assets)
    if (findings.length > 0) {
        gs.addErrorMessage(findings.join('. '))
        return
    }
    const required = disposalApprovers(assets.map((asset) => asset.legalOwner))
    const admins = customerAdminIds(str(current, 'customer'))
    const approvers = new Set<string>()
    for (const group of required) {
        for (const id of group === 'customer_admin' ? admins : providerApproverIds('')) approvers.add(id)
    }
    // Ask first: an order the requests saved could not approve would wait for ever, so it stays a draft.
    const refusal = requestApprovals(current, [...approvers], required, admins, 'no asset manager to approve it')
    if (refusal) {
        gs.addErrorMessage(`Not submitted: ${refusal}`)
        return
    }
    current.setValue('stage', 'awaiting_approval')
    current.setValue('approval', 'requested')
    // Still a draft (the platform says why): its requests could never decide it, so they are cancelled again.
    if (!current.update()) cancelPendingApprovals(current.getUniqueValue())
}

/** After-update rule on sysapproval_approver for disposal orders. */
export function onDisposalApprovalDecision(current: GlideRecord): void {
    const order = findById('x_daas_ham_disposal_order', str(current, 'document_id'))
    if (!order || str(order, 'stage') !== 'awaiting_approval') return
    const decisions = groupDecisions(approvalsOf(order.getUniqueValue()), customerAdminIds(str(order, 'customer')))
    const outcome = rollupApprovals(disposalApprovers(ownersOf(order.getUniqueValue())), decisions)
    if (outcome === 'requested') return
    order.setValue('approval', outcome)
    order.setValue('stage', outcome === 'approved' ? 'approved' : 'rejected')
    if (outcome === 'rejected') order.setValue('state', 4)
    // Refused: it still awaits approval with its requests open, so the next decision on them rolls it up again.
    if (!order.update()) {
        const reason = order.getLastErrorMessage() || 'the save was refused'
        return void gs.warn(`[x_daas_ham] Disposal ${str(order, 'number')} not saved as ${outcome}: ${reason}`)
    }
    // After the save, so the approval rule each cancellation runs finds the order no longer awaiting approval.
    cancelPendingApprovals(order.getUniqueValue())
}

/** UI action "Complete disposal": retire every ready line; report what blocks the rest. */
export function uiCompleteDisposal(current: GlideRecord): void {
    // A refused form save (a method or Customer changed after submit) leaves the refused values on `current`.
    if (!current.update()) return
    let blocked = 0
    let unsaved = 0
    const line = lines(current.getUniqueValue())
    while (line.next()) {
        if (str(line, 'status') === 'done') continue
        const refusal = retire(line, current)
        if (refusal) blocked++
        line.setValue('status', refusal ? 'blocked' : 'done')
        line.setValue('blockers', refusal)
        if (line.update()) continue
        // A line not saved as done keeps the order open: its Asset may be retired already, so it is set done by hand.
        unsaved++
        const reason = line.getLastErrorMessage() || 'the save was refused'
        const what = `${str(current, 'number')} line for ${line.getDisplayValue('asset')}`
        gs.warn(`[x_daas_ham] ${what} not saved (${refusal ? 'blocked' : 'done, its asset retired'}): ${reason}`)
    }
    if (blocked > 0) gs.addErrorMessage(`${blocked} line(s) are blocked; see "Blocked by" on the lines`)
    if (unsaved > 0) gs.addErrorMessage(`${unsaved} line(s) could not be saved (see the system log)`)
    if (blocked > 0 || unsaved > 0) return
    current.setValue('stage', 'completed')
    current.setValue('state', 3)
    current.update()
}

/**
 * Retire a line's Asset by its method; why it was not (empty when it was). An Asset the user cannot read (outside
 * their Stockrooms, ADR 0005) blocks its line rather than being skipped. The lifecycle rule checks each saved move,
 * so a pending-wipe Asset is saved as pending disposal first, and the line is done only once the retiring save holds.
 */
function retire(line: GlideRecord, order: GlideRecord): string {
    const asset = findById('alm_hardware', str(line, 'asset'))
    if (!asset) return 'asset not found, or not in your stockrooms'
    const method = (str(line, 'method') || str(order, 'method')) as DisposalMethod
    const facts = transitionFacts(asset)
    const stage = readStage(asset)
    const blockers = disposalLineBlockers({
        legalOwner: facts.legalOwner,
        method,
        wipeComplete: facts.wipeEvidenceComplete,
        stage,
        customerId: str(asset, 'company'),
        orderCustomerId: str(order, 'customer'),
    })
    if (blockers.length > 0) return blockers.join('; ')
    if (stage === 'pending_wipe') {
        const refusal = moveAndKeep(asset, 'pending_disposal')
        if (refusal) return refusal
    }
    return moveAndKeep(asset, disposalStage(method))
}

/** Move the Asset and save it; why that was refused (empty once saved). */
function moveAndKeep(asset: GlideRecord, to: Stage): string {
    const verdict = moveAsset(asset, to)
    if (!verdict.allowed) return verdict.reason
    return asset.update() ? '' : asset.getLastErrorMessage() || `the asset could not be saved as ${to}`
}

/**
 * Before insert/update/delete rule on disposal lines: once the order leaves draft no line is added, removed or
 * pointed at another order, Asset or method, so what is retired is what was approved. Removing a line retires
 * nothing, so administrators (the only role the ACLs let delete) still may: otherwise a line whose Asset can never
 * be retired keeps its order approved for good, and deleting an order could not take its lines with it.
 */
export function guardDisposalLine(current: GlideRecord, previous: GlideRecord): void {
    const operation = current.operation()
    if (operation === 'update' && LINE_SCOPE.every((field) => str(current, field) === str(previous, field))) return
    if (operation === 'delete' && gs.hasRole(ROLE.admin)) return
    const stages = [str(current, 'disposal_order.stage')]
    if (operation === 'update') stages.push(str(previous, 'disposal_order.stage'))
    refuseOnceSubmitted(current, stages)
}

/** Before-update rule on disposal orders whose method or Customer changes: both are fixed at submit, like the lines. */
export function guardDisposalOrder(current: GlideRecord, previous: GlideRecord): void {
    refuseOnceSubmitted(current, [str(previous, 'stage')])
}

function refuseOnceSubmitted(current: GlideRecord, orderStages: string[]): void {
    const refusal = disposalScopeRefusal(orderStages)
    if (!refusal) return
    gs.addErrorMessage(refusal)
    current.setAbortAction(true)
}
