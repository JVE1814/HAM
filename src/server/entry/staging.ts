import { gs, type GlideRecord } from '@servicenow/glide'
import { stagingOutcome } from '../domain/staging.ts'
import type { StagingResult } from '../domain/vocabulary.ts'
import { releaseStepsWaitingOn } from '../platform/claim-steps.ts'
import { nowGlide } from '../platform/clock.ts'
import { bool, choice, str } from '../platform/records.ts'
import { abortWith } from '../platform/rule-api.ts'
import { completeStaging, stagingSteps } from '../platform/staging-tasks.ts'

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

/** Before-update rule on staging tasks being closed: every mandatory step must be done unless it failed. */
export function guardStagingClosure(current: GlideRecord): void {
    if (choice<StagingResult>(current, 'result') === 'failed') return
    const outcome = stagingOutcome(stagingSteps(current.getUniqueValue()))
    if (!outcome.complete) abortWith(current, `${outcome.remaining} mandatory staging step(s) are still open`)
}

/**
 * After-update rule on staging tasks closed complete: the Asset is staged, or goes for evaluation if it failed. The
 * user is told when closing the task did not move its unit on, and what to do then (platform/staging-tasks
 * `completeStaging`).
 */
export function onStagingClosed(current: GlideRecord): void {
    const unmoved = completeStaging(str(current, 'asset'), {
        number: str(current, 'number'),
        lineId: str(current, 'order_line'),
        failed: choice<StagingResult>(current, 'result') === 'failed',
    })
    if (unmoved) gs.addErrorMessage(unmoved)
}
