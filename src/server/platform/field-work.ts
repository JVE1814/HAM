import { GlideRecord } from '@servicenow/glide'

/**
 * On-site work: an FSM work order (wm_order) and the change request it runs under (D57).
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

export function openChange(context: WorkContext, type: 'standard' | 'normal'): string {
    const change = new GlideRecord('change_request')
    change.initialize()
    change.setValue('type', type)
    change.setValue('short_description', context.description)
    change.setValue('company', context.customerId)
    change.setValue('location', context.siteId)
    change.setValue(context.source.field, context.source.id)
    return change.insert() ?? ''
}

export function openWorkOrder(context: WorkContext, purpose: FieldPurpose, changeId: string, subcontracted: boolean): string {
    const workOrder = new GlideRecord('wm_order')
    workOrder.initialize()
    workOrder.setValue('short_description', context.description)
    workOrder.setValue('company', context.customerId)
    workOrder.setValue('location', context.siteId)
    workOrder.setValue(context.source.field, context.source.id)
    workOrder.setValue('x_daas_ham_purpose', purpose)
    if (changeId) workOrder.setValue('parent', changeId)
    if (subcontracted) workOrder.setValue('work_notes', 'Dispatch to subcontractor / remote hands.')
    return workOrder.insert() ?? ''
}
