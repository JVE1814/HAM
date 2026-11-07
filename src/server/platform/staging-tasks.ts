import { GlideRecord } from '@servicenow/glide'
import { initialAutomationStatus } from '../domain/oem/claims'
import { selectStagingTemplate, type StagingTemplateView } from '../domain/staging'
import { bool, num, str } from './records'

/** Creating Staging tasks with their checklist steps. */

function templates(): StagingTemplateView[] {
    const gr = new GlideRecord('x_daas_ham_staging_template')
    gr.addQuery('active', true)
    gr.query()
    const list: StagingTemplateView[] = []
    while (gr.next()) {
        list.push({
            id: gr.getUniqueValue(),
            name: str(gr, 'name'),
            customerId: str(gr, 'customer'),
            manufacturerId: str(gr, 'manufacturer'),
            deviceClass: str(gr, 'device_class'),
            source: str(gr, 'staging_source') as StagingTemplateView['source'],
            active: true,
        })
    }
    return list
}

export function openStagingTask(asset: GlideRecord, orderLineId: string): string {
    const source = (str(asset, 'x_daas_ham_staging_source') || 'in_house') as StagingTemplateView['source']
    const templateId = selectStagingTemplate(templates(), {
        customerId: str(asset, 'company'),
        manufacturerId: str(asset, 'model.manufacturer'),
        deviceClass: str(asset, 'model.x_daas_ham_device_class'),
        source,
    })

    const task = new GlideRecord('x_daas_ham_staging_task')
    task.initialize()
    task.setValue('asset', asset.getUniqueValue())
    task.setValue('order_line', orderLineId)
    task.setValue('staging_source', source)
    task.setValue('short_description', `Stage ${str(asset, 'model.display_name') || 'asset'} ${str(asset, 'serial_number')}`)
    if (templateId) task.setValue('template', templateId)
    const taskId = task.insert() ?? ''
    if (templateId) copyTemplateSteps(templateId, taskId)
    return taskId
}

/** Copies the template's steps onto the task; an automated step starts waiting when the task also gets its OEM prerequisite step (initialAutomationStatus). */
function copyTemplateSteps(templateId: string, taskId: string): void {
    const item = new GlideRecord('x_daas_ham_staging_tmpl_item')
    item.addQuery('template', templateId)
    item.orderBy('order')
    item.query()
    const items: Array<{ label: string; order: number; mandatory: boolean; automation: string }> = []
    while (item.next()) items.push({ label: str(item, 'label'), order: num(item, 'order'), mandatory: bool(item, 'mandatory'), automation: str(item, 'automation') })
    const taskActions = items.map((i) => i.automation)
    for (const { label, order, mandatory, automation } of items) {
        const step = new GlideRecord('x_daas_ham_staging_step')
        step.initialize()
        step.setValue('staging_task', taskId)
        step.setValue('label', label)
        step.setValue('order', order)
        step.setValue('mandatory', mandatory)
        if (automation) {
            step.setValue('automation', automation)
            step.setValue('automation_status', initialAutomationStatus(automation, taskActions))
        }
        step.insert()
    }
}

export function stagingSteps(taskId: string): Array<{ mandatory: boolean; done: boolean }> {
    const step = new GlideRecord('x_daas_ham_staging_step')
    step.addQuery('staging_task', taskId)
    step.query()
    const steps: Array<{ mandatory: boolean; done: boolean }> = []
    while (step.next()) steps.push({ mandatory: bool(step, 'mandatory'), done: bool(step, 'done') })
    return steps
}
