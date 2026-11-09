import type { GlideRecord } from '@servicenow/glide'
import { inFleet } from '../domain/fleet.ts'
import { assetLifecycleStamp, type AssetLifecycleFacts, type LifecycleDates } from '../domain/model-lifecycle.ts'
import { memoized } from '../domain/memo.ts'
import { runEventTableJob } from './chunked.ts'
import { glideToIsoDate, todayIso } from './clock.ts'
import type { JobEvent } from './events.ts'
import { readModelLifecycle } from './model-lifecycle.ts'
import { findById, num, str, warnRefused } from './records.ts'

/** Lifecycle phase and Refresh due date of an Asset, from its Model lifecycle, Agreement and Lease schedule. */

/** What an Asset's lifecycle dates are worked out from besides the Asset itself, each looked up by sys_id. */
export interface LifecycleReaders {
    /** A Model's lifecycle milestones. */
    models: (modelId: string) => LifecycleDates
    /** An Agreement's refresh terms (no basis and no cycle without one). */
    agreements: (agreementId: string) => AgreementRefreshTerms
    /** A Lease schedule's end terms (none without one). */
    leases: (leaseId: string) => AssetLifecycleFacts['lease']
}

type AgreementRefreshTerms = Pick<AssetLifecycleFacts, 'refreshBasis' | 'refreshCycleMonths'>

function agreementRefreshTerms(agreementId: string): AgreementRefreshTerms {
    const agreement = findById('x_daas_ham_agreement', agreementId)
    return {
        refreshBasis: agreement ? str(agreement, 'refresh_basis') : '',
        refreshCycleMonths: agreement ? num(agreement, 'refresh_cycle_months') : 0,
    }
}

function leaseTerms(leaseId: string): AssetLifecycleFacts['lease'] {
    const lease = findById('x_daas_ham_lease_schedule', leaseId)
    return lease ? { endAction: str(lease, 'end_action'), ends: str(lease, 'ends') } : undefined
}

/**
 * Fresh readers, each reading a Model lifecycle, Agreement or Lease schedule at most once for its
 * lifetime: create them once per job chunk or request, never at module scope.
 */
export function lifecycleReaders(): LifecycleReaders {
    return { models: memoized(readModelLifecycle), agreements: memoized(agreementRefreshTerms), leases: memoized(leaseTerms) }
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
    const facts: AssetLifecycleFacts = {
        ...readers.agreements(inputs.agreement),
        inServiceDate: glideToIsoDate(inputs.inService),
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

/**
 * Run one chunk of a lifecycle refresh pass over the fleet assets matching `query` (an encoded query on alm_hardware,
 * which the pass keeps to fleet assets): recompute each one's Lifecycle phase and Refresh due date (saving only those
 * that changed), reading each Model lifecycle, Agreement and Lease schedule once per chunk; the event is queued again
 * until the pass is complete. The Provider IT's units of a NaaS Model are left alone (ADR 0016): every clause of
 * `query` carries the Fleet flag.
 */
export function refreshLifecycleDates(queued: JobEvent, query: string): void {
    // Never run for a blank model, agreement or lease: the query would match every Asset without one.
    if (!queued.subject) return
    const readers = lifecycleReaders()
    runEventTableJob(queued, {
        query: inFleet(query),
        table: 'alm_hardware',
        read: stampInputs,
        handle: (inputs, assetId) => {
            // Only Assets whose stamp changes by their batch row are loaded; the stamp saved is worked out from the loaded record.
            const { phase, refreshDue } = stampOf(inputs, readers)
            if (inputs.phase === phase && inputs.refreshDue === refreshDue) return
            const asset = findById('alm_hardware', assetId)
            if (!asset || !applyLifecycleDates(asset, readers)) return
            if (!asset.update()) warnRefused(asset, `Lifecycle dates of ${str(asset, 'serial_number')} not saved`)
        },
    })
}
