import { gs, type GlideRecord } from '@servicenow/glide'
import { stagingClosing, type ClosedStagingTask } from '../domain/staging.ts'
import type { StagingResult } from '../domain/vocabulary.ts'
import { releaseStepsWaitingOn } from '../platform/claim-steps.ts'
import { nowGlide } from '../platform/clock.ts'
import { bool, choice, str } from '../platform/records.ts'
import { abortWith } from '../platform/rule-api.ts'
import { completeStaging, stagingClosureProblem } from '../platform/staging-tasks.ts'

export function stampStagingStep(current: GlideRecord): void {
    if (bool(current, 'done')) {
        current.setValue('done_by', gs.getUserID())
        current.setValue('done_at', nowGlide())
    } else {
        current.setValue('done_by', '')
        current.setValue('done_at', '')
    }
}

export function releaseWaitingSteps(current: GlideRecord): void {
    releaseStepsWaitingOn(str(current, 'staging_task'), str(current, 'automation'))
}

export function guardStagingClosure(current: GlideRecord): void {
    const closing = stagingClosing(str(current, 'state'))
    if (closing) abortWith(current, stagingClosureProblem(current, closedTask(current), closing))
}

function closedTask(current: GlideRecord): ClosedStagingTask {
    return { number: str(current, 'number'), lineId: str(current, 'order_line'), failed: choice<StagingResult>(current, 'result') === 'failed' }
}

export function onStagingClosed(current: GlideRecord): void {
    const unmoved = completeStaging(str(current, 'asset'), closedTask(current))
    if (unmoved) gs.addErrorMessage(unmoved)
}
