import { gs, type GlideRecord } from '@servicenow/glide'
import { todayIso } from '../platform/clock.ts'
import { queueRefresh, runRefreshPass } from '../platform/lifecycle-dates.ts'
import { queueModelRefresh, queueModelsReachingMilestone, writingModelLifecycle } from '../platform/model-lifecycle.ts'
import { normalizeNaasRawModels, resolveNormalizationException } from '../platform/normalization.ts'
import { str, type ForeignRecord } from '../platform/records.ts'

/** Model normalization and Lifecycle phase / Refresh due date upkeep (P1.2), for fleet assets only (ADR 0016). */

/** Scheduled job: map the raw hardware models that are NaaS's onto canonical Models (platform/normalization). */
export function normalizeRawModels(): void {
    normalizeNaasRawModels()
}

/**
 * After-update rule on normalization exceptions given a resolved model: learn a rule from it. One whose alias or rule
 * is refused stays open, as nothing maps its raw pair yet. One learned whose resolution the platform refuses stays open
 * too (platform/normalization `resolveNormalizationException`): the user sets it resolved by hand.
 */
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

/**
 * Script action on x_daas_ham.model.lifecycle (parm1 = model, parm2 = cursor): the Model's fleet assets not retired
 * (platform/lifecycle-dates keeps the pass to the fleet, so the Provider IT's units of the Model are not stamped).
 */
export function refreshModelAssets(event: GlideRecord, current: GlideRecord): void {
    runRefreshPass('model', event, current)
}

/** Daily job: models crossing a milestone today change phase without any record changing. */
export function rollLifecyclePhases(): void {
    queueModelsReachingMilestone(todayIso())
}

/** After-update rule on Agreements whose refresh terms changed. */
export function onAgreementTermsChanged(current: GlideRecord): void {
    queueRefresh('agreement', current)
}

/** Script action on x_daas_ham.agreement.terms (parm1 = agreement, parm2 = cursor): its deployed fleet assets. */
export function refreshAgreementAssets(event: GlideRecord, current: GlideRecord): void {
    runRefreshPass('agreement', event, current)
}
