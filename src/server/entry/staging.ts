import { GlideDateTime, gs, type GlideRecord } from '@servicenow/glide'
import { stagingOutcome } from '../domain/staging.ts'
import type { StagingResult } from '../domain/vocabulary.ts'
import { releaseStepsWaitingOn } from '../platform/claim-steps.ts'
import { bool, choice, str } from '../platform/records.ts'
import { completeStaging, stagingSteps } from '../platform/staging-tasks.ts'

/** Before-update rule on staging steps: stamp who completed a step and when. */
export function stampStagingStep(current: GlideRecord): void {
    if (bool(current, 'done')) {
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
    if (choice<StagingResult>(current, 'result') === 'failed') return
    const outcome = stagingOutcome(stagingSteps(current.getUniqueValue()))
    if (!outcome.complete) {
        gs.addErrorMessage(`${outcome.remaining} mandatory staging step(s) are still open`)
        current.setAbortAction(true)
    }
}

/** After-update rule on staging tasks closed complete: the Asset is staged, or goes for evaluation if it failed. */
export function onStagingClosed(current: GlideRecord): void {
    completeStaging(str(current, 'asset'), str(current, 'number'), choice<StagingResult>(current, 'result') === 'failed')
}
