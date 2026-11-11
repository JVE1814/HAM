import { gs, type GlideRecord } from '@servicenow/glide'
import { stagingClosing, type ClosedStagingTask } from '../domain/staging.ts'
import type { StagingResult } from '../domain/vocabulary.ts'
import { releaseStepsWaitingOn } from '../platform/claim-steps.ts'
import { nowGlide } from '../platform/clock.ts'
import { bool, choice, str } from '../platform/records.ts'
import { abortWith } from '../platform/rule-api.ts'
import { completeStaging, stagingClosureProblem } from '../platform/staging-tasks.ts'

/** Before-update rule on staging steps: stamp who completed a step and when. */
export function stampStagingStep(current: GlideRecord): void {
    if (bool(current, 'done')) {
        current.setValue('done_by', gs.getUserID())
        current.setValue('done_at', nowGlide())
    } else {
        current.setValue('done_by', '')
        current.setValue('done_at', '')
    }
}

/** After-update rule on automated staging steps ticked done: release the steps waiting on this one (releaseStepsWaitingOn). */
export function releaseWaitingSteps(current: GlideRecord): void {
    releaseStepsWaitingOn(str(current, 'staging_task'), str(current, 'automation'))
}

/**
 * Before-update rule on Staging tasks being closed: refused, with what to do, while closing cannot move the Asset to the
 * stage it sends it to, or would leave a unit that still needs the task without one (platform/staging-tasks
 * `stagingClosureProblem`). The rule's condition decides which closed states reach it (staging/logic.now.ts).
 */
export function guardStagingClosure(current: GlideRecord): void {
    const closing = stagingClosing(str(current, 'state'))
    if (closing) abortWith(current, stagingClosureProblem(current, closedTask(current), closing))
}

/** The task as both closure rules read it. */
function closedTask(current: GlideRecord): ClosedStagingTask {
    return { number: str(current, 'number'), lineId: str(current, 'order_line'), failed: choice<StagingResult>(current, 'result') === 'failed' }
}

/**
 * After-update rule on staging tasks closed complete: the Asset is staged, or goes for evaluation if it failed. The
 * user is told when closing the task did not move its unit on, and what to do then (platform/staging-tasks
 * `completeStaging`).
 */
export function onStagingClosed(current: GlideRecord): void {
    const unmoved = completeStaging(str(current, 'asset'), closedTask(current))
    if (unmoved) gs.addErrorMessage(unmoved)
}
