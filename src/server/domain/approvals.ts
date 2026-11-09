import type { Approver } from './entitlement.ts'

export type ApprovalState = 'requested' | 'approved' | 'rejected' | 'cancelled' | 'not_required' | 'not_yet_requested'
export type ApprovalOutcome = 'requested' | 'approved' | 'rejected'

export interface ApprovalDecision {
    group: Approver
    state: ApprovalState
}

/**
 * Overall approval of an Order: any rejection rejects it; it is approved once each required group
 * (any Customer admin; the account manager) has at least one approval.
 */
export function rollupApprovals(required: readonly Approver[], decisions: readonly ApprovalDecision[]): ApprovalOutcome {
    if (decisions.some((d) => d.state === 'rejected')) return 'rejected'
    const approvedGroups = new Set(decisions.filter((d) => d.state === 'approved').map((d) => d.group))
    return required.every((group) => approvedGroups.has(group)) ? 'approved' : 'requested'
}

/**
 * Tag raw approvals with their group: Customer admins of the Customer decide for the customer-admin
 * group; everyone else (the account manager or the asset managers standing in for them) for the
 * account-manager group. A Customer without Customer admins has its customer-admin approval given by
 * the provider-side approvers.
 */
export function groupDecisions(
    approvals: ReadonlyArray<{ approverId: string; state: ApprovalState }>,
    customerAdminIds: readonly string[],
): ApprovalDecision[] {
    return approvals.flatMap(({ approverId, state }): ApprovalDecision[] => {
        if (customerAdminIds.includes(approverId)) return [{ group: 'customer_admin', state }]
        const provider: ApprovalDecision = { group: 'account_manager', state }
        return customerAdminIds.length === 0 ? [provider, { group: 'customer_admin', state }] : [provider]
    })
}

/**
 * Who is asked to decide for the `required` groups: the Customer's admins for the customer-admin group, the
 * provider-side approvers for the account-manager group, and those too in place of the admins of a Customer that has
 * none (`groupDecisions` then counts their decision for both groups). Each is asked once.
 */
export function approversToAsk(
    required: readonly Approver[],
    customerAdminIds: readonly string[],
    providerApproverIds: readonly string[],
): string[] {
    const ids = new Set<string>()
    for (const group of required) {
        const admins = group === 'customer_admin' ? customerAdminIds : []
        for (const id of admins.length > 0 ? admins : providerApproverIds) ids.add(id)
    }
    return [...ids]
}
