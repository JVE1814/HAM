import { gs, type GlideRecord } from '@servicenow/glide'
import { chaseOverdue, evaluateReturnLine, requestProducedReturn } from '../platform/returns.ts'
import { raiseDueReturns } from '../platform/scheduled-returns.ts'

/** Returns, decommissions, depot evaluation and overdue chasing (P2.4): platform/returns. */

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

/** After-update rule on return lines whose evaluation was set: route the Asset onward (platform/returns `evaluateReturnLine`). */
export function onReturnEvaluated(current: GlideRecord): void {
    const evaluation = evaluateReturnLine(current)
    if (!evaluation.evaluated) gs.addErrorMessage(evaluation.why)
}

/** Daily: escalate overdue returns once, then declare the Assets missing and charge the lost-asset fee. */
export function chaseOverdueReturns(): void {
    chaseOverdue()
}

/** Daily: agreements past their end date and temporary deployments ending soon bring their equipment back. */
export function raiseScheduledReturns(): void {
    raiseDueReturns()
}
