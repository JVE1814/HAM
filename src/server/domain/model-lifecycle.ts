import { addMonths, earliest, isIsoDate } from './calendar.ts'
import { FLEET_CONDITION } from './fleet.ts'
import { INSTALL_STATUS, LIFECYCLE_PHASE, type LifecyclePhase } from './vocabulary.ts'

/** A Model's manufacturer support milestones (ISO dates). */
export interface LifecycleDates {
    endOfSale?: string
    endOfSupport?: string
    endOfExtendedSupport?: string
    endOfLife?: string
}

const MILESTONES: ReadonlyArray<[keyof LifecycleDates, LifecyclePhase]> = [
    ['endOfLife', 'end_of_life'],
    ['endOfExtendedSupport', 'end_of_extended_support'],
    ['endOfSupport', 'end_of_support'],
    ['endOfSale', 'end_of_sale'],
]

/** What an Asset contributes to its Lifecycle phase and Refresh due date. */
export interface AssetLifecycleFacts {
    /** The Asset's Agreement refresh basis as stored: 'cycle' | 'end_of_support' | 'earliest', or '' when the Asset has no Agreement (treated as 'earliest'). Any other value gives no basis date. */
    refreshBasis: string
    /** YYYY-MM-DD the Asset went into service; absent until it has. */
    inServiceDate?: string
    /** The Agreement's refresh cycle; 0 (or no Agreement) means no cycle date. */
    refreshCycleMonths: number
    /** The Asset's Lease schedule, when it is on one. */
    lease?: { endAction: string; ends: string }
}

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
    for (const [field, phase] of MILESTONES) {
        const date = dates[field]
        if (date && date <= today) return phase
    }
    return 'available'
}

function refreshDueDate(asset: AssetLifecycleFacts, model: LifecycleDates): string {
    // A lease hand-back applies even before the Asset is in service (shipped, awaiting first sighting).
    const basisDate = asset.inServiceDate ? byBasis(asset, asset.inServiceDate, model.endOfSupport) : undefined
    return earliest([basisDate, returnBy(asset.lease)]) ?? ''
}

function byBasis(asset: AssetLifecycleFacts, inServiceDate: string, endOfSupport: string | undefined): string | undefined {
    const byCycle = asset.refreshCycleMonths > 0 ? addMonths(inServiceDate, asset.refreshCycleMonths) : undefined
    const bySupport = endOfSupport || undefined
    // An Asset without an Agreement has no basis stored, and refreshes on whichever comes first.
    switch (asset.refreshBasis || 'earliest') {
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
    return lease?.endAction === 'return' && lease.ends ? lease.ends.slice(0, 10) : undefined
}

export type LifecycleRow = { pid: string } & { [K in keyof LifecycleDates]?: string }

export type ParsedLifecycleRow = { ok: true; pid: string; dates: LifecycleDates } | { ok: false; reason: string }

const MILESTONE_ORDER: ReadonlyArray<[keyof LifecycleDates, string]> = [
    ['endOfSale', 'end of sale'],
    ['endOfSupport', 'end of support'],
    ['endOfExtendedSupport', 'end of extended support'],
    ['endOfLife', 'end of life'],
]

/** Validate one CSV row of manufacturer milestones. */
export function parseLifecycleRow(row: LifecycleRow): ParsedLifecycleRow {
    const pid = row.pid.trim()
    if (!pid) return { ok: false, reason: 'PID is required' }
    const dates: LifecycleDates = {}
    for (const [field] of MILESTONE_ORDER) {
        const value = (row[field] ?? '').trim()
        if (!value) continue
        if (!isIsoDate(value)) return { ok: false, reason: `${field} must be YYYY-MM-DD` }
        dates[field] = value
    }
    const present = MILESTONE_ORDER.filter(([field]) => dates[field])
    for (let i = 1; i < present.length; i++) {
        const [earlierField, earlierLabel] = present[i - 1]
        const [laterField, laterLabel] = present[i]
        if (dates[earlierField]! > dates[laterField]!) {
            return { ok: false, reason: `Milestones must not go backwards (${earlierLabel} after ${laterLabel})` }
        }
    }
    return { ok: true, pid, dates }
}

/** Combine stored milestones with a newer source: present values win, missing ones keep what was there. */
export function mergeLifecycle(existing: LifecycleDates, incoming: LifecycleDates): LifecycleDates {
    return {
        endOfSale: incoming.endOfSale || existing.endOfSale,
        endOfSupport: incoming.endOfSupport || existing.endOfSupport,
        endOfExtendedSupport: incoming.endOfExtendedSupport || existing.endOfExtendedSupport,
        endOfLife: incoming.endOfLife || existing.endOfLife,
    }
}

/**
 * Encoded query on alm_hardware: the installed fleet assets (ADR 0016) whose Model is past its end of support, as the
 * workspace lists and counts them.
 */
export const INSTALLED_PAST_SUPPORT = `install_status=${INSTALL_STATUS.inUse}^x_daas_ham_lifecycle_phaseIN${LIFECYCLE_PHASE.end_of_support},${LIFECYCLE_PHASE.end_of_extended_support},${LIFECYCLE_PHASE.end_of_life}^${FLEET_CONDITION}`
