import { gs, type GlideRecord } from '@servicenow/glide'
import type { ReturnMethod } from '../domain/vocabulary.ts'
import { str, warnRefused } from '../platform/records.ts'
import { chaseOverdue, evaluateReturnLine, requestReturn } from '../platform/returns.ts'
import { raiseDueReturns } from '../platform/scheduled-returns.ts'

/** Returns, decommissions, depot evaluation and overdue chasing (P2.4): platform/returns. */

/**
 * Record producer "Return or decommission equipment" (platform/returns `requestReturn`). A Return its requester may
 * not raise, or for a Site that is not its Customer's, is removed again. (`current` is typed unknown because the SDK
 * passes its own GlideRecord type here.)
 */
export function afterReturnProduced(producer: Record<string, unknown>, current: unknown): void {
    const order = current as GlideRecord
    const outcome = requestReturn({
        produced: order,
        customerId: str(order, 'customer'),
        siteId: str(order, 'site'),
        decommission: str(order, 'trigger') === 'site_decommission',
        listedAssetIds: String(producer.assets ?? '')
            .split(',')
            .map((id) => id.trim()),
        method: str(order, 'method') as ReturnMethod | '',
        describe: () => str(order, 'short_description') || `Return from ${order.getDisplayValue('site')}`,
    })
    if (outcome.raised) return
    gs.addErrorMessage(`Return not raised. ${outcome.why}.`)
    // Never filled in, it moves nothing; one the platform keeps is logged, to cancel by hand.
    if (!order.deleteRecord()) warnRefused(order, `Refused return ${str(order, 'number')} not removed`)
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
