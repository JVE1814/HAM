import { addMonths, earliest, isIsoDate } from './calendar'

/** A Model's manufacturer support milestones (ISO dates). */
export interface LifecycleDates {
    endOfSale?: string
    endOfSupport?: string
    endOfExtendedSupport?: string
    endOfLife?: string
}

export type LifecyclePhase = 'available' | 'end_of_sale' | 'end_of_support' | 'end_of_extended_support' | 'end_of_life'

const MILESTONES: ReadonlyArray<[keyof LifecycleDates, LifecyclePhase]> = [
    ['endOfLife', 'end_of_life'],
    ['endOfExtendedSupport', 'end_of_extended_support'],
    ['endOfSupport', 'end_of_support'],
    ['endOfSale', 'end_of_sale'],
]

/** The latest milestone reached on `today`. */
export function lifecyclePhaseOn(dates: LifecycleDates, today: string): LifecyclePhase {
    for (const [field, phase] of MILESTONES) {
        const date = dates[field]
        if (date && date <= today) return phase
    }
    return 'available'
}

export type RefreshBasis = 'cycle' | 'end_of_support' | 'earliest'

export interface RefreshInputs {
    basis: RefreshBasis
    inServiceDate?: string
    refreshCycleMonths: number
    endOfSupport?: string
    /** The date the Asset must be off the network whatever the basis (its lease is being handed back). */
    returnBy?: string
}

/** When an in-service Asset must be refreshed under its Agreement, or null if it cannot be determined. */
export function refreshDueDate(inputs: RefreshInputs): string | null {
    if (!inputs.inServiceDate) return null
    return earliest([byBasis(inputs, inputs.inServiceDate), inputs.returnBy || undefined]) ?? null
}

function byBasis(inputs: RefreshInputs, inServiceDate: string): string | undefined {
    const byCycle = inputs.refreshCycleMonths > 0 ? addMonths(inServiceDate, inputs.refreshCycleMonths) : undefined
    const bySupport = inputs.endOfSupport || undefined
    switch (inputs.basis) {
        case 'cycle':
            return byCycle
        case 'end_of_support':
            return bySupport
        case 'earliest':
            return earliest([byCycle, bySupport])
    }
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
