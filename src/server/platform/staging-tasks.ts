import { GlideRecord } from '@servicenow/glide'
import { claimRouted, initialAutomationStatus } from '../domain/oem/claims.ts'
import { PROPERTY } from '../domain/properties.ts'
import { lineStillOpen } from '../domain/sourcing.ts'
import {
    closureMoveProblem,
    DEFAULT_STAGING_SOURCE,
    newerTask,
    selectStagingTemplate,
    stageOnClosure,
    STAGING_TASK_STATE,
    stagingClosureRefusal,
    type ClosedStagingTask,
    type ClosingAsset,
    type OpenedTask,
    type StagingClosing,
    type StagingTemplateView,
} from '../domain/staging.ts'
import { moveAndSave, readStage } from './assets.ts'
import { beyondVisibility } from './beyond-visibility.ts'
import { lineLostUnit } from './fulfilment.ts'
import { log } from './log.ts'
import { stringProperty } from './properties.ts'
import { bool, deleteWhere, exists, findById, num, refusal, str, warnRefused } from './records.ts'
import { takeOffOrderLine } from './stock.ts'

/**
 * Staging tasks with their checklist steps: opening them, starting the staging, and skipping those no longer needed.
 * A task's steps are created (and removed with a task that could not be opened) here; what an automated step goes
 * through afterwards is platform/claim-steps'.
 */

/** The staging centre's stockroom: where purchased units ship to, Assets are staged and shipments leave from ('' while none is set). */
export function stagingStockroom(): string {
    return stringProperty(PROPERTY.stagingStockroom)
}

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
    const stepRefused = templateId ? copyTemplateSteps(templateId, taskId, str(asset, 'model.x_daas_ham_oem_source')) : null
    if (stepRefused === null) return taskId
    deleteWhere('x_daas_ham_staging_step', `staging_task=${taskId}`)
    const removed = task.deleteRecord()
    log.warn(
        `No Staging task for ${str(asset, 'serial_number')}: ${stepRefused}` +
            (removed ? '' : `; ${str(task, 'number')} keeps an incomplete checklist, cancel it`),
    )
    return null
}

/**
 * Start staging the Asset for its Order line: open its Staging task and move it into staging. Without its task
 * (`no_task`) the Asset stays reserved for the line rather than staging with no task to finish; so does one whose move
 * the lifecycle or the platform refuses (`not_moved`, logged with `context`), its task left open: the caller skips the
 * task (sourcing). A receipt does the same two steps under its line's lock, checking the lock between them, and leaves
 * the task of a unit not moved for its close to move the unit into staging first (platform/receiving `stageReserved`;
 * `completeStaging`).
 */
export function startStaging(asset: GlideRecord, orderLineId: string, context: string): 'staging' | 'no_task' | 'not_moved' {
    if (!openStagingTask(asset, orderLineId)) return 'no_task'
    return moveAndSave(asset, 'staging', context) ? 'staging' : 'not_moved'
}

/**
 * Why the Staging task `current` (read as `task`) may not be closed the way it is being closed (`closing`), with what to
 * do, or null when it may: refused while closing cannot move the Asset to the stage it sends it to, or would leave a
 * unit that still needs the task without one (domain/staging `stagingClosureRefusal`). Only reads, with the user's
 * visibility, as `completeStaging` reads the Asset: an inventory tech sees a task only while its Asset is in their
 * stockrooms (ADR 0005), so they see the Asset too.
 */
export function stagingClosureProblem(current: GlideRecord, task: ClosedStagingTask, closing: StagingClosing): string | null {
    const asset = findById('alm_hardware', str(current, 'asset'))
    const checklist = closing === 'complete' && !task.failed ? stagingSteps(current.getUniqueValue()) : []
    return stagingClosureRefusal({ ...task, closing, newerTask: newerTaskThan(current) }, asset && closingAsset(asset), checklist)
}

function closingAsset(asset: GlideRecord): ClosingAsset {
    const line = { lineStage: str(asset, 'x_daas_ham_order_line.line_stage'), orderStage: str(asset, 'x_daas_ham_order_line.order.stage') }
    return { serial: str(asset, 'serial_number'), stage: readStage(asset), lineId: str(asset, 'x_daas_ham_order_line'), lineOpen: lineStillOpen(line) }
}

/** A newer open Staging task of the task's Asset ('' for none; domain/staging `newerTask`). */
function newerTaskThan(current: GlideRecord): string {
    const other = new GlideRecord('x_daas_ham_staging_task')
    other.addQuery('asset', str(current, 'asset'))
    other.addQuery('active', true)
    other.addQuery('sys_id', '!=', current.getUniqueValue())
    other.query()
    const opened = (task: GlideRecord): OpenedTask => ({ number: str(task, 'number'), openedAt: str(task, 'sys_created_on') })
    const others: OpenedTask[] = []
    while (other.next()) others.push(opened(other))
    return newerTask(opened(current), others)
}

