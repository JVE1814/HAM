import { GlideRecord } from '@servicenow/glide'
import {
    APPROVAL,
    approversToAsk,
    groupDecisions,
    rollupApprovals,
    type ApprovalDecision,
    type ApprovalOutcome,
    type ApprovalState,
    type StandIn,
} from '../domain/approvals.ts'
import type { Approver } from '../domain/approvals.ts'
import { ROLE } from '../domain/roles.ts'
import { exists, pluck, str, warnRefused } from './records.ts'
import { assetManagerIds } from './users.ts'

/** Approval of app tasks through sysapproval_approver records (ADR 0004). */

/**
 * The Customer admins a task was put to approval with, saved on it then: its approvals are counted by these
 * (domain/approvals `groupDecisions`), not by who holds the role when they are decided. An admin onboarded meanwhile
 * was not asked, so the provider-side approvers asked in their place still stand in; an admin whose role was removed
 * meanwhile still decides only for the admins.
 */
const CUSTOMER_ADMINS_ASKED = 'approval_customer_admins'

export function customerAdminIds(customerId: string): string[] {
    if (!customerId) return []
    return pluck(
        'sys_user_has_role',
        `role.name=${ROLE.customerAdmin}^user.company=${customerId}^user.active=true^state=active`,
        'user',
    )
}

/**
 * Provider-side approvers: the account manager, or the asset managers when there is none. Only active users: a
 * request to an inactive one saves but is never decided, so an inactive account manager counts as none.
 */
export function providerApproverIds(accountManagerId: string): string[] {
    if (accountManagerId && isActiveUser(accountManagerId)) return [accountManagerId]
    return assetManagerIds()
}

/**
 * sys_user is a table of another scope, so its rules run (the platform refuses setWorkflow
 * from this scope) and the app has none there: the platform's *user query* rule hides inactive users from an
 * interactive user without admin or user_admin, and this query asks for an active one anyway, so a customer admin
 * raising an Order still finds an active account manager.
 */
function isActiveUser(userId: string): boolean {
    return exists('sys_user', `sys_id=${userId}^active=true`)
}

export interface ApprovalRequest {
    /** The groups that must each approve. */
    required: readonly Approver[]
    /** The Customer admins of the task's Customer, who decide for the customer-admin group (`CUSTOMER_ADMINS_ASKED`). */
    customerAdmins: readonly string[]
    /** Who decides for the Provider (its group, APPROVER.provider), and stands in for absent admins as the flow says. */
    providerApprovers: readonly string[]
    /** Why the task cannot be approved when nobody could be asked. */
    noApprover: string
}

/**
 * What came of putting a task to approval: it awaits its approvers' decisions, or it does not and no request is left
 * waiting, because the requests saved could not approve it (`request`) or the platform refused to save it as awaiting
 * approval (`save`, logged).
 */
export type ApprovalStart = { awaiting: true } | { awaiting: false; step: 'request' | 'save'; reason: string }

export function putToApproval(task: GlideRecord, flow: ApprovalFlow, request: ApprovalRequest): ApprovalStart {
    const unasked = requestApprovals(task, flow.standIn, request)
    if (unasked) return { awaiting: false, step: 'request', reason: unasked }
    task.setValue('stage', flow.awaitingStage)
    task.setValue('approval', APPROVAL.requested)
    task.setValue(CUSTOMER_ADMINS_ASKED, request.customerAdmins.join(','))
    if (task.update()) return { awaiting: true }
    const reason = warnRefused(task, `${str(task, 'number')} not saved as awaiting approval, its requests cancelled`)
    cancelPendingApprovals(task.getUniqueValue())
    return { awaiting: false, step: 'save', reason }
}

export interface ApprovalFlow {
    /** The value of the task's `stage` while it awaits approval, as its own stage list names it. */
    awaitingStage: string
    /** Who decides for the admins of a Customer that has none. */
    standIn: StandIn
    /** The groups that must each approve `task`: read only for a task found awaiting approval. */
    required(task: GlideRecord): readonly Approver[]
    /**
     * Save `task` as approved or rejected, with what follows from it (an approved Order is sourced, a rejected one
     * cancels its lines); why the platform refused the save ('' once saved).
     */
    decide(task: GlideRecord, outcome: Exclude<ApprovalOutcome, 'requested'>): string
}

