import { gs, type GlideRecord } from '@servicenow/glide'
import { isStored } from '../platform/records.ts'
import { contactReturnInsertRefusal, evaluateReturnLine, requestProducedReturn } from '../platform/returns.ts'
import { abortWith } from '../platform/rule-api.ts'

/**
 * Record producer "Return or decommission equipment" post-insert script. (`current` is
 * typed unknown because the SDK passes its own GlideRecord type here.)
 */
export function afterReturnProduced(producer: Record<string, unknown>, current: unknown): void {
    const order = current as GlideRecord
    // A rule that refused the insert has told the requester why (`guardContactReturn`). Whether the platform still
    // runs this script then is not known, and nothing is raised on a Return order that is not stored.
    if (!isStored(order)) return
    const listed = String(producer.assets ?? '')
        .split(',')
        .map((id) => id.trim())
    const outcome = requestProducedReturn(order, listed)
    if (!outcome.raised) gs.addErrorMessage(`Return not raised. ${outcome.why}.`)
}

/** Before-insert rule on Return orders: refuses one a Customer contact may not save as it stands. */
export function guardContactReturn(current: GlideRecord): void {
    abortWith(current, contactReturnInsertRefusal(current))
}

export function onReturnEvaluated(current: GlideRecord): void {
    const evaluation = evaluateReturnLine(current)
    if (!evaluation.evaluated) gs.addErrorMessage(evaluation.why)
}
