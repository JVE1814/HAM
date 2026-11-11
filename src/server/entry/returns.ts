import { gs, type GlideRecord } from '@servicenow/glide'
import { evaluateReturnLine, requestProducedReturn } from '../platform/returns.ts'

/** Returns, decommissions and depot evaluation (P2.4): platform/returns. */

/**
 * Record producer "Return or decommission equipment" post-insert script: raise the Return it just saved for the
 * devices it lists (platform/returns `requestProducedReturn`, which removes one that is not raised). (`current` is
 * typed unknown because the SDK passes its own GlideRecord type here.)
 */
export function afterReturnProduced(producer: Record<string, unknown>, current: unknown): void {
    const listed = String(producer.assets ?? '')
        .split(',')
        .map((id) => id.trim())
    const outcome = requestProducedReturn(current as GlideRecord, listed)
    if (!outcome.raised) gs.addErrorMessage(`Return not raised. ${outcome.why}.`)
}

export function onReturnEvaluated(current: GlideRecord): void {
    const evaluation = evaluateReturnLine(current)
    if (!evaluation.evaluated) gs.addErrorMessage(evaluation.why)
}
