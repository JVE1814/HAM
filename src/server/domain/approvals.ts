import type { Approver } from './entitlement'

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
