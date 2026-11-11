import { GlideRecord, gs } from '@servicenow/glide'
import { refusal, str } from './records.ts'

/**
 * On-site work: an FSM work order (wm_order) and the change request it runs under (Q57).
 * Routine jobs use a standard change; the change type is decided by the caller.
 */

export type FieldPurpose = 'install' | 'swap' | 'de_install' | 'site_audit'

/** What the work is for: the Customer, Site and the app record that asked for it. */
export interface WorkContext {
    customerId: string
    siteId: string
    description: string
    /** The app record the work belongs to, linked from the change and work order. */
    source: { field: 'x_daas_ham_order' | 'x_daas_ham_return_order' | 'x_daas_ham_audit'; id: string }
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
    const changeId = change.insert()
    if (!changeId) {
        gs.warn(`[x_daas_ham] No change for ${context.description}: ${refusal(change)}`)
        return null
    }
    const workOrder = workRecord('wm_order', context)
    workOrder.setValue('x_daas_ham_purpose', job.purpose)
    workOrder.setValue('parent', changeId)
    if (job.subcontracted) workOrder.setValue('work_notes', 'Dispatch to subcontractor / remote hands.')
    const workOrderId = workOrder.insert()
    if (!workOrderId) {
        const orphan = `${str(change, 'number')} has none, cancel it`
        gs.warn(`[x_daas_ham] No work order for ${context.description}: ${refusal(workOrder)}; ${orphan}`)
        return null
    }
    return { changeId, workOrderId }
}

/** A new change or work order with the context's description, Customer, Site and source record (the caller saves). */
function workRecord(table: 'change_request' | 'wm_order', context: WorkContext): GlideRecord {
    const record = new GlideRecord(table)
    record.initialize()
    record.setValue('short_description', context.description)
    record.setValue('company', context.customerId)
    record.setValue('location', context.siteId)
    record.setValue(context.source.field, context.source.id)
    return record
}
