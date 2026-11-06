import { GlideRecord } from '@servicenow/glide'
import type { ApprovalDecision, ApprovalState } from '../domain/approvals'
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

/** Decisions on a task, tagged with the approver group (the account manager vs any Customer admin). */
export function approvalDecisions(taskId: string, accountManagerId: string): ApprovalDecision[] {
    const approval = new GlideRecord('sysapproval_approver')
    approval.addQuery('sysapproval', taskId)
    approval.query()
    const decisions: ApprovalDecision[] = []
    while (approval.next()) {
        decisions.push({
            group: str(approval, 'approver') === accountManagerId ? 'account_manager' : 'customer_admin',
            state: str(approval, 'state') as ApprovalState,
        })
    }
    return decisions
}

/** Cancel approvals still waiting once the outcome is decided. */
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
