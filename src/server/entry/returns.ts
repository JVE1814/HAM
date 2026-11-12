import { gs, type GlideRecord } from '@servicenow/glide'
import { contactReturnInsertRefusal, evaluateReturnLine, requestProducedReturn } from '../platform/returns.ts'
import { abortWith } from '../platform/rule-api.ts'

/**
 * Record producer "Return or decommission equipment" post-insert script. (`current` is
 * typed unknown because the SDK passes its own GlideRecord type here.)
 */
export function afterReturnProduced(producer: Record<string, unknown>, current: unknown): void {
    const order = current as GlideRecord
    const listed = String(producer.assets ?? '')
        .split(',')
        .map((id) => id.trim())
    const outcome = requestProducedReturn(order, listed)
    if (!outcome.raised) gs.addErrorMessage(`Return not raised. ${outcome.why}.`)
}

export function guardContactReturn(current: GlideRecord): void {
    abortWith(current, contactReturnInsertRefusal(current))
}

/**
 * Record producer script, run before the Return order is inserted: a Customer contact's request is checked here, as the
 * before-insert rule checks it. Refused by the rule, the platform still stores the producer's answers; refused here, it
 * stores nothing (docs/research/external-contracts.md N48).
 */
export function beforeReturnProduced(_producer: Record<string, unknown>, current: unknown): void {
    guardContactReturn(current as GlideRecord)
}

export function onReturnEvaluated(current: GlideRecord): void {
    const evaluation = evaluateReturnLine(current)
    if (!evaluation.evaluated) gs.addErrorMessage(evaluation.why)
}