/**
 * A Staging task of the Asset was closed complete: the Asset is staged, or goes for evaluation if it failed. What to
 * tell the user when closing it did not move the unit on, null when it did or nothing was to move.
 *
 * The before rule (`stagingClosureProblem`) let the closure through only for a unit it moves; one changed between the
 * two rules is left as it is, and why is given (domain/staging `closureMoveProblem`). A unit still reserved for the
 * task's line, its move into staging refused when the task opened (a receipt's `stageReserved`), is moved into staging
 * first. A move the platform refuses (moveAndSave warns) is reported for the user, who reopens the task and closes it
 * again to retry: the task is closed by then, and nothing else moves the unit on. A task closed again once its move is
 * made moves nothing more.
 */
export function completeStaging(assetId: string, task: ClosedStagingTask): string | null {
    const asset = findById('alm_hardware', assetId)
    if (!asset) return null
    const stage = readStage(asset)
    if (stage === stageOnClosure(task.failed)) return null
    const serial = str(asset, 'serial_number')
    const unmoved = closureMoveProblem(task, closingAsset(asset))
    if (unmoved) return `${task.number} is closed but moved nothing (reopen it to close it again): ${unmoved}`
    // The lifecycle allows it, so only the platform refuses: the unit stays reserved for its line.
    if (stage === 'reserved' && !moveAndSave(asset, 'staging', `staging ${task.number}`)) {
        return `${serial} not moved into staging (see the system log): it stays reserved for its order line; reopen ${task.number} and close it again`
    }
    if (task.failed) return failStaging(asset, task.number)
    if (moveAndSave(asset, 'staged', `staging ${task.number}`)) return null
    // Refused, the unit stays in staging and its line waits on it.
    return `${serial} not moved to staged (see the system log): it stays in staging; reopen ${task.number} and close it again`
}

/**
 * A unit that failed staging leaves its Order line, which is derived and sourced again (platform/fulfilment
 * `lineLostUnit`), and awaits evaluation, in one save: null once saved, else what to tell the user. The lifecycle
 * allows that move from staging, so only the platform refuses it: the unit, still in staging, is then taken off the
 * line by a save of that alone (`leaveLine`), so the line is not left waiting on a unit that will not serve it
 * (sourcing counts the units on a line), and the task closed as failed again moves it on (domain/staging `closureMoveProblem` lets it).
 * One the platform keeps on the line too leaves the line as it is, waiting on it.
 */
function failStaging(asset: GlideRecord, number: string): string | null {
    const lineId = str(asset, 'x_daas_ham_order_line')
    takeOffOrderLine(asset)
    if (moveAndSave(asset, 'pending_evaluation', `staging ${number} failed`)) {
        if (lineId) lineLostUnit(lineId)
        return null
    }
    const offLine = !lineId || leaveLine(asset.getUniqueValue(), lineId, number)
    if (offLine && lineId) lineLostUnit(lineId)
    const stays = offLine ? 'it stays in staging' : 'it stays in staging on its order line, which waits on it'
    return `${str(asset, 'serial_number')} not moved to pending evaluation (see the system log): ${stays}; reopen ${number} and close it as failed again`
}

/**
 * Take the unit off `lineId` and nothing else, read afresh (the refused record keeps its unsaved move); false when the
 * platform refuses (logged). A unit gone, or no longer on that line, is off it.
 */
function leaveLine(assetId: string, lineId: string, number: string): boolean {
    const asset = findById('alm_hardware', assetId)
    if (!asset || str(asset, 'x_daas_ham_order_line') !== lineId) return true
    takeOffOrderLine(asset)
    if (asset.update()) return true
    warnRefused(asset, `staging ${number} failed: ${str(asset, 'serial_number')} not taken off its order line`)
    return false
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
 * Copies the template's steps onto the task, each automated one in its initialAutomationStatus. A step's automation
 * is kept only when a run can send it to `vendor` (claimRouted): one it cannot would never be sent, failed or listed to
 * do by hand, and a step waiting for it would wait for ever. Stops at the first step the platform refuses and says
 * why; null when every step was saved.
 */
function copyTemplateSteps(templateId: string, taskId: string, vendor: string): string | null {
    const item = new GlideRecord('x_daas_ham_staging_tmpl_item')
    item.addQuery('template', templateId)
    item.orderBy('order')
    item.query()
    const items: Array<{ label: string; order: number; mandatory: boolean; automation: string }> = []
    while (item.next()) {
        const automation = str(item, 'automation')
        items.push({ label: str(item, 'label'), order: num(item, 'order'), mandatory: bool(item, 'mandatory'), automation: claimRouted(vendor, automation) ? automation : '' })
    }
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
