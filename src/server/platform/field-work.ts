import { GlideRecord } from '@servicenow/glide'
import { str } from './records'

/**
 * On-site work: an FSM work order (wm_order) and the change request it runs under (D57).
 * Routine jobs use a standard change; the change type is decided by the caller.
 */

export type FieldPurpose = 'install' | 'swap' | 'de_install' | 'site_audit'

export function openChange(order: GlideRecord, input: { type: 'standard' | 'normal'; description: string }): string {
    const change = new GlideRecord('change_request')
    change.initialize()
    change.setValue('type', input.type)
    change.setValue('short_description', input.description)
    change.setValue('company', str(order, 'customer'))
    change.setValue('location', str(order, 'site'))
    change.setValue('x_daas_ham_order', order.getUniqueValue())
    return change.insert() ?? ''
}

export function openWorkOrder(
    order: GlideRecord,
    input: { purpose: FieldPurpose; description: string; changeId: string; subcontracted: boolean },
): string {
    const workOrder = new GlideRecord('wm_order')
    workOrder.initialize()
    workOrder.setValue('short_description', input.description)
    workOrder.setValue('company', str(order, 'customer'))
    workOrder.setValue('location', str(order, 'site'))
    workOrder.setValue('x_daas_ham_order', order.getUniqueValue())
    workOrder.setValue('x_daas_ham_purpose', input.purpose)
    if (input.changeId) workOrder.setValue('parent', input.changeId)
    if (input.subcontracted) workOrder.setValue('work_notes', 'Dispatch to subcontractor / remote hands.')
    return workOrder.insert() ?? ''
}
