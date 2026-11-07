import { GlideRecord } from '@servicenow/glide'
import { assetLifecycleStamp, type AssetLifecycleFacts, type LifecycleDates } from '../domain/model-lifecycle'
import { toIsoDate } from '../domain/calendar'
import { memoized } from '../domain/memo'
import { runEventTableJob } from './chunked'
import { glideToMs, todayIso } from './clock'
import { findById, num, str } from './records'

/** Lifecycle phase and Refresh due date of an Asset, from its Model lifecycle, Agreement and Lease schedule. */

/** A Model's lifecycle milestones by Model sys_id. */
export type ModelLifecycles = (modelId: string) => LifecycleDates

/** An Agreement's refresh terms by Agreement sys_id (no basis and no cycle without one). */
export type AgreementRefreshTerms = (agreementId: string) => Pick<AssetLifecycleFacts, 'refreshBasis' | 'refreshCycleMonths'>

/** A Lease schedule's end terms by Lease schedule sys_id (none without one). */
export type LeaseTerms = (leaseId: string) => AssetLifecycleFacts['lease']

/** What an Asset's lifecycle dates are worked out from besides the Asset itself. */
export interface LifecycleReaders {
    models: ModelLifecycles
    agreements: AgreementRefreshTerms
    leases: LeaseTerms
}

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
    return memoized(modelLifecycle)
}

/** Reads each Agreement at most once for the reader's lifetime. Create one per job chunk or request, never at module scope. */
export function agreementRefreshTerms(): AgreementRefreshTerms {
    return memoized((agreementId) => {
        const agreement = findById('x_daas_ham_agreement', agreementId)
        return {
            refreshBasis: agreement ? str(agreement, 'refresh_basis') : '',
            refreshCycleMonths: agreement ? num(agreement, 'refresh_cycle_months') : 0,
        }
    })
}

/** Reads each Lease schedule at most once for the reader's lifetime. Create one per job chunk or request, never at module scope. */
export function leaseTerms(): LeaseTerms {
    return memoized((leaseId) => {
        const lease = findById('x_daas_ham_lease_schedule', leaseId)
        return lease ? { endAction: str(lease, 'end_action'), ends: str(lease, 'ends') } : undefined
    })
}

/** All three readers, fresh. Create them once per job chunk or request, never at module scope. */
export function lifecycleReaders(): LifecycleReaders {
    return { models: modelLifecycles(), agreements: agreementRefreshTerms(), leases: leaseTerms() }
}

/** The Asset fields its lifecycle stamp is worked out from, with the stamp it carries now. */
interface StampInputs {
    model: string
    agreement: string
    lease: string
    inService: string
    phase: string
    refreshDue: string
}

function stampInputs(asset: GlideRecord): StampInputs {
    return {
        model: str(asset, 'model'),
        agreement: str(asset, 'x_daas_ham_agreement'),
        lease: str(asset, 'x_daas_ham_lease'),
        inService: str(asset, 'x_daas_ham_in_service_date'),
        phase: str(asset, 'x_daas_ham_lifecycle_phase'),
        refreshDue: str(asset, 'x_daas_ham_refresh_due'),
    }
}

function stampOf(inputs: StampInputs, readers: LifecycleReaders): { phase: string; refreshDue: string } {
    const inService = glideToMs(inputs.inService)
    const facts: AssetLifecycleFacts = {
        ...readers.agreements(inputs.agreement),
        inServiceDate: inService === undefined ? undefined : toIsoDate(inService),
        lease: readers.leases(inputs.lease),
    }
    return assetLifecycleStamp(facts, readers.models(inputs.model), todayIso())
}

/** Set (without saving) the Asset's Lifecycle phase and Refresh due date; true if either changed. */
export function applyLifecycleDates(asset: GlideRecord, readers: LifecycleReaders): boolean {
    const inputs = stampInputs(asset)
    const { phase, refreshDue } = stampOf(inputs, readers)
    asset.setValue('x_daas_ham_lifecycle_phase', phase)
    asset.setValue('x_daas_ham_refresh_due', refreshDue)
    return inputs.phase !== phase || inputs.refreshDue !== refreshDue
}

/** An event-driven pass recomputing the lifecycle dates of the Assets matching `query`. */
export interface LifecycleRefresh {
    eventName: string
    record: GlideRecord
    parm1: string
    /** The event's parm2 as received ('' on the first event of a pass). */
    cursor: string
    /** Encoded query on alm_hardware. */
    query: string
}

/**
 * Run one chunk of a lifecycle refresh pass: recompute each matching Asset's Lifecycle phase and
 * Refresh due date (saving only those that changed), reading each Model lifecycle, Agreement and
 * Lease schedule once per chunk; the event is queued again until the pass is complete.
 */
export function refreshLifecycleDates(pass: LifecycleRefresh): void {
    // Never run for a blank model, agreement or lease: the query would match every Asset without one.
    if (!pass.parm1) return
    const readers = lifecycleReaders()
    runEventTableJob({
        ...pass,
        table: 'alm_hardware',
        read: stampInputs,
        handle: (inputs, assetId) => {
            // The stamp is worked out from the batch row; only Assets whose stamp changes are loaded and saved.
            const { phase, refreshDue } = stampOf(inputs, readers)
            if (inputs.phase === phase && inputs.refreshDue === refreshDue) return
            const asset = findById('alm_hardware', assetId)
            if (!asset) return
            asset.setValue('x_daas_ham_lifecycle_phase', phase)
            asset.setValue('x_daas_ham_refresh_due', refreshDue)
            asset.update()
        },
    })
}
