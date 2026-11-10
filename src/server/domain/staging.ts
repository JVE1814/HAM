import type { Stage } from './lifecycle.ts'
import { TASK_STATE, type StagingSource } from './vocabulary.ts'

/** Staging: choosing the checklist for an Asset and telling when it is done. */

/** How an Asset is staged when nothing says otherwise: by the Provider, in house. */
export const DEFAULT_STAGING_SOURCE: StagingSource = 'in_house'

export interface StagingTemplateView {
    id: string
    name: string
    customerId: string
    manufacturerId: string
    deviceClass: string
    source: StagingSource
    active: boolean
}

export interface StagingSubject {
    customerId: string
    manufacturerId: string
    deviceClass: string
    source: StagingSource
}

/** The most specific active template whose non-blank fields all match (customer > manufacturer > device class). */
export function selectStagingTemplate(templates: readonly StagingTemplateView[], subject: StagingSubject): string | null {
    const fits = (field: string, value: string) => field === '' || field === value
    const score = (t: StagingTemplateView) => (t.customerId ? 4 : 0) + (t.manufacturerId ? 2 : 0) + (t.deviceClass ? 1 : 0)
    const best = templates
        .filter(
            (t) =>
                t.active &&
                t.source === subject.source &&
                fits(t.customerId, subject.customerId) &&
                fits(t.manufacturerId, subject.manufacturerId) &&
                fits(t.deviceClass, subject.deviceClass),
        )
        .sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name))[0]
    return best?.id ?? null
}

export function stagingOutcome(steps: ReadonlyArray<{ mandatory: boolean; done: boolean }>): { complete: boolean; remaining: number } {
    const remaining = steps.filter((s) => s.mandatory && !s.done).length
    return { complete: remaining === 0, remaining }
}

/** A Staging task just closed: its number, the Order line it stages for (none on one made by hand), whether it failed. */
export interface ClosedStagingTask {
    number: string
    lineId: string
    failed: boolean
}

/**
 * Why closing `task` moves nothing on its Asset (said to the user), or null when it moves it. The unit must be on the
 * task's Order line (a task with none acts on the unit's own), or off any line in staging after a failed close the
 * platform refused (platform/staging-tasks `failStaging`): one on another line, or released, no longer waits on this
 * task. And it must be in staging, or reserved for that line. One in transfer stays on its line: received at the
 * staging centre with its task open, it goes into staging (domain/lifecycle `stageAfterTransfer`), and the task is
 * closed then. From any other stage the lifecycle moves it neither to staged nor to pending evaluation, so closing the
 * task again cannot help.
 */
export function unmovedByClosing(task: ClosedStagingTask, unit: { serial: string; lineId: string; stage: Stage | null }): string | null {
    const leftLine = task.failed && unit.stage === 'staging' && !unit.lineId
    if (task.lineId && unit.lineId !== task.lineId && !leftLine) {
        return `${unit.serial} is no longer on the order line ${task.number} stages for: closing it moved nothing`
    }
    if (unit.stage === 'staging' || unit.stage === 'reserved') return null
    if (unit.stage === 'in_transfer') {
        return (
            `${unit.serial} is still in transfer to the staging centre: closing ${task.number} moved nothing and the unit stays on its order line. ` +
            `Reopen ${task.number}: the unit goes into staging when the staging centre receives it; close the task then`
        )
    }
    return `${unit.serial} is ${unit.stage ?? 'in a stage this app does not model'}, not in staging: closing ${task.number} moved nothing`
}

/** The platform's task states a Staging task is closed with: Closed Complete once staged, Closed Skipped when its unit left staging. */
export const STAGING_TASK_STATE = { closed: TASK_STATE.closedComplete, skipped: TASK_STATE.closedSkipped } as const
