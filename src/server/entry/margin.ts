// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.
import { gs, type GlideRecord } from '@servicenow/glide'
import { EVENT, jobEvent } from '../platform/events.ts'
import { computeMarginChunk, queueMarginCompute } from '../platform/margin.ts'
import { str } from '../platform/records.ts'

/** Cost facts and Margin per Customer and Site, computed when a Billing period closes (P3.28): platform/margin. */

export function uiRecomputeMargin(current: GlideRecord): void {
    queueMarginCompute(current)
    gs.addInfoMessage(`Recomputing margin for ${str(current, 'period')}`)
}

export function computeMargin(event: GlideRecord, current: GlideRecord): void {
    computeMarginChunk(jobEvent(EVENT.marginCompute, event, current))
}
