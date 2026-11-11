import { gs, type GlideRecord } from '@servicenow/glide'
import {
    completeDisposal,
    lineChangeRefusal,
    orderChangeRefusal,
    rollUpDisposalApprovals,
    submitDisposal,
} from '../platform/disposal.ts'
import { str, type ForeignRecord } from '../platform/records.ts'
import { abortWith } from '../platform/rule-api.ts'

/** Disposal orders: approve, then retire each wiped Asset by its method (P2.5, Q61): platform/disposal. */

export function uiSubmitDisposal(current: GlideRecord): void {
    // A refused form save (the platform says why) asks nobody: the order is not what the approvers would decide.
    if (!current.update()) return
    const submission = submitDisposal(current)
    if (!submission.submitted && submission.why) gs.addErrorMessage(submission.why)
}

export function onDisposalApprovalDecision(current: ForeignRecord): void {
    rollUpDisposalApprovals(str(current, 'document_id'))
}

export function uiCompleteDisposal(current: GlideRecord): void {
    // A refused form save (a method or Customer changed after submit) leaves the refused values on `current`.
    if (!current.update()) return
    const { blocked, unsaved, refused } = completeDisposal(current)
    if (blocked > 0) gs.addErrorMessage(`${blocked} line(s) are blocked; see "Blocked by" on the lines`)
    if (unsaved > 0) gs.addErrorMessage(`${unsaved} line(s) could not be saved (see the system log)`)
    if (refused) gs.addErrorMessage(`Every line is done, but ${str(current, 'number')} was not saved as completed: ${refused}; complete it again`)
}

/** Before insert/update/delete rule on disposal lines: once the order leaves draft, what it retires is fixed. */
export function guardDisposalLine(current: GlideRecord, previous: GlideRecord): void {
    abortWith(current, lineChangeRefusal(current, previous))
}

export function guardDisposalOrder(current: GlideRecord, previous: GlideRecord): void {
    abortWith(current, orderChangeRefusal(previous))
}
