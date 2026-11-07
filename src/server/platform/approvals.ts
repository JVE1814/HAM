import { GlideRecord } from '@servicenow/glide'
import type { ApprovalState } from '../domain/approvals'
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

export function requestApproval(task: GlideRecord, approverId: string): void {
    const approval = new GlideRecord('sysapproval_approver')
    approval.initialize()
    approval.setValue('sysapproval', task.getUniqueValue())
    approval.setValue('source_table', task.getTableName())
    approval.setValue('document_id', task.getUniqueValue())
    approval.setValue('approver', approverId)
    approval.setValue('state', 'requested')
    approval.insert()
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
