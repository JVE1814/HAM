import { GlideDateTime, gs, type GlideRecord } from '@servicenow/glide'
import { stagingOutcome } from '../domain/staging'
import { moveAndSave } from '../platform/assets'
import { releaseStepsWaitingOn } from '../platform/claim-steps'
import { recomputeLine } from '../platform/fulfilment'
import { findById, str } from '../platform/records'
import { stagingSteps } from '../platform/staging-tasks'
import { resourceOrder } from './orders'

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

/** After-update rule on staging tasks closed complete: the Asset is staged, or goes for evaluation if it failed. */
export function onStagingClosed(current: GlideRecord): void {
    const asset = findById('alm_hardware', str(current, 'asset'))
    if (!asset) return
    if (str(current, 'result') === 'failed') {
        const lineId = str(asset, 'x_daas_ham_order_line')
        asset.setValue('x_daas_ham_order_line', '')
        moveAndSave(asset, 'pending_evaluation', `staging ${str(current, 'number')} failed`)
        if (lineId) {
            recomputeLine(lineId)
            resourceOrder(orderOfLine(lineId))
        }
        return
    }
    moveAndSave(asset, 'staged', `staging ${str(current, 'number')}`)
}
