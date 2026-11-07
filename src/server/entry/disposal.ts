// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.
import { GlideRecord, gs } from '@servicenow/glide'
import { groupDecisions, rollupApprovals } from '../domain/approvals'
import { disposalApprovers, disposalLineBlockers, disposalStage, type DisposalMethod } from '../domain/disposal'
import type { LegalOwner } from '../domain/lifecycle'
import { approvalsOf, cancelPendingApprovals, customerAdminIds, providerApproverIds, requestApproval } from '../platform/approvals'
import { moveAsset, readStage, transitionFacts } from '../platform/assets'
import { findById, str } from '../platform/records'

/** Disposal orders: approve, then retire each wiped Asset by its method (P2.5, D61). */

function lines(orderId: string): GlideRecord {
    const line = new GlideRecord('x_daas_ham_disposal_line')
    line.addQuery('disposal_order', orderId)
    line.query()
    return line
}

function ownersOf(orderId: string): LegalOwner[] {
    const owners: LegalOwner[] = []
    const line = lines(orderId)
    while (line.next()) owners.push(str(line, 'asset.x_daas_ham_legal_owner') as LegalOwner)
    return owners
}

/** UI action "Submit for approval" on a draft disposal order. */
export function uiSubmitDisposal(current: GlideRecord): void {
    current.update()
    const owners = ownersOf(current.getUniqueValue())
    if (owners.length === 0) {
        gs.addErrorMessage('Add the assets to dispose of first')
        return
    }
    if (owners.includes('customer') && !str(current, 'customer')) {
        gs.addErrorMessage('Set the customer whose assets are being returned')
        return
    }
    const approvers = new Set<string>()
    for (const group of disposalApprovers(owners)) {
        const ids = group === 'customer_admin' ? customerAdminIds(str(current, 'customer')) : providerApproverIds('')
        for (const id of ids) approvers.add(id)
    }
    for (const id of approvers) requestApproval(current, id)
    current.setValue('stage', 'awaiting_approval')
    current.setValue('approval', 'requested')
    current.update()
}

/** After-update rule on sysapproval_approver for disposal orders. */
export function onDisposalApprovalDecision(current: GlideRecord): void {
    const order = findById('x_daas_ham_disposal_order', str(current, 'document_id'))
    if (!order || str(order, 'stage') !== 'awaiting_approval') return
    const decisions = groupDecisions(approvalsOf(order.getUniqueValue()), customerAdminIds(str(order, 'customer')))
    const outcome = rollupApprovals(disposalApprovers(ownersOf(order.getUniqueValue())), decisions)
    if (outcome === 'requested') return
    cancelPendingApprovals(order.getUniqueValue())
    order.setValue('approval', outcome)
    order.setValue('stage', outcome === 'approved' ? 'approved' : 'rejected')
    if (outcome === 'rejected') order.setValue('state', 4)
    order.update()
}

/** UI action "Complete disposal": retire every ready line; report what blocks the rest. */
export function uiCompleteDisposal(current: GlideRecord): void {
    current.update()
    let blocked = 0
    const line = lines(current.getUniqueValue())
    while (line.next()) {
        if (str(line, 'status') === 'done') continue
        const asset = findById('alm_hardware', str(line, 'asset'))
        if (!asset) continue
        const method = (str(line, 'method') || str(current, 'method')) as DisposalMethod
        const facts = transitionFacts(asset)
        const blockers = disposalLineBlockers({ legalOwner: facts.legalOwner, method, wipeComplete: facts.wipeEvidenceComplete, stage: readStage(asset) })
        if (blockers.length === 0 && readStage(asset) === 'pending_wipe') moveAsset(asset, 'pending_disposal')
        const verdict = blockers.length === 0 ? moveAsset(asset, disposalStage(method)) : { allowed: false as const, reason: blockers.join('; ') }
        if (verdict.allowed) {
            asset.update()
            line.setValue('status', 'done')
            line.setValue('blockers', '')
        } else {
            blocked++
            line.setValue('status', 'blocked')
            line.setValue('blockers', verdict.reason)
        }
        line.update()
    }
    if (blocked > 0) {
        gs.addErrorMessage(`${blocked} line(s) are blocked; see "Blocked by" on the lines`)
        return
    }
    current.setValue('stage', 'completed')
    current.setValue('state', 3)
    current.update()
}
