import { GlideDateTime, gs, type GlideRecord } from '@servicenow/glide'
import { REQUEUE } from '../domain/job-lock.ts'
import { str } from './records.ts'

/** Events this app fires (registered in src/fluent/logic/events.now.ts). */
export const EVENT = {
    sourceOrder: 'x_daas_ham.order.source',
    lifecycleChanged: 'x_daas_ham.model.lifecycle',
    agreementTermsChanged: 'x_daas_ham.agreement.terms',
    returnOverdue: 'x_daas_ham.return.overdue',
    leaseAssets: 'x_daas_ham.lease.assets',
    leaseBuyout: 'x_daas_ham.lease.buyout',
    billingExport: 'x_daas_ham.billing.export',
    leaseMismatch: 'x_daas_ham.lease.mismatch',
    agreementRenewal: 'x_daas_ham.agreement.renewal',
    coverageExpiring: 'x_daas_ham.coverage.expiring',
    billingGenerate: 'x_daas_ham.billing.generate',
    marginCompute: 'x_daas_ham.margin.compute',
    trackShipment: 'x_daas_ham.shipment.track',
} as const

export function fire(event: string, record: GlideRecord, parm1 = '', parm2 = ''): void {
    gs.eventQueue(event, record, parm1, parm2)
}

/**
 * An event of an event job (platform/chunked `runEventTableJob`) as its script action receives it. Every such event
 * names the job's subject in parm1 (the sys_id its records are selected by: a Model, a Lease schedule, a Billing
 * period) and carries where its pass got to in parm2: the key of the last record finished ('' on a pass's first
 * event), behind the pass's token where the job's passes replace each other (domain/chunked-job `passParm`).
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
    return { name, record: current, subject: str(event, 'parm1'), position: str(event, 'parm2') }
}

/**
 * Queue `event` on `record` again, to run `seconds` from now: a request that could not run under its lock (domain/job-lock
 * `REQUEUE`, which also bounds how often a counted request is queued again).
 */
export function requeue(event: string, record: GlideRecord, parm1: string, parm2: string, seconds: number = REQUEUE.delaySeconds): void {
    const when = new GlideDateTime()
    when.addSeconds(seconds)
    gs.eventQueueScheduled(event, record, parm1, parm2, when)
}
