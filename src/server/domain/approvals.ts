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
 * Who decides for the admins of a Customer that has none, a choice each kind of task makes: its provider-side
 * approvers (`provider`), or nobody, so it cannot be approved where the customer-admin group is required.
 */
export type StandIn = 'provider' | 'nobody'

/**
 * Tag raw approvals with their group: the Customer admins asked decide for the customer-admin group; everyone else
 * (the account manager or the asset managers) for the account-manager group, and with no Customer admin asked, for
 * the customer-admin group too when they `standIn` for the admins.
 */
export function groupDecisions(
    approvals: ReadonlyArray<{ approverId: string; state: ApprovalState }>,
    customerAdminIds: readonly string[],
    standIn: StandIn,
): ApprovalDecision[] {
    const providerForAdmins = customerAdminIds.length === 0 && standIn === 'provider'
    return approvals.flatMap(({ approverId, state }): ApprovalDecision[] => {
        if (customerAdminIds.includes(approverId)) return [{ group: 'customer_admin', state }]
        const provider: ApprovalDecision = { group: 'account_manager', state }
        return providerForAdmins ? [provider, { group: 'customer_admin', state }] : [provider]
    })
}

/**
 * Who is asked to decide for the `required` groups: the Customer's admins for the customer-admin group, the
 * provider-side approvers for the account-manager group, and those too in place of the admins of a Customer that has
 * none when they `standIn` for them (`groupDecisions` then counts their decision for both groups). Each is asked once.
 */
export function approversToAsk(
    required: readonly Approver[],
    customerAdminIds: readonly string[],
    providerApproverIds: readonly string[],
    standIn: StandIn,
): string[] {
    const forAdmins = customerAdminIds.length > 0 || standIn === 'nobody' ? customerAdminIds : providerApproverIds
    const ids = new Set<string>()
    for (const group of required) {
        for (const id of group === 'customer_admin' ? forAdmins : providerApproverIds) ids.add(id)
    }
    return [...ids]
}

/**
 * Why approvals that roll up to neither outcome (`rollupApprovals` gives requested) keep a task awaiting approval:
 * whose approval is missing, each group as its flow `names` it, and whether a request to them is still waiting.
 */
export function approvalAwaited(
    required: readonly Approver[],
    decisions: readonly ApprovalDecision[],
    names: Readonly<Record<Approver, string>>,
): string {
    const approved = new Set(decisions.filter((d) => d.state === APPROVAL.approved).map((d) => d.group))
    const missing = required.filter((group) => !approved.has(group))
    const who = missing.map((group) => names[group]).join(' and ')
    const waiting = decisions.some((d) => d.state === APPROVAL.requested && missing.includes(d.group))
    return waiting ? `waiting for ${who} to decide` : `no approval from ${who} and none still requested`
}
