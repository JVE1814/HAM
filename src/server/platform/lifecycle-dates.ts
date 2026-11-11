import type { GlideRecord } from '@servicenow/glide'
import { inFleet } from '../domain/fleet.ts'
import { DEPLOYED_STAGES, notRetiredCondition, SERVING_STAGES, stagesQuery } from '../domain/lifecycle.ts'
import { assetLifecycleStamp, type AssetLifecycleFacts, type LifecycleDates } from '../domain/model-lifecycle.ts'
import { memoized } from '../domain/memo.ts'
import { REFRESH_DUE_FIELD } from '../domain/refresh.ts'
import type { LeaseEndAction, RefreshBasis } from '../domain/vocabulary.ts'
import { runEventTableJob } from './chunked.ts'
import { glideToIsoDate, todayIso } from './clock.ts'
import { jobEvent, queueJob } from './events.ts'
import { EVENT } from '../domain/events.ts'
import { readModelLifecycle } from './model-lifecycle.ts'
import { choice, findById, num, str, throwRefused } from './records.ts'

/**
 * Lifecycle phase and Refresh due date of an Asset, from its Model lifecycle, Agreement and Lease schedule: the stamp
 * itself, and the three background passes that recompute it for the fleet assets of a Model, an Agreement or a Lease
 * schedule once what it is worked out from changes (`REFRESH_PASS`: each pass's event and the Assets it covers).
 */

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
        refreshBasis: agreement ? choice<RefreshBasis>(agreement, 'refresh_basis') : '',
        refreshCycleMonths: agreement ? num(agreement, 'refresh_cycle_months') : 0,
    }
}

function leaseTerms(leaseId: string): AssetLifecycleFacts['lease'] {
    const lease = findById('x_daas_ham_lease_schedule', leaseId)
    return lease ? { endAction: choice<LeaseEndAction>(lease, 'end_action'), ends: str(lease, 'ends') } : undefined
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
        refreshDue: str(asset, REFRESH_DUE_FIELD),
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
    asset.setValue(REFRESH_DUE_FIELD, refreshDue)
    return inputs.phase !== phase || inputs.refreshDue !== refreshDue
}

/**
 * The refresh passes, each an event job (platform/chunked) named after what its Assets share: the event that carries
 * it, queued on that record, and the Assets it recomputes, as an encoded query on alm_hardware given the record's
 * sys_id.
 * - `model`: a Model's milestones changed, or one is crossed today: its Assets not retired. Queued by
 *   platform/model-lifecycle `queueModelRefresh`, for a NaaS Model only: that module, which this one reads the
 *   milestones through, alone knows which Models those are.
 * - `agreement`: an Agreement's refresh terms changed: its deployed Assets (`queueRefresh`).
 * - `lease`: a returned Lease schedule's end changed, or its return was decided: its serving Assets (`queueRefresh`).
 */
const REFRESH_PASS = {
    model: { event: EVENT.lifecycleChanged, assets: (modelId: string) => `model=${modelId}^${notRetiredCondition()}` },
    agreement: {
        event: EVENT.agreementTermsChanged,
        assets: (agreementId: string) => stagesQuery(DEPLOYED_STAGES, `x_daas_ham_agreement=${agreementId}`),
    },
    lease: { event: EVENT.leaseAssets, assets: (leaseId: string) => stagesQuery(SERVING_STAGES, `x_daas_ham_lease=${leaseId}`) },
} as const

type RefreshPass = keyof typeof REFRESH_PASS

/** Queue the `pass` of `subject` (an Agreement or a Lease schedule): its Assets are recomputed in the background. */
export function queueRefresh(pass: Exclude<RefreshPass, 'model'>, subject: GlideRecord): void {
    queueJob(REFRESH_PASS[pass].event, subject)
}

/**
 * Run one chunk of a refresh `pass`, for the script action of its event (`event` and `current` are the platform's):
 * recompute the Lifecycle phase and Refresh due date of each fleet asset the pass covers (saving only those that
 * changed), reading each Model lifecycle, Agreement and Lease schedule once per chunk; the event is queued again until
 * the pass is complete. The Provider IT's units of a NaaS Model are left alone (ADR 0016): every clause of the pass's
 * query carries the Fleet flag.
 */
export function runRefreshPass(pass: RefreshPass, event: GlideRecord, current: GlideRecord): void {
    const queued = jobEvent(REFRESH_PASS[pass].event, event, current)
    const readers = lifecycleReaders()
    runEventTableJob(queued, {
        query: inFleet(REFRESH_PASS[pass].assets(queued.subject)),
        table: 'alm_hardware',
        read: stampInputs,
        handle: (inputs, assetId) => {
            // Only Assets whose stamp changes by their batch row are loaded; the stamp saved is worked out from the loaded record.
            const { phase, refreshDue } = stampOf(inputs, readers)
            if (inputs.phase === phase && inputs.refreshDue === refreshDue) return
            const asset = findById('alm_hardware', assetId)
            if (!asset || !applyLifecycleDates(asset, readers)) return
            // Refused, it fails as a record of the chunk, which the runner logs: the Asset keeps its old dates until the next pass.
            if (!asset.update()) throwRefused(asset, 'lifecycle dates not saved')
        },
    })
}
