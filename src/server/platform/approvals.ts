import { GlideRecord, gs } from '@servicenow/glide'
import { groupDecisions, rollupApprovals, type ApprovalState } from '../domain/approvals'
import type { Approver } from '../domain/entitlement'
import { ROLE } from '../domain/visibility'
import { pluck, str } from './records'

/** sysapproval_approver records for app tasks (ADR 0004). */

export function customerAdminIds(customerId: string): string[] {
    if (!customerId) return []
    return pluck(
        'sys_user_has_role',
        `role.name=${ROLE.customerAdmin}^user.company=${customerId}^user.active=true^state=active`,
        'user',
    )
}

/** Provider-side approvers: the account manager, or the asset managers when there is none. */
export function providerApproverIds(accountManagerId: string): string[] {
    if (accountManagerId) return [accountManagerId]
    return pluck('sys_user_has_role', `role.name=${ROLE.assetManager}^user.active=true^state=active`, 'user', 20)
}

/**
 * Ask `approverIds` to decide `task`; why it cannot wait for their decision ('' when it can): a refusal from the
 * platform, else `noApprover`. It can wait only if the requests saved could approve it, one for each `required` group
 * as the rollup groups them. Otherwise it could never be approved, so they are cancelled again and the callers keep it
 * out of awaiting approval.
 */
export function requestApprovals(
    task: GlideRecord,
    approverIds: readonly string[],
    required: readonly Approver[],
    customerAdmins: readonly string[],
    noApprover: string,
): string {
    const refusals = approverIds.map((approverId) => requestApproval(task, approverId))
    const saved = approverIds.filter((_, i) => !refusals[i])
    const allApproved = saved.map((approverId) => ({ approverId, state: 'approved' as const }))
    if (rollupApprovals(required, groupDecisions(allApproved, customerAdmins)) === 'approved') return ''
    if (saved.length > 0) cancelPendingApprovals(task.getUniqueValue())
    const refused = refusals.find(Boolean)
    return refused ? `an approval request was refused: ${refused}` : noApprover
}

/** Why the platform refused the request ('' once saved), also logged. */
function requestApproval(task: GlideRecord, approverId: string): string {
    const approval = new GlideRecord('sysapproval_approver')
    approval.initialize()
    approval.setValue('sysapproval', task.getUniqueValue())
    approval.setValue('source_table', task.getTableName())
    approval.setValue('document_id', task.getUniqueValue())
    approval.setValue('approver', approverId)
    approval.setValue('state', 'requested')
    if (approval.insert()) return ''
    const reason = approval.getLastErrorMessage() || 'insert refused'
    gs.warn(`[x_daas_ham] No approval request for ${str(task, 'number')} to ${approverId}: ${reason}`)
    return reason
}

export function approvalsOf(taskId: string): Array<{ approverId: string; state: ApprovalState }> {
    const approval = new GlideRecord('sysapproval_approver')
    approval.addQuery('sysapproval', taskId)
    approval.query()
    const approvals: Array<{ approverId: string; state: ApprovalState }> = []
    while (approval.next()) approvals.push({ approverId: str(approval, 'approver'), state: str(approval, 'state') as ApprovalState })
    return approvals
}

/**
 * Cancel approvals still waiting once the outcome is decided. Each cancellation is a saved state change, so the
 * after-update rule that rolls approvals up runs again: save the task out of awaiting approval first.
 */
export function cancelPendingApprovals(taskId: string): void {
    const approval = new GlideRecord('sysapproval_approver')
    approval.addQuery('sysapproval', taskId)
    approval.addQuery('state', 'requested')
    approval.query()
    while (approval.next()) {
        approval.setValue('state', 'cancelled')
        approval.update()
    }
}