/** What rolling a task's approvals up found: the outcome, and why the platform refused to save it ('' once saved). */
export interface ApprovalRollup {
    outcome: ApprovalOutcome
    refused: string
    required: readonly Approver[]
    decisions: ApprovalDecision[]
}

/**
 * Roll the approvals of a task awaiting approval up (null for any other task) and save the outcome as its `flow`
 * decides it. The after-update rule on sysapproval_approver runs this on each decision, and so does a re-check.
 * The requests still waiting are cancelled only once the outcome is saved. Each cancellation runs the rule again,
 * which stops there as the task no longer awaits approval. A refused save keeps it awaiting approval with its
 * requests, so the next decision (or a re-check) tries again.
 */
export function rollUpApprovals(task: GlideRecord, flow: ApprovalFlow): ApprovalRollup | null {
    if (str(task, 'stage') !== flow.awaitingStage) return null
    const required = flow.required(task)
    const asked = str(task, CUSTOMER_ADMINS_ASKED).split(',').filter(Boolean)
    const decisions = groupDecisions(approvalsOf(task.getUniqueValue()), asked, flow.standIn)
    const outcome = rollupApprovals(required, decisions)
    if (outcome === 'requested') return { outcome, refused: '', required, decisions }
    const refused = flow.decide(task, outcome)
    if (!refused) cancelPendingApprovals(task.getUniqueValue())
    return { outcome, refused, required, decisions }
}

function requestApprovals(task: GlideRecord, standIn: StandIn, { required, customerAdmins, providerApprovers, noApprover }: ApprovalRequest): string {
    const approverIds = approversToAsk(required, customerAdmins, providerApprovers, standIn)
    const refusals = approverIds.map((approverId) => requestApproval(task, approverId))
    const saved = approverIds.filter((_, i) => !refusals[i])
    const allApproved = saved.map((approverId) => ({ approverId, state: APPROVAL.approved }))
    if (rollupApprovals(required, groupDecisions(allApproved, customerAdmins, standIn)) === 'approved') return ''
    if (saved.length > 0) cancelPendingApprovals(task.getUniqueValue())
    const refused = refusals.find(Boolean)
    return refused ? `an approval request was refused: ${refused}` : noApprover
}

function requestApproval(task: GlideRecord, approverId: string): string {
    const approval = new GlideRecord('sysapproval_approver')
    approval.initialize()
    approval.setValue('sysapproval', task.getUniqueValue())
    approval.setValue('source_table', task.getTableName())
    approval.setValue('document_id', task.getUniqueValue())
    approval.setValue('approver', approverId)
    approval.setValue('state', APPROVAL.requested)
    if (approval.insert()) return ''
    return warnRefused(approval, `No approval request for ${str(task, 'number')} to ${approverId}`)
}

function approvalsOf(taskId: string): Array<{ approverId: string; state: ApprovalState }> {
    const approval = new GlideRecord('sysapproval_approver')
    approval.addQuery('sysapproval', taskId)
    approval.query()
    const approvals: Array<{ approverId: string; state: ApprovalState }> = []
    while (approval.next()) approvals.push({ approverId: str(approval, 'approver'), state: str(approval, 'state') as ApprovalState })
    return approvals
}

/**
 * Cancel approvals still waiting once the outcome is decided, or the task is cancelled. Each cancellation is a saved
 * state change, so the after-update rule that rolls approvals up runs again: save the task out of awaiting approval
 * first.
 */
export function cancelPendingApprovals(taskId: string): void {
    const approval = new GlideRecord('sysapproval_approver')
    approval.addQuery('sysapproval', taskId)
    approval.addQuery('state', APPROVAL.requested)
    approval.query()
    while (approval.next()) {
        approval.setValue('state', APPROVAL.cancelled)
        if (approval.update()) continue
        // Left waiting, it still counts in the rollup if a draft task is submitted again (a rejection rejects it).
        warnRefused(approval, `Approval request ${approval.getUniqueValue()} left requested, cancel it`)
    }
}
