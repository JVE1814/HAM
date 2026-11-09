import { GlideRecord, gs } from '@servicenow/glide'
import { initialAutomationStatus } from '../domain/oem/claims.ts'
import { DEFAULT_STAGING_SOURCE, selectStagingTemplate, STAGING_TASK_STATE, type StagingTemplateView } from '../domain/staging.ts'
import { moveAndSave } from './assets.ts'
import { beyondVisibility } from './beyond-visibility.ts'
import { lineLostUnit } from './fulfilment.ts'
import { bool, deleteWhere, exists, findById, num, refusal, str, warnRefused } from './records.ts'

/** Staging tasks with their checklist steps: opening them, starting the staging, and skipping those no longer needed. */

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
    const source = (str(asset, 'x_daas_ham_staging_source') || DEFAULT_STAGING_SOURCE) as StagingTemplateView['source']
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
        warnRefused(task, `No Staging task for ${str(asset, 'serial_number')}`)
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
 * Start staging the Asset for its Order line: open its Staging task and move it into staging. Without its task
 * (`no_task`) the Asset stays reserved for the line rather than staging with no task to finish; so does one whose move
 * the lifecycle or the platform refuses (`not_moved`, logged with `context`), its task left open.
 */
export function startStaging(asset: GlideRecord, orderLineId: string, context: string): 'staging' | 'no_task' | 'not_moved' {
    if (!openStagingTask(asset, orderLineId)) return 'no_task'
    return moveAndSave(asset, 'staging', context) ? 'staging' : 'not_moved'
}

/**
 * The Staging task `taskNumber` of an Asset was closed complete: the Asset is staged. One whose staging `failed` goes
 * for evaluation instead and leaves its Order line, which is filled again (platform/fulfilment `lineLostUnit`). A move
 * the lifecycle or the platform refuses is logged.
 */
export function completeStaging(assetId: string, taskNumber: string, failed: boolean): void {
    const asset = findById('alm_hardware', assetId)
    if (!asset) return
    if (!failed) return void moveAndSave(asset, 'staged', `staging ${taskNumber}`)
    const lineId = str(asset, 'x_daas_ham_order_line')
    asset.setValue('x_daas_ham_order_line', '')
    moveAndSave(asset, 'pending_evaluation', `staging ${taskNumber} failed`)
    if (lineId) lineLostUnit(lineId)
}

/**
 * Whether a Staging task is open for the Asset, read past the visibility rules (ADR 0005): an inventory tech receiving
 * a transfer order line at the staging centre does not see a task whose Asset is still stored in the stockroom it left.
 */
export function hasOpenStagingTask(assetId: string): boolean {
    return exists('x_daas_ham_staging_task', `asset=${assetId}^active=true`, { beyondVisibility: true })
}

/**
 * Skip the Asset's open Staging tasks, noting `why`; false when the platform refuses one (logged). Read past the
 * user's rules (ADR 0005): an inventory tech sees only the tasks of Assets in their stockrooms.
 */
export function skipOpenStagingTasks(assetId: string, why: string): boolean {
    const task = new GlideRecord('x_daas_ham_staging_task')
    task.addQuery('asset', assetId)
    task.addQuery('active', true)
    beyondVisibility(task, () => task.query())
    let closed = true
    while (task.next()) {
        task.setValue('state', STAGING_TASK_STATE.skipped)
        task.setValue('work_notes', `${why}; staging skipped.`)
        if (task.update()) continue
        // Left open, it asks a technician to stage a unit that is back in stock.
        warnRefused(task, `${why.toLowerCase()}: ${str(task, 'number')} left open, close it`)
        closed = false
    }
    return closed
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
        if (!step.insert()) return `step "${label}" not saved: ${refusal(step)}`
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
