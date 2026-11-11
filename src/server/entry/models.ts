import { gs, type GlideRecord } from '@servicenow/glide'
import { todayIso } from '../platform/clock.ts'
import { queueRefresh, runRefreshPass } from '../platform/lifecycle-dates.ts'
import { importLifecycleRow, queueModelRefresh, queueModelsReachingMilestone, writingModelLifecycle } from '../platform/model-lifecycle.ts'
import { normalizeNaasRawModels, resolveNormalizationException } from '../platform/normalization.ts'
import { finishImportRow, str, type ForeignRecord } from '../platform/records.ts'

/** Model normalization, the lifecycle CSV, and Lifecycle phase / Refresh due date upkeep (P1.2), for fleet assets only (ADR 0016). */

export function normalizeRawModels(): void {
    normalizeNaasRawModels()
}

export function onNormalizationResolved(current: GlideRecord): void {
    const resolution = resolveNormalizationException(current)
    if (!resolution.learned) {
        const retry = 'clear its resolved model and set it again to retry'
        return void gs.addErrorMessage(`No rule learned (see the system log), so the exception stays open: ${retry}`)
    }
    if (!resolution.unresolved) return
    gs.addErrorMessage(`The rule was learned, but the exception was not saved as resolved (${resolution.unresolved}): set its status to Resolved`)
}

/**
 * After rule on the platform's Model lifecycle table (ADR 0017), for a row inserted, deleted or changed in what a
 * Model's milestones are read from (the rule's condition): recompute the fleet assets of its Model in the background,
 * and of the Model it left when the row moved to another. A save the app's own write makes is left to that write,
 * which queues the pass once for all the milestones it saves.
 */
export function onModelLifecycleChanged(current: ForeignRecord, previous: ForeignRecord | null): void {
    const modelIds = new Set([str(current, 'model'), previous ? str(previous, 'model') : ''])
    for (const modelId of modelIds) {
        if (modelId && !writingModelLifecycle(modelId)) queueModelRefresh(modelId)
    }
}

export function refreshModelAssets(event: GlideRecord, current: GlideRecord): void {
    runRefreshPass('model', event, current)
}

/** Daily job: models crossing a milestone today change phase without any record changing. */
export function rollLifecyclePhases(): void {
    queueModelsReachingMilestone(todayIso())
}

export function processLifecycleRow(current: GlideRecord): void {
    finishImportRow(current, importLifecycleRow(current))
}

export function onAgreementTermsChanged(current: GlideRecord): void {
    queueRefresh('agreement', current)
}

export function refreshAgreementAssets(event: GlideRecord, current: GlideRecord): void {
    runRefreshPass('agreement', event, current)
}
