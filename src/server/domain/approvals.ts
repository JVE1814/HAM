/** Who decides on an Order or a Disposal order: the Customer's admins, or the Provider's account manager. */
export type Approver = 'customer_admin' | 'account_manager'

/** The values the app stores in an approval request's `state` (sysapproval_approver) and an approved task's `approval`. */
export const APPROVAL = { requested: 'requested', approved: 'approved', rejected: 'rejected', cancelled: 'cancelled' } as const

export type ApprovalState = (typeof APPROVAL)[keyof typeof APPROVAL]
export type ApprovalOutcome = Exclude<ApprovalState, 'cancelled'>

export interface ApprovalDecision {
    group: Approver
    state: ApprovalState
}

/**
 * Overall approval of an Order: any rejection rejects it; it is approved once each required group
 * (any Customer admin; the account manager) has at least one approval.
 */
export function rollupApprovals(required: readonly Approver[], decisions: readonly ApprovalDecision[]): ApprovalOutcome {
    if (decisions.some((d) => d.state === APPROVAL.rejected)) return APPROVAL.rejected
    const approvedGroups = new Set(decisions.filter((d) => d.state === APPROVAL.approved).map((d) => d.group))
    return required.every((group) => approvedGroups.has(group)) ? APPROVAL.approved : APPROVAL.requested
}

/**
 * Tag raw approvals with their group: the Customer admins asked decide for the customer-admin
 * group; everyone else (the account manager or the asset managers standing in for them) for the
 * account-manager group. With no Customer admin asked, the customer-admin approval is given by the
 * provider-side approvers.
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

const APPROVER_NAMES: Record<Approver, string> = {
    customer_admin: 'a Customer admin',
    account_manager: 'the account manager (or the asset managers)',
}

/**
 * Why approvals that roll up to neither outcome (`rollupApprovals` gives requested) keep an Order awaiting approval, as
 * Re-check approvals tells the user: whose approval is missing, and whether a request to them is still waiting.
 */
export function approvalAwaited(required: readonly Approver[], decisions: readonly ApprovalDecision[]): string {
    const approved = new Set(decisions.filter((d) => d.state === APPROVAL.approved).map((d) => d.group))
    const missing = required.filter((group) => !approved.has(group))
    const who = missing.map((group) => APPROVER_NAMES[group]).join(' and ')
    const waiting = decisions.some((d) => d.state === APPROVAL.requested && missing.includes(d.group))
    return waiting ? `waiting for ${who} to decide` : `no approval from ${who} and none still requested`
}
