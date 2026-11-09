import { GlideDateTime, GlideRecord, gs } from '@servicenow/glide'
import { lineStillOpen } from '../domain/sourcing.ts'
import {
    closureMoveProblem,
    newerTask,
    stageOnClosure,
    stagingClosureRefusal,
    type ClosingAsset,
    type ClosingTask,
    type OpenedTask,
} from '../domain/staging.ts'
import { moveAndSave, readStage } from '../platform/assets.ts'
import { releaseStepsWaitingOn } from '../platform/claim-steps.ts'
import { recomputeLine } from '../platform/fulfilment.ts'
import { findById, refusal, str } from '../platform/records.ts'
import { stagingSteps } from '../platform/staging-tasks.ts'
import { resourceOrder } from './orders.ts'

function orderOfLine(lineId: string): string {
    const line = findById('x_daas_ham_order_line', lineId)
    return line ? str(line, 'order') : ''
}

// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.

/** Before-update rule on staging steps: stamp who completed a step and when. */
export function stampStagingStep(current: GlideRecord): void {
    if (str(current, 'done') === '1' || str(current, 'done') === 'true') {
        current.setValue('done_by', gs.getUserID())
        current.setValue('done_at', new GlideDateTime().getValue())
    } else {
        current.setValue('done_by', '')
        current.setValue('done_at', '')
    }
}

/** After-update rule on automated staging steps ticked done: release the steps waiting on this one (releaseStepsWaitingOn). */
export function releaseWaitingSteps(current: GlideRecord): void {
    releaseStepsWaitingOn(str(current, 'staging_task'), str(current, 'automation'))
}

/** How a task state closes it: Closed Complete moves its Asset; Closed Incomplete and Closed Skipped move nothing. */
const CLOSING: Record<string, ClosingTask['closing']> = { '3': 'complete', '4': 'skipped', '7': 'skipped' }

/**
 * Before-update rule on Staging tasks being closed: refused, with what to do, while closing cannot move the Asset to the
 * stage it sends it to, or would leave a unit that still needs the task without one (domain/staging
 * `stagingClosureRefusal`). The rule's condition decides which closed states reach it (logic/rules.now.ts). Only
 * reads, with the user's visibility, as `onStagingClosed` reads the Asset: an inventory tech sees a task only while its
 * Asset is in their stockrooms (ADR 0005), so they see the Asset too.
 */
export function guardStagingClosure(current: GlideRecord): void {
    const closing = CLOSING[str(current, 'state')]
    if (!closing) return
    const task: ClosingTask = { ...closedTask(current), closing, newerTask: newerTaskThan(current) }
    const asset = findById('alm_hardware', str(current, 'asset'))
    const checklist = closing === 'complete' && !task.failed ? stagingSteps(current.getUniqueValue()) : []
    const refused = stagingClosureRefusal(task, asset && closingAsset(asset), checklist)
    if (!refused) return
    gs.addErrorMessage(refused)
    current.setAbortAction(true)
}

/** The task as both closure rules read it. */
function closedTask(current: GlideRecord): Pick<ClosingTask, 'number' | 'lineId' | 'failed'> {
    return { number: str(current, 'number'), lineId: str(current, 'order_line'), failed: str(current, 'result') === 'failed' }
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
 * After-update rule on staging tasks closed complete: the Asset is staged, or goes for evaluation if it failed. The
 * before rule (`guardStagingClosure`) let the closure through only for a unit it moves; one changed between the two
 * rules is left as it is and the user told why (domain/staging `closureMoveProblem`). A unit still reserved for the
 * task's line, its move into staging refused when the task opened (entry/warehouse `stageReserved`), is moved into
 * staging first (`enterStaging`). A move the platform refuses (moveAndSave warns) is reported to the user, who reopens
 * the task and closes it again to retry: the task is closed by then, and nothing else moves the unit on. A task closed
 * again once its move is made moves nothing more.
 */
export function onStagingClosed(current: GlideRecord): void {
    const asset = findById('alm_hardware', str(current, 'asset'))
    if (!asset) return
    const task = closedTask(current)
    const stage = readStage(asset)
    if (stage === stageOnClosure(task.failed)) return
    const unmoved = closureMoveProblem(task, closingAsset(asset))
    if (unmoved) return void gs.addErrorMessage(`${task.number} is closed but moved nothing (reopen it to close it again): ${unmoved}`)
    if (stage === 'reserved' && !enterStaging(asset, task.number)) return
    if (task.failed) return failStaging(asset, task.number)
    if (moveAndSave(asset, 'staged', `staging ${task.number}`)) return
    // Refused, the unit stays in staging and its line waits on it.
    gs.addErrorMessage(`${str(asset, 'serial_number')} not moved to staged (see the system log): it stays in staging; reopen ${task.number} and close it again`)
}

/**
 * Move a unit reserved for the task's line into staging, which its task stands for: false when the platform refuses
 * (moveAndSave warns; the lifecycle allows it), the user told, and it stays reserved for its line.
 */
function enterStaging(asset: GlideRecord, number: string): boolean {
    if (moveAndSave(asset, 'staging', `staging ${number}`)) return true
    gs.addErrorMessage(`${str(asset, 'serial_number')} not moved into staging (see the system log): it stays reserved for its order line; reopen ${number} and close it again`)
    return false
}

/**
 * A unit that failed staging leaves its Order line, which is derived and sourced again, and awaits evaluation, in one
 * save. The lifecycle allows that move from staging, so only the platform refuses it: the unit, still in staging, is
 * then taken off the line by a save of that alone (`leaveLine`), so the line is not left waiting on a unit that will
 * not serve it (sourcing counts the units on a line, entry/orders), and the task closed as failed again moves it on
 * (domain/staging `closureMoveProblem` lets it). One the platform keeps on the line too leaves the line as it is, waiting on it.
 */
function failStaging(asset: GlideRecord, number: string): void {
    const lineId = str(asset, 'x_daas_ham_order_line')
    asset.setValue('x_daas_ham_order_line', '')
    if (moveAndSave(asset, 'pending_evaluation', `staging ${number} failed`)) return sourceLineAgain(lineId)
    const offLine = !lineId || leaveLine(asset.getUniqueValue(), lineId, number)
    const stays = offLine ? 'it stays in staging' : 'it stays in staging on its order line, which waits on it'
    gs.addErrorMessage(`${str(asset, 'serial_number')} not moved to pending evaluation (see the system log): ${stays}; reopen ${number} and close it as failed again`)
    if (offLine) sourceLineAgain(lineId)
}

/** The line a unit left is derived again and its Order sourced again (queued). */
function sourceLineAgain(lineId: string): void {
    if (!lineId) return
    recomputeLine(lineId)
    resourceOrder(orderOfLine(lineId))
}

/**
 * Take the unit off `lineId` and nothing else, read afresh (the refused record keeps its unsaved move); false when the
 * platform refuses (logged). A unit gone, or no longer on that line, is off it.
 */
function leaveLine(assetId: string, lineId: string, number: string): boolean {
    const asset = findById('alm_hardware', assetId)
    if (!asset || str(asset, 'x_daas_ham_order_line') !== lineId) return true
    asset.setValue('x_daas_ham_order_line', '')
    if (asset.update()) return true
    gs.warn(`[x_daas_ham] staging ${number} failed: ${str(asset, 'serial_number')} not taken off its order line: ${refusal(asset)}`)
    return false
}
