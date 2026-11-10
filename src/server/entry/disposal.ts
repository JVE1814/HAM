import { gs, type GlideRecord } from '@servicenow/glide'
import { ROLE } from '../domain/visibility.ts'
import {
    completeDisposal,
    lineChangeRefusal,
    orderChangeRefusal,
    rollUpDisposalApprovals,
    submitDisposal,
} from '../platform/disposal.ts'
import { str } from '../platform/records.ts'
import { abortWith } from '../platform/rule-api.ts'

/** Disposal orders: approve, then retire each wiped Asset by its method (P2.5, D61): platform/disposal. */

/** UI action "Submit for approval" on a draft disposal order. */
export function uiSubmitDisposal(current: GlideRecord): void {
    // A refused form save (the platform says why) asks nobody: the order is not what the approvers would decide.
    if (!current.update()) return
    const submission = submitDisposal(current)
    if (!submission.submitted && submission.why) gs.addErrorMessage(submission.why)
}

/** After-update rule on sysapproval_approver for disposal orders: roll the decisions up to the order. */
export function onDisposalApprovalDecision(current: GlideRecord): void {
    rollUpDisposalApprovals(str(current, 'document_id'))
}

/** UI action "Complete disposal": retire every ready line; report what blocks the rest. */
export function uiCompleteDisposal(current: GlideRecord): void {
    // A refused form save (a method or Customer changed after submit) leaves the refused values on `current`.
    if (!current.update()) return
    const { blocked, unsaved } = completeDisposal(current)
    if (blocked > 0) gs.addErrorMessage(`${blocked} line(s) are blocked; see "Blocked by" on the lines`)
    if (unsaved > 0) gs.addErrorMessage(`${unsaved} line(s) could not be saved (see the system log)`)
}

/**
 * Before insert/update/delete rule on disposal lines: once the order leaves draft, what it retires is fixed
 * (platform/disposal `lineChangeRefusal`). Removing a line retires nothing, so administrators (the only role the ACLs
 * let delete) still may: otherwise a line whose Asset can never be retired keeps its order approved for good, and
 * deleting an order could not take its lines with it.
 */
export function guardDisposalLine(current: GlideRecord, previous: GlideRecord): void {
    if (current.operation() === 'delete' && gs.hasRole(ROLE.admin)) return
    abortWith(current, lineChangeRefusal(current, previous))
}

/** Before-update rule on disposal orders whose method or Customer changes: both are fixed at submit, like the lines. */
export function guardDisposalOrder(current: GlideRecord, previous: GlideRecord): void {
    abortWith(current, orderChangeRefusal(previous))
}
