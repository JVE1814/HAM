import type { Stage } from './lifecycle.ts'
import { TASK_STATE, type StagingSource } from './vocabulary.ts'

/** How an Asset is staged when nothing says otherwise: by the Provider, in house. */
export const DEFAULT_STAGING_SOURCE: StagingSource = 'in_house'

export interface StagingTemplateView {
    id: string
    name: string
    customerId: string
    manufacturerId: string
    deviceClass: string
    source: StagingSource
}

export interface StagingSubject {
    customerId: string
    manufacturerId: string
    deviceClass: string
    source: StagingSource
}

/** The most specific template whose non-blank fields all match (customer > manufacturer > device class). */
export function selectStagingTemplate(templates: readonly StagingTemplateView[], subject: StagingSubject): string | null {
    const fits = (field: string, value: string) => field === '' || field === value
    const score = (t: StagingTemplateView) => (t.customerId ? 4 : 0) + (t.manufacturerId ? 2 : 0) + (t.deviceClass ? 1 : 0)
    const best = templates
        .filter(
            (t) =>
                t.source === subject.source &&
                fits(t.customerId, subject.customerId) &&
                fits(t.manufacturerId, subject.manufacturerId) &&
                fits(t.deviceClass, subject.deviceClass),
        )
        .sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name))[0]
    return best?.id ?? null
}

/** The stage closing a Staging task complete sends its Asset to: staged, or pending evaluation when it failed. */
export function stageOnClosure(failed: boolean): Stage {
    return failed ? 'pending_evaluation' : 'staged'
}

export interface ClosingTask {
    number: string
    /** Closed Complete, which moves the Asset; or Closed Incomplete or Skipped, which move nothing (`stagingClosing`). */
    closing: StagingClosing
    failed: boolean
    /** The Order line it stages for; '' on a task made by hand, which acts on the unit's own line. */
    lineId: string
    /** A newer open Staging task of the same Asset (`newerTask`), which stands for it instead; '' for none. */
    newerTask: string
}

export type ClosedStagingTask = Pick<ClosingTask, 'number' | 'failed' | 'lineId'>

export interface ClosingAsset {
    serial: string
    stage: Stage | null
    /** Its Order line; '' for none. */
    lineId: string
    /** Whether that line still waits to be filled (domain/fulfilment `lineStillOpen`). */
    lineOpen: boolean
}

/**
 * Why closing `task` complete cannot move `asset` to the stage closing sends it to (`stageOnClosure`), with what to do,
 * or null when it can (into staging first when still reserved for the line, its move into staging refused when the
 * task opened) or it is there already, which moves nothing. Otherwise the unit must be on the task's line, or in staging
 * off any line after a failed close whose move the platform refused (platform/staging-tasks `failStaging`): one on
 * another line, or released, no longer waits on this task. And it must be in staging, or reserved for the line. One in
 * transfer goes into staging only once the staging centre receives it with its task open (domain/lifecycle
 * `stageAfterTransfer`); closed before, the task would leave it reserved there with no task to move it on. From any
 * other stage the lifecycle moves it neither to staged nor to pending evaluation.
 */
export function closureMoveProblem(task: ClosedStagingTask, asset: Pick<ClosingAsset, 'serial' | 'stage' | 'lineId'>): string | null {
    const { number } = task
    const to = stageOnClosure(task.failed)
    // Moved already (the task reopened and closed again): it moves nothing more.
    if (asset.stage === to) return null
    const failedRetry = task.failed && asset.stage === 'staging' && !asset.lineId
    if (task.lineId && asset.lineId !== task.lineId && !failedRetry) {
        return `${asset.serial} is no longer on the order line ${number} stages for: close ${number} skipped`
    }
    if (asset.stage === 'staging' || asset.stage === 'reserved') return null
    if (asset.stage === 'in_transfer') {
        return `${asset.serial} is still in transfer to the staging centre: close ${number} once the staging centre receives it`
    }
    const stage = asset.stage ?? 'in a stage this app does not model'
    return `${asset.serial} is ${stage}, not in staging, so closing ${number} cannot move it to ${to}: close ${number} skipped if it is no longer needed`
}

