import { GlideRecord } from '@servicenow/glide'
import { assetLifecycleStamp, type AssetLifecycleFacts, type LifecycleDates } from '../domain/model-lifecycle'
import { toIsoDate } from '../domain/calendar'
import { glideToMs, todayIso } from './clock'
import { num, str } from './records'

/** Lifecycle phase and Refresh due date of an Asset, from its Model lifecycle and Agreement. */

/** A Model's lifecycle milestones by Model sys_id. */
export type ModelLifecycles = (modelId: string) => LifecycleDates

/** Read a Model's lifecycle milestones (none when it has no Model lifecycle record). */
export function modelLifecycle(modelId: string): LifecycleDates {
    const gr = new GlideRecord('x_daas_ham_model_lifecycle')
    if (!modelId || !gr.get('model', modelId)) return {}
    return {
        endOfSale: str(gr, 'end_of_sale') || undefined,
        endOfSupport: str(gr, 'end_of_support') || undefined,
        endOfExtendedSupport: str(gr, 'end_of_extended_support') || undefined,
        endOfLife: str(gr, 'end_of_life') || undefined,
    }
}

/** Reads x_daas_ham_model_lifecycle at most once per model for the reader's lifetime. Create one per job chunk or request, never at module scope. */
export function modelLifecycles(): ModelLifecycles {
    const read = new Map<string, LifecycleDates>()
    return (modelId) => {
        let dates = read.get(modelId)
        if (!dates) {
            dates = modelLifecycle(modelId)
            read.set(modelId, dates)
        }
        return dates
    }
}

/** Set (without saving) the Asset's Lifecycle phase and Refresh due date; true if either changed. */
export function applyLifecycleDates(asset: GlideRecord, lifecycles: ModelLifecycles): boolean {
    const inService = glideToMs(str(asset, 'x_daas_ham_in_service_date'))
    const facts: AssetLifecycleFacts = {
        refreshBasis: str(asset, 'x_daas_ham_agreement.refresh_basis'),
        inServiceDate: inService === undefined ? undefined : toIsoDate(inService),
        refreshCycleMonths: num(asset, 'x_daas_ham_agreement.refresh_cycle_months'),
        // Only leased Assets pay for the dot-walk to their lease.
        lease: str(asset, 'x_daas_ham_lease')
            ? { endAction: str(asset, 'x_daas_ham_lease.end_action'), ends: str(asset, 'x_daas_ham_lease.ends') }
            : undefined,
    }
    const { phase, refreshDue } = assetLifecycleStamp(facts, lifecycles(str(asset, 'model')), todayIso())
    const changed = str(asset, 'x_daas_ham_lifecycle_phase') !== phase || str(asset, 'x_daas_ham_refresh_due') !== refreshDue
    asset.setValue('x_daas_ham_lifecycle_phase', phase)
    asset.setValue('x_daas_ham_refresh_due', refreshDue)
    return changed
}
