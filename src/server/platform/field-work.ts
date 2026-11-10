import { GlideRecord } from '@servicenow/glide'
import type { FieldPurpose } from '../domain/vocabulary.ts'
import { str, warnRefused } from './records.ts'

/**
 * On-site work: an FSM work order (wm_order) and the change request it runs under (D57).
 * Routine jobs use a standard change; the change type is decided by the caller.
 */

/** What the work is for: the Customer, Site and the app record that asked for it. */
export interface WorkContext {
    customerId: string
    siteId: string
    description: string
    /**
     * The app record the work belongs to (an Order, a Return order or an Audit, each a task): the change's Parent and
     * the work order's Initiated from, the platform's own references (ADR 0018).
     */
    sourceId: string
}

/** The job: the change type it runs under, what it is for and whether a subcontractor does it. */
export interface FieldJob {
    changeType: 'standard' | 'normal'
    purpose: FieldPurpose
    subcontracted: boolean
}

/** The saved change and the work order that runs under it. */
export interface FieldWork {
    changeId: string
    workOrderId: string
}

/**
 * Open the change and the work order that runs under it. Null, with a warning, when the platform refuses either: no
 * work order runs without its change, and the caller links neither. A change left without its work order is named in
 * the warning, to cancel by hand (the app may not delete changes).
 */
export function openFieldWork(context: WorkContext, job: FieldJob): FieldWork | null {
    const change = workRecord('change_request', context)
    change.setValue('type', job.changeType)
    change.setValue('parent', context.sourceId)
    const changeId = change.insert()
    if (!changeId) {
        warnRefused(change, `No change for ${context.description}`)
        return null
    }
    const workOrder = workRecord('wm_order', context)
    workOrder.setValue('x_daas_ham_purpose', job.purpose)
    workOrder.setValue('initiated_from', context.sourceId)
    workOrder.setValue('parent', changeId)
    if (job.subcontracted) workOrder.setValue('work_notes', 'Dispatch to subcontractor / remote hands.')
    const workOrderId = workOrder.insert()
    if (!workOrderId) {
        warnRefused(workOrder, `No work order for ${context.description} (${str(change, 'number')} has none, cancel it)`)
        return null
    }
    return { changeId, workOrderId }
}

/** A new change or work order with the context's description, Customer and Site (the caller links and saves it). */
function workRecord(table: 'change_request' | 'wm_order', context: WorkContext): GlideRecord {
    const record = new GlideRecord(table)
    record.initialize()
    record.setValue('short_description', context.description)
    record.setValue('company', context.customerId)
    record.setValue('location', context.siteId)
    return record
}
