import { addMonths, earliest, isIsoDate } from './calendar.ts'
import { FLEET_CONDITION, INSTALLED_CONDITION } from './fleet.ts'
import { LEASE_END_ACTION, type LeaseEndAction, LIFECYCLE_PHASE, type LifecyclePhase, type RefreshBasis } from './vocabulary.ts'

/** A Model's manufacturer support milestones (ISO dates). */
export interface LifecycleDates {
    endOfSale?: string
    endOfSupport?: string
    endOfExtendedSupport?: string
    endOfLife?: string
}

/**
 * The milestones in the order a manufacturer reaches them: the date each is kept in, the Lifecycle phase an Asset is in
 * once its Model has reached it (also the `lifecycle_phase` of its row in the platform's Model lifecycle table, ADR
 * 0017), and its name in messages. Reading, checking, merging and storing milestones all go through this list.
 */
export const MILESTONES: ReadonlyArray<{ field: keyof LifecycleDates; phase: LifecyclePhase; label: string }> = [
    { field: 'endOfSale', phase: 'end_of_sale', label: 'end of sale' },
    { field: 'endOfSupport', phase: 'end_of_support', label: 'end of support' },
    { field: 'endOfExtendedSupport', phase: 'end_of_extended_support', label: 'end of extended support' },
    { field: 'endOfLife', phase: 'end_of_life', label: 'end of life' },
]

/** What an Asset contributes to its Lifecycle phase and Refresh due date. */
export interface AssetLifecycleFacts {
    /**
     * The Asset's Agreement refresh basis as stored, or '' when the Asset has no Agreement (`NO_AGREEMENT_BASIS`). A
     * value stored past the list gives no basis date.
     */
    refreshBasis: RefreshBasis | ''
    /** YYYY-MM-DD the Asset went into service; absent until it has. */
    inServiceDate?: string
    /** The Agreement's refresh cycle; 0 (or no Agreement) means no cycle date. */
    refreshCycleMonths: number
    /** The Asset's Lease schedule, when it is on one: its end action ('' when none is stored) and its end, a date or date-time as stored. */
    lease?: { endAction: LeaseEndAction | ''; ends: string }
}

/** An Asset without an Agreement has no basis stored, and refreshes on whichever comes first. */
const NO_AGREEMENT_BASIS: RefreshBasis = 'earliest'

export interface AssetLifecycleStamp {
    phase: LifecyclePhase
    /** Refresh due date as YYYY-MM-DD, or '' when none can be determined. */
    refreshDue: string
}

/**
 * An Asset's Lifecycle phase (the latest milestone its Model has reached on `today`) and Refresh due
 * date: the date its Agreement's refresh basis gives, brought forward to the lease end when the lease
 * is being returned (ADR 0011).
 */
export function assetLifecycleStamp(asset: AssetLifecycleFacts, model: LifecycleDates, today: string): AssetLifecycleStamp {
    return { phase: lifecyclePhaseOn(model, today), refreshDue: refreshDueDate(asset, model) }
}

function lifecyclePhaseOn(dates: LifecycleDates, today: string): LifecyclePhase {
    const reached = MILESTONES.filter(({ field }) => {
        const date = dates[field]
        return !!date && date <= today
    })
    return reached.length > 0 ? reached[reached.length - 1].phase : 'available'
}

function refreshDueDate(asset: AssetLifecycleFacts, model: LifecycleDates): string {
    // A lease hand-back applies even before the Asset is in service (shipped, awaiting first sighting).
    const basisDate = asset.inServiceDate ? byBasis(asset, asset.inServiceDate, model.endOfSupport) : undefined
    return earliest([basisDate, returnBy(asset.lease)]) ?? ''
}

function byBasis(asset: AssetLifecycleFacts, inServiceDate: string, endOfSupport: string | undefined): string | undefined {
    const byCycle = asset.refreshCycleMonths > 0 ? addMonths(inServiceDate, asset.refreshCycleMonths) : undefined
    const bySupport = endOfSupport || undefined
    const basis: RefreshBasis = asset.refreshBasis || NO_AGREEMENT_BASIS
    switch (basis) {
        case 'cycle':
            return byCycle
        case 'end_of_support':
            return bySupport
        case 'earliest':
            return earliest([byCycle, bySupport])
        default:
            return undefined
    }
}

/** The date a leased Asset must be off the network: its lease end, once the decision is to return it. */
function returnBy(lease: AssetLifecycleFacts['lease']): string | undefined {
    return lease?.endAction === LEASE_END_ACTION.return && lease.ends ? lease.ends.slice(0, 10) : undefined
}

export type LifecycleRow = { pid: string } & { [K in keyof LifecycleDates]?: string }

export type ParsedLifecycleRow = { ok: true; pid: string; dates: LifecycleDates } | { ok: false; reason: string }

/** A row with no date at all parses, PID or not (a blank line at the end of a CSV): it has nothing to import. */
export function parseLifecycleRow(row: LifecycleRow): ParsedLifecycleRow {
    const dates: LifecycleDates = {}
    for (const { field } of MILESTONES) {
        const value = (row[field] ?? '').trim()
        if (!value) continue
        if (!isIsoDate(value)) return { ok: false, reason: `${field} must be YYYY-MM-DD` }
        dates[field] = value
    }
    const pid = row.pid.trim()
    if (!pid && Object.keys(dates).length > 0) return { ok: false, reason: 'PID is required' }
    return { ok: true, pid, dates }
}

/**
 * Why `dates` go backwards (a milestone dated before one the manufacturer reaches earlier), or '' when they are in
 * order. A row is checked merged with the milestones stored (`mergeLifecycle`), since a blank one keeps its date.
 */
export function backwardsMilestones(dates: LifecycleDates): string {
    const present = MILESTONES.filter(({ field }) => dates[field])
    for (let i = 1; i < present.length; i++) {
        const earlier = present[i - 1]
        const later = present[i]
        if (dates[earlier.field]! > dates[later.field]!) return `Milestones must not go backwards (${earlier.label} after ${later.label})`
    }
    return ''
}

/** Combine stored milestones with a newer source: present values win, missing ones keep what was there. */
export function mergeLifecycle(existing: LifecycleDates, incoming: LifecycleDates): LifecycleDates {
    const merged: LifecycleDates = {}
    for (const { field } of MILESTONES) merged[field] = incoming[field] || existing[field]
    return merged
}

export const PAST_SUPPORT_PHASES: readonly LifecyclePhase[] = [
    LIFECYCLE_PHASE.end_of_support,
    LIFECYCLE_PHASE.end_of_extended_support,
    LIFECYCLE_PHASE.end_of_life,
]

/**
 * Encoded query on alm_hardware: the installed fleet assets (ADR 0016) whose Model is past its end of support
 * (`PAST_SUPPORT_PHASES`; domain/model-lifecycle.test.ts holds it to the list), as the workspace lists and counts them.
 */
export const INSTALLED_PAST_SUPPORT = `${INSTALLED_CONDITION}^x_daas_ham_lifecycle_phaseIN${LIFECYCLE_PHASE.end_of_support},${LIFECYCLE_PHASE.end_of_extended_support},${LIFECYCLE_PHASE.end_of_life}^${FLEET_CONDITION}`
