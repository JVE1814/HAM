import { GlideDateTime, gs, type GlideRecord } from '@servicenow/glide'
import { REQUEUE } from '../domain/job-lock.ts'
import { str } from './records.ts'

/**
 * The events this app fires, by name: the one list of them. The Fluent metadata registers each (a sysevent_register
 * record beside the script action or notification that answers it) under the name it imports from here, and the
 * server code fires and answers it by the same constant. Each entry says what the event's record and parameters carry.
 */
export const EVENT = {
    /** An approved Order needs its lines sourced. Record: the Order; parm2: how often it was queued again. */
    sourceOrder: 'x_daas_ham.order.source',
    /** A Model's lifecycle milestones changed or one was crossed (event job). Record and parm1: the Model; parm2: cursor. */
    lifecycleChanged: 'x_daas_ham.model.lifecycle',
    /** An Agreement's refresh terms changed (event job). Record and parm1: the Agreement; parm2: cursor. */
    agreementTermsChanged: 'x_daas_ham.agreement.terms',
    /** Equipment on a Return order is overdue (notification). Record: the Return order; parm1: recipients; parm2: the Asset. */
    returnOverdue: 'x_daas_ham.return.overdue',
    /** Recompute the refresh due dates of a returned lease's Assets (event job). Record and parm1: the Lease schedule; parm2: cursor. */
    leaseAssets: 'x_daas_ham.lease.assets',
    /** Transfer a bought-out lease's Assets to the Provider (event job). Record and parm1: the Lease schedule; parm2: cursor. */
    leaseBuyout: 'x_daas_ham.lease.buyout',
    /** Attach the CSV export of a closed Billing period. Record and parm1: the period. */
    billingExport: 'x_daas_ham.billing.export',
    /** A lease ends before the Agreements its deployed Assets serve (notification). Record: the Lease schedule; parm1: recipients. */
    leaseMismatch: 'x_daas_ham.lease.mismatch',
    /** An Agreement is within its renewal lead time (notification). Record: the Agreement; parm1: recipients. */
    agreementRenewal: 'x_daas_ham.agreement.renewal',
    /** OEM coverage of a Customer's deployed Assets ends soon (notification). Record: the Customer; parm1: recipients; parm2: summary. */
    coverageExpiring: 'x_daas_ham.coverage.expiring',
    /** Generate the lines of a Billing period (event job). Record and parm1: the period; parm2: pass token and cursor. */
    billingGenerate: 'x_daas_ham.billing.generate',
    /** Compute the cost facts and margin of a closed Billing period (event job). Record and parm1: the period; parm2: pass token and cursor. */
    marginCompute: 'x_daas_ham.margin.compute',
    /** A Shipment's lock held off a tracking update. Record: the Shipment; parm1: the update (JSON); parm2: how often it was queued again. */
    trackShipment: 'x_daas_ham.shipment.track',
    /** A replacement Order is complete: its case is saved, so that its replacement SLA stops. Record: the Order. */
    replacementComplete: 'x_daas_ham.replacement.complete',
} as const

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