/**
 * Why `task` may not be closed as it is being closed (said to the user, with what to do), or null when it may.
 *
 * Closed complete, it must move its Asset (`closureMoveProblem`), and it must still stand for it: a unit put back and
 * sourced again under a newer task is staged against that task's checklist, not this one's. Unless it failed, every
 * mandatory step must be done. An Asset that cannot be read is refused: closing would move nothing.
 *
 * Closed skipped (or incomplete), it moves nothing, so it is refused only while the unit still needs it: on the task's
 * line, that line still open and no newer task, in transfer to the staging centre or in staging. Skipped then, the unit
 * would be left reserved for its line with no task, or in staging with none. The app's own skips pass: a cancel or
 * rejection saves its Order before it skips the tasks, and a unit put back leaves its line first. A reserved unit's
 * task may be skipped (sourcing skips it when its move into staging is refused).
 */
export function stagingClosureRefusal(
    task: ClosingTask,
    asset: ClosingAsset | null,
    steps: ReadonlyArray<{ mandatory: boolean; done: boolean }>,
): string | null {
    if (task.closing === 'skipped') return skipRefusal(task, asset)
    if (!asset) return `The asset of ${task.number} cannot be read: close ${task.number} skipped`
    if (task.newerTask) {
        return `${asset.serial} has a newer Staging task, ${task.newerTask}: close ${task.number} skipped and stage the unit under ${task.newerTask}`
    }
    const unmoved = closureMoveProblem(task, asset)
    if (unmoved || task.failed) return unmoved
    const remaining = steps.filter((step) => step.mandatory && !step.done).length
    return remaining > 0 ? `${remaining} mandatory staging step(s) are still open` : null
}

function skipRefusal(task: ClosingTask, asset: ClosingAsset | null): string | null {
    if (!asset || task.newerTask || !task.lineId || asset.lineId !== task.lineId || !asset.lineOpen) return null
    const { number } = task
    if (asset.stage === 'in_transfer') {
        return `${asset.serial} is in transfer to the staging centre for its order line, which needs ${number}: close ${number} complete once the staging centre receives it`
    }
    if (asset.stage === 'staging') {
        return `${asset.serial} is in staging for its order line, which needs ${number}: close ${number} complete, or failed to send the unit for evaluation`
    }
    return null
}

/** A Staging task as opened: its number and when (sys_created_on, 'yyyy-MM-dd HH:mm:ss'). */
export interface OpenedTask {
    number: string
    openedAt: string
}

/**
 * The number of the newest of `others` (open tasks of the same Asset) when it was opened after `task`, else '': that
 * one stands for the unit. Opened in the same second, the later number is the newer.
 */
export function newerTask(task: OpenedTask, others: readonly OpenedTask[]): string {
    // Task numbers grow in length past their padding, so a longer one is later.
    const numberAfter = (a: string, b: string) => a.length > b.length || (a.length === b.length && a > b)
    const after = (a: OpenedTask, b: OpenedTask) => a.openedAt > b.openedAt || (a.openedAt === b.openedAt && numberAfter(a.number, b.number))
    let newest = task
    for (const other of others) if (after(other, newest)) newest = other
    return newest === task ? '' : newest.number
}

/**
 * The platform's task states a Staging task is closed with: Closed Complete once staged, Closed Skipped when its unit
 * left staging (the app's own skips), and Closed Incomplete, which only a person sets.
 */
export const STAGING_TASK_STATE = {
    closed: TASK_STATE.closedComplete,
    incomplete: TASK_STATE.closedIncomplete,
    skipped: TASK_STATE.closedSkipped,
} as const

/** How closing a Staging task closes it: complete, which moves its Asset, or skipped (or incomplete), which moves nothing. */
export type StagingClosing = 'complete' | 'skipped'

/** How the task state `state` closes a Staging task (`STAGING_TASK_STATE`), or null for a state that leaves it open. */
export function stagingClosing(state: string): StagingClosing | null {
    if (state === String(STAGING_TASK_STATE.closed)) return 'complete'
    if (state === String(STAGING_TASK_STATE.incomplete) || state === String(STAGING_TASK_STATE.skipped)) return 'skipped'
    return null
}
