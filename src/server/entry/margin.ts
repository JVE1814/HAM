import { gs, type GlideRecord } from '@servicenow/glide'
import { EVENT } from '../domain/events.ts'
import { jobEvent, queueJob } from '../platform/events.ts'
import { computeMarginChunk } from '../platform/margin.ts'
import { str } from '../platform/records.ts'

export function uiRecomputeMargin(current: GlideRecord): void {
    queueJob(EVENT.marginCompute, current)
    gs.addInfoMessage(`Recomputing margin for ${str(current, 'period')}`)
}

export function computeMargin(event: GlideRecord, current: GlideRecord): void {
    computeMarginChunk(jobEvent(EVENT.marginCompute, event, current))
}
