// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.
import { GlideAggregate, GlideRecord, gs } from '@servicenow/glide'
import { fleetCondition } from '../domain/fleet.ts'
import { DEPLOYED_STAGES, stagesQuery } from '../domain/lifecycle.ts'
import {
    fleetOnRawModelQuery,
    RAW_MODEL_TABLE,
    rawModelsToNormalizeQuery,
    siteCiOnRawModelQuery,
} from '../domain/normalization.ts'
import { runTableJob } from '../platform/chunked.ts'
import { todayIso } from '../platform/clock.ts'
import { EVENT, fire } from '../platform/events.ts'
import { refreshLifecycleDates } from '../platform/lifecycle-dates.ts'
import { queueModelRefresh, queueModelsReachingMilestone, writingModelLifecycle } from '../platform/model-lifecycle.ts'
import {
    closeNonNaasExceptions,
    learnFromResolution,
    loadNormalizationData,
    recordNormalizationException,
    resolveModel,
} from '../platform/normalization.ts'
import { refusal, str } from '../platform/records.ts'

/** Model normalization and Lifecycle phase / Refresh due date upkeep (P1.2), for fleet assets only (ADR 0016). */

/**
 * Scheduled job: map onto canonical Models the raw hardware models that are NaaS's (ADR 0016): those Discovery and
 * connectors put fleet assets on, and those of the network gear reconciliation reports *seen without asset* at a
 * customer Site, whose Asset joins the fleet on the canonical Model. A raw model only the Provider IT's equipment is on
 * (its laptops, printers, servers) is not NaaS's to map, so it is neither mapped nor raised as a normalization
 * exception, and an exception an earlier run raised for one is closed.
 */
export function normalizeRawModels(): void {
    const naas = [
        ...distinctValues('alm_hardware', fleetOnRawModelQuery(), 'model'),
        ...distinctValues('cmdb_ci_netgear', siteCiOnRawModelQuery(), 'model_id'),
    ]
    closeNonNaasExceptions(naas)
    const query = rawModelsToNormalizeQuery(naas)
    // No raw model is NaaS's: nothing to map.
    if (!query) return
    const data = loadNormalizationData()
    runTableJob({
        job: 'normalize_raw_models',
        table: RAW_MODEL_TABLE,
        query,
        read: (model) => ({ manufacturer: str(model, 'manufacturer.name'), model: str(model, 'name') }),
        handle: (raw, rawModelId) => {
            const resolution = resolveModel(raw, data)
            if (!resolution.modelId) {
                recordNormalizationException(raw, 'reason' in resolution ? resolution.reason : '', {
                    table: RAW_MODEL_TABLE,
                    id: rawModelId,
                })
                return
            }
            repointModel(rawModelId, resolution.modelId)
        },
    })
}

/** The distinct values of `field` among the rows of `table` that `query` matches, read with one aggregate query. */
function distinctValues(table: string, query: string, field: string): string[] {
    const ga = new GlideAggregate(table)
    ga.addEncodedQuery(query)
    ga.addAggregate('COUNT', '')
    ga.groupBy(field)
    ga.query()
    const values: string[] = []
    while (ga.next()) values.push(String(ga.getValue(field) ?? ''))
    return values
}

/**
 * Point the raw model's fleet assets at the canonical Model, then mark the raw model normalized. Marked, it leaves the
 * job's query, so an Asset whose save is refused leaves it unmarked for the next run to repoint. The Provider IT's
 * Assets on the raw model are left on it (ADR 0016).
 */
function repointModel(rawModelId: string, canonicalModelId: string): void {
    const raw = new GlideRecord('cmdb_model')
    if (!raw.get(rawModelId)) return
    let refused = 0
    const asset = new GlideRecord('alm_hardware')
    asset.addQuery('model', rawModelId)
    asset.addEncodedQuery(fleetCondition())
    asset.query()
    while (asset.next()) {
        asset.setValue('model', canonicalModelId)
        if (asset.update()) continue
        refused++
        const reason = refusal(asset)
        gs.warn(`[x_daas_ham] Model normalization: ${str(asset, 'serial_number')} left on its raw model: ${reason}`)
    }
    if (refused > 0) return
    raw.setValue('x_daas_ham_normalized_to', canonicalModelId)
    raw.update()
}

/**
 * After-update rule on normalization exceptions given a resolved model: learn a rule from it. One whose alias or rule
 * is refused stays open, as nothing maps its raw pair yet.
 */
export function onNormalizationResolved(current: GlideRecord): void {
    if (!learnFromResolution(current, loadNormalizationData())) {
        const retry = 'clear its resolved model and set it again to retry'
        return void gs.addErrorMessage(`No rule learned (see the system log), so the exception stays open: ${retry}`)
    }
    current.setValue('status', 'resolved')
    current.update()
}

/**
 * After insert/update rule on the platform's Model lifecycle table (ADR 0017), for a NaaS Model's row whose milestone
 * changed (the rule's condition): recompute that Model's fleet assets in the background. A save the app's own write
 * makes is left to that write, which queues the pass once for all the milestones it saves.
 */
export function onModelLifecycleChanged(current: GlideRecord): void {
    if (!writingModelLifecycle(str(current, 'model'))) queueModelRefresh(current)
}

/**
 * Script action on x_daas_ham.model.lifecycle (parm1 = model, parm2 = cursor): the Model's fleet assets not retired
 * (platform/lifecycle-dates keeps the pass to the fleet, so the Provider IT's units of the Model are not stamped).
 */
export function refreshModelAssets(event: GlideRecord, current: GlideRecord): void {
    const modelId = str(event, 'parm1')
    refreshLifecycleDates({
        eventName: EVENT.lifecycleChanged,
        record: current,
        parm1: modelId,
        cursor: str(event, 'parm2'),
        query: `model=${modelId}^install_status!=7`,
    })
}

/** Daily job: models crossing a milestone today change phase without any record changing. */
export function rollLifecyclePhases(): void {
    queueModelsReachingMilestone(todayIso())
}

/** After-update rule on Agreements whose refresh terms changed. */
export function onAgreementTermsChanged(current: GlideRecord): void {
    fire(EVENT.agreementTermsChanged, current, current.getUniqueValue(), '')
}

/** Script action on x_daas_ham.agreement.terms (parm1 = agreement, parm2 = cursor): its deployed fleet assets. */
export function refreshAgreementAssets(event: GlideRecord, current: GlideRecord): void {
    const agreementId = str(event, 'parm1')
    refreshLifecycleDates({
        eventName: EVENT.agreementTermsChanged,
        record: current,
        parm1: agreementId,
        cursor: str(event, 'parm2'),
        query: stagesQuery(DEPLOYED_STAGES, `x_daas_ham_agreement=${agreementId}`),
    })
}
