import { GlideRecord } from '@servicenow/glide'
import { lifecyclePhaseOn, refreshDueDate, type LifecycleDates, type RefreshBasis } from '../domain/model-lifecycle'
import { toIsoDate } from '../domain/calendar'
import { glideToMs, todayIso } from './clock'
import { num, str } from './records'

/** Lifecycle phase and Refresh due date of an Asset, from its Model lifecycle and Agreement. */

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

/** Set (without saving) the asset's lifecycle phase and refresh due date; returns true if either changed. */
export function applyLifecycleDates(asset: GlideRecord, dates: LifecycleDates = modelLifecycle(str(asset, 'model'))): boolean {
    const phase = lifecyclePhaseOn(dates, todayIso())
    const inService = glideToMs(str(asset, 'x_daas_ham_in_service_date'))
    const due =
        refreshDueDate({
            basis: (str(asset, 'x_daas_ham_agreement.refresh_basis') || 'earliest') as RefreshBasis,
            inServiceDate: inService === undefined ? undefined : toIsoDate(inService),
            refreshCycleMonths: num(asset, 'x_daas_ham_agreement.refresh_cycle_months'),
            endOfSupport: dates.endOfSupport,
            returnBy: str(asset, 'x_daas_ham_lease.end_action') === 'return' ? str(asset, 'x_daas_ham_lease.ends') : undefined,
        }) ?? ''
    const changed = str(asset, 'x_daas_ham_lifecycle_phase') !== phase || str(asset, 'x_daas_ham_refresh_due') !== due
    asset.setValue('x_daas_ham_lifecycle_phase', phase)
    asset.setValue('x_daas_ham_refresh_due', due)
    return changed
}
