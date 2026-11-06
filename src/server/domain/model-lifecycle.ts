import { addMonths, earliest } from './calendar'

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
}

/** When an in-service Asset must be refreshed under its Agreement, or null if it cannot be determined. */
export function refreshDueDate(inputs: RefreshInputs): string | null {
    if (!inputs.inServiceDate) return null
    const byCycle = inputs.refreshCycleMonths > 0 ? addMonths(inputs.inServiceDate, inputs.refreshCycleMonths) : undefined
    const bySupport = inputs.endOfSupport || undefined
    switch (inputs.basis) {
        case 'cycle':
            return byCycle ?? null
        case 'end_of_support':
            return bySupport ?? null
        case 'earliest':
            return earliest([byCycle, bySupport]) ?? null
    }
}
