import { GlideDateTime, gs, type GlideRecord } from '@servicenow/glide'
import { REQUEUE } from '../domain/job-lock.ts'
import { str } from './records.ts'

export function fire(event: string, record: GlideRecord, parm1 = '', parm2 = ''): void {
    gs.eventQueue(event, record, parm1, parm2)
}

/**
 * An event of an event job (platform/chunked `runEventTableJob`) as its script action receives it. Every such event
 * names the job's subject in parm1 (the sys_id its records are selected by: a Model, a Lease schedule, a Billing
 * period) and carries where its pass got to in parm2: the key of the last record finished ('' on a pass's first
 * event), behind the pass's token where the job's passes replace each other (domain/chunked-job `passParm`).
 * `queueJob` and `queueJobAt` write such an event, `jobEvent` reads it.
 */
export interface JobEvent {
    name: string
    /** The record the event is queued on, and the next chunk's with it. */
    record: GlideRecord
    subject: string
    position: string
}

/** The job event a script action was called with: `event` and `current` are the platform's, `name` the event it is registered for. */
export function jobEvent(name: string, event: GlideRecord, current: GlideRecord): JobEvent {
    return { name, record: current, subject: subjectOf(event), position: str(event, 'parm2') }
}

/** The subject an event names in its parm1, as `queueJob` wrote it: the sys_id of the record it is queued on. */
export function subjectOf(event: GlideRecord): string {
    return str(event, 'parm1')
}

/**
 * Queue the event `name` for `subject`, on that record and naming it in parm1: the first event of a job's pass, which
 * carries no position, or the one event of work done for the record in the background.
 */
export function queueJob(name: string, subject: GlideRecord): void {
    fire(name, subject, subject.getUniqueValue(), '')
}

/** Queue the event of `queued`'s job that carries on from `position`: at once, or after the wait of a `requeue`. */
export function queueJobAt(queued: JobEvent, position: string, when: 'now' | 'later' = 'now'): void {
    if (when === 'later') requeue(queued.name, queued.record, queued.subject, position)
    else fire(queued.name, queued.record, queued.subject, position)
}

/**
 * Queue `event` on `record` again, to run a minute from now: a request that could not run under its lock
 * (domain/job-lock `REQUEUE`).
 */
function requeue(event: string, record: GlideRecord, parm1: string, parm2: string): void {
    const when = new GlideDateTime()
    when.addSeconds(REQUEUE.delaySeconds)
    gs.eventQueueScheduled(event, record, parm1, parm2, when)
}

/**
 * A counted request: an event whose parm2 carries how often it was queued again (none or 0 as first queued), so that
 * one a lock keeps holding off is given up in the end. `timesRequeued` reads the count for the event's script action.
 */
export function timesRequeued(event: GlideRecord): number {
    return Number(str(event, 'parm2')) || 0
}

/**
 * Queue the counted request `event` (with its `parm1`) on `record` again, a minute later, unless it was already queued
 * again `tries` times (domain/job-lock `REQUEUE.times`): false when it is given up instead, for the caller to say so.
 */
export function requeueCounted(event: string, record: GlideRecord, parm1: string, tries: number): boolean {
    if (tries >= REQUEUE.times) return false
    requeue(event, record, parm1, String(tries + 1))
    return true
}
