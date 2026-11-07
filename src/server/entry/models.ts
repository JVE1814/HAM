// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.
import { GlideRecord } from '@servicenow/glide'
import { DEPLOYED_STAGES, stagesQuery } from '../domain/lifecycle'
import { runEventTableJob, runTableJob } from '../platform/chunked'
import { todayIso } from '../platform/clock'
import { EVENT, fire } from '../platform/events'
import { applyLifecycleDates, modelLifecycles } from '../platform/lifecycle-dates'
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

function repointModel(rawModelId: string, canonicalModelId: string): void {
    const raw = new GlideRecord('cmdb_model')
    if (!raw.get(rawModelId)) return
    raw.setValue('x_daas_ham_normalized_to', canonicalModelId)
    raw.update()
    const asset = new GlideRecord('alm_hardware')
    asset.addQuery('model', rawModelId)
    asset.query()
    while (asset.next()) {
        asset.setValue('model', canonicalModelId)
        asset.update()
    }
}

/** After-update rule on normalization exceptions given a resolved model: learn a rule from it. */
export function onNormalizationResolved(current: GlideRecord): void {
    learnFromResolution(current, loadNormalizationData())
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
    const lifecycles = modelLifecycles()
    runEventTableJob({
        eventName: EVENT.lifecycleChanged,
        record: current,
        parm1: modelId,
        cursor: str(event, 'parm2'),
        table: 'alm_hardware',
        query: `model=${modelId}^install_status!=7`,
        read: (asset) => asset.getUniqueValue(),
        handle: (assetId) => {
            const asset = new GlideRecord('alm_hardware')
            if (asset.get(assetId) && applyLifecycleDates(asset, lifecycles)) asset.update()
        },
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
    const lifecycles = modelLifecycles()
    runEventTableJob({
        eventName: EVENT.agreementTermsChanged,
        record: current,
        parm1: agreementId,
        cursor: str(event, 'parm2'),
        table: 'alm_hardware',
        query: stagesQuery(DEPLOYED_STAGES, `x_daas_ham_agreement=${agreementId}`),
        read: (asset) => asset.getUniqueValue(),
        handle: (assetId) => {
            const asset = new GlideRecord('alm_hardware')
            if (asset.get(assetId) && applyLifecycleDates(asset, lifecycles)) asset.update()
        },
    })
}
