// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.
import { GlideRecord, gs } from '@servicenow/glide'
import { DEPLOYED_STAGES, stagesQuery } from '../domain/lifecycle'
import { runTableJob } from '../platform/chunked'
import { todayIso } from '../platform/clock'
import { EVENT, fire } from '../platform/events'
import { refreshLifecycleDates } from '../platform/lifecycle-dates'
import {
    learnFromResolution,
    loadNormalizationData,
    recordNormalizationException,
    resolveModel,
} from '../platform/normalization'
import { str } from '../platform/records'

/** Model normalization and Lifecycle phase / Refresh due date upkeep (P1.2). */

/** Scheduled job: map raw hardware models created by Discovery and connectors onto canonical Models. */
export function normalizeRawModels(): void {
    const data = loadNormalizationData()
    runTableJob({
        job: 'normalize_raw_models',
        table: 'cmdb_hardware_product_model',
        query: 'x_daas_ham_oem_pidISEMPTY^x_daas_ham_normalized_toISEMPTY',
        read: (model) => ({ manufacturer: str(model, 'manufacturer.name'), model: str(model, 'name') }),
        handle: (raw, rawModelId) => {
            const resolution = resolveModel(raw, data)
            if (!resolution.modelId) {
                recordNormalizationException(raw, 'reason' in resolution ? resolution.reason : '', {
                    table: 'cmdb_hardware_product_model',
                    id: rawModelId,
                })
                return
            }
            repointModel(rawModelId, resolution.modelId)
        },
    })
}

/**
 * Point the raw model's Assets at the canonical Model, then mark the raw model normalized. Marked, it leaves the job's
 * query, so an Asset whose save is refused leaves it unmarked for the next run to repoint.
 */
function repointModel(rawModelId: string, canonicalModelId: string): void {
    const raw = new GlideRecord('cmdb_model')
    if (!raw.get(rawModelId)) return
    let refused = 0
    const asset = new GlideRecord('alm_hardware')
    asset.addQuery('model', rawModelId)
    asset.query()
    while (asset.next()) {
        asset.setValue('model', canonicalModelId)
        if (asset.update()) continue
        refused++
        const reason = asset.getLastErrorMessage() || 'the save was refused'
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

/** After insert/update rule on Model lifecycle: recompute that model's assets in the background. */
export function onModelLifecycleChanged(current: GlideRecord): void {
    fire(EVENT.lifecycleChanged, current, str(current, 'model'), '')
}

/** Script action on x_daas_ham.model.lifecycle (parm1 = model, parm2 = cursor). */
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
    const today = todayIso()
    const lifecycle = new GlideRecord('x_daas_ham_model_lifecycle')
    lifecycle.addEncodedQuery(
        `end_of_sale=${today}^ORend_of_support=${today}^ORend_of_extended_support=${today}^ORend_of_life=${today}`,
    )
    lifecycle.query()
    while (lifecycle.next()) fire(EVENT.lifecycleChanged, lifecycle, str(lifecycle, 'model'), '')
}

/** After-update rule on Agreements whose refresh terms changed. */
export function onAgreementTermsChanged(current: GlideRecord): void {
    fire(EVENT.agreementTermsChanged, current, current.getUniqueValue(), '')
}

/** Script action on x_daas_ham.agreement.terms (parm1 = agreement, parm2 = cursor). */
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
