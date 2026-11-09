import { GlideDateTime, gs, type GlideRecord } from '@servicenow/glide'
import type { Stage } from '../domain/lifecycle.ts'
import { stagingOutcome } from '../domain/staging.ts'
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

/** Before-update rule on staging tasks being closed: every mandatory step must be done unless it failed. */
export function guardStagingClosure(current: GlideRecord): void {
    if (str(current, 'result') === 'failed') return
    const outcome = stagingOutcome(stagingSteps(current.getUniqueValue()))
    if (!outcome.complete) {
        gs.addErrorMessage(`${outcome.remaining} mandatory staging step(s) are still open`)
        current.setAbortAction(true)
    }
}

/** A Staging task just closed: its number, the Order line it stages for (none on one made by hand), whether it failed. */
interface ClosedTask {
    number: string
    lineId: string
    failed: boolean
}

/**
 * After-update rule on staging tasks closed complete: the Asset is staged, or goes for evaluation if it failed. Only a
 * unit the task still stands for moves (`unmovedBy`); any other is left as it is and the user told why. A unit still
 * reserved for the task's line, its move into staging refused when the task opened (entry/warehouse `stageReserved`),
 * is moved into staging first (`enterStaging`). A move the platform refuses (moveAndSave warns) is reported to the
 * user, who reopens the task and closes it again to retry: the task is closed by then, and nothing else moves the unit
 * on. A task closed again once its move is made moves nothing more.
 */
export function onStagingClosed(current: GlideRecord): void {
    const asset = findById('alm_hardware', str(current, 'asset'))
    if (!asset) return
    const task: ClosedTask = { number: str(current, 'number'), lineId: str(current, 'order_line'), failed: str(current, 'result') === 'failed' }
    const stage = readStage(asset)
    if (stage === (task.failed ? 'pending_evaluation' : 'staged')) return
    const unmoved = unmovedBy(task, asset, stage)
    if (unmoved) return void gs.addErrorMessage(unmoved)
    if (stage === 'reserved' && !enterStaging(asset, task.number)) return
    if (task.failed) return failStaging(asset, task.number)
    if (moveAndSave(asset, 'staged', `staging ${task.number}`)) return
    // Refused, the unit stays in staging and its line waits on it.
    gs.addErrorMessage(`${str(asset, 'serial_number')} not moved to staged (see the system log): it stays in staging; reopen ${task.number} and close it again`)
}

/**
 * Why closing `task` moves nothing on its Asset (said to the user), or null when it moves it. The unit must be on the
 * task's Order line (a task with none acts on the unit's own), or off any line in staging after a failed close the
 * platform refused (`failStaging`): one on another line, or released, no longer waits on this task. And it must be in
 * staging, or reserved for that line. One in transfer stays on its line: received at the staging centre with its task
 * open, it goes into staging (domain/lifecycle `stageAfterTransfer`), and the task is closed then. From any other stage
 * the lifecycle moves it neither to staged nor to pending evaluation, so closing the task again cannot help.
 */
function unmovedBy(task: ClosedTask, asset: GlideRecord, stage: Stage | null): string | null {
    const serial = str(asset, 'serial_number')
    const lineId = str(asset, 'x_daas_ham_order_line')
    const leftLine = task.failed && stage === 'staging' && !lineId
    if (task.lineId && lineId !== task.lineId && !leftLine) {
        return `${serial} is no longer on the order line ${task.number} stages for: closing it moved nothing`
    }
    if (stage === 'staging' || stage === 'reserved') return null
    if (stage === 'in_transfer') {
        return (
            `${serial} is still in transfer to the staging centre: closing ${task.number} moved nothing and the unit stays on its order line. ` +
            `Reopen ${task.number}: the unit goes into staging when the staging centre receives it; close the task then`
        )
    }
    return `${serial} is ${stage ?? 'in a stage this app does not model'}, not in staging: closing ${task.number} moved nothing`
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
 * (`unmovedBy` lets it). One the platform keeps on the line too leaves the line as it is, waiting on it.
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
