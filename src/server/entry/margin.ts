import { gs, type GlideRecord } from '@servicenow/glide'
import { EVENT } from '../domain/events.ts'
import { jobEvent } from '../platform/events.ts'
import { computeMarginChunk, queueMarginCompute } from '../platform/margin.ts'
import { str } from '../platform/records.ts'

export function uiRecomputeMargin(current: GlideRecord): void {
    queueMarginCompute(current)
    gs.addInfoMessage(`Recomputing margin for ${str(current, 'period')}`)
}

export function computeMargin(event: GlideRecord, current: GlideRecord): void {
    computeMarginChunk(jobEvent(EVENT.marginCompute, event, current))
}
