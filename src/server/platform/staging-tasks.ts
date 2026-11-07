import { GlideRecord, gs } from '@servicenow/glide'
import { initialAutomationStatus } from '../domain/oem/claims'
import { selectStagingTemplate, type StagingTemplateView } from '../domain/staging'
import { bool, deleteWhere, num, str } from './records'

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

/**
 * Open the Asset's Staging task with its template's steps; null (and a warning) when the platform refuses the task or
 * one of its steps. Closure checks only the steps the task has, so a task missing a mandatory step is not kept.
 */
export function openStagingTask(asset: GlideRecord, orderLineId: string): string | null {
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
    const taskId = task.insert()
    if (!taskId) {
        gs.warn(`[x_daas_ham] No Staging task for ${str(asset, 'serial_number')}: ${task.getLastErrorMessage() || 'insert refused'}`)
        return null
    }
    const stepRefused = templateId ? copyTemplateSteps(templateId, taskId) : null
    if (stepRefused === null) return taskId
    deleteWhere('x_daas_ham_staging_step', `staging_task=${taskId}`)
    const removed = task.deleteRecord()
    gs.warn(
        `[x_daas_ham] No Staging task for ${str(asset, 'serial_number')}: ${stepRefused}` +
            (removed ? '' : `; ${str(task, 'number')} keeps an incomplete checklist, cancel it`),
    )
    return null
}

/**
 * Copies the template's steps onto the task, each automated one in its initialAutomationStatus. Stops at the first
 * step the platform refuses and says why; null when every step was saved.
 */
function copyTemplateSteps(templateId: string, taskId: string): string | null {
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
        if (!step.insert()) return `step "${label}" not saved: ${step.getLastErrorMessage() || 'insert refused'}`
    }
    return null
}

export function stagingSteps(taskId: string): Array<{ mandatory: boolean; done: boolean }> {
    const step = new GlideRecord('x_daas_ham_staging_step')
    step.addQuery('staging_task', taskId)
    step.query()
    const steps: Array<{ mandatory: boolean; done: boolean }> = []
    while (step.next()) steps.push({ mandatory: bool(step, 'mandatory'), done: bool(step, 'done') })
    return steps
}
