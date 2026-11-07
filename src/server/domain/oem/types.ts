import type { LifecycleDates } from '../model-lifecycle'

/** OEM integrations behind one port per capability (ADR 0008). */

export type OemVendor = 'cisco' | 'meraki' | 'fortinet' | 'mist' | 'aruba' | 'checkpoint'

export interface LifecycleFact {
    pid: string
    dates: LifecycleDates
    reference: string
}

export interface CoverageFact {
    serial: string
    covered: boolean
    contractNumber: string
    serviceLevel: string
    startDate?: string
    endDate?: string
}

export interface RmaFact {
    rmaNumber: string
    status: string
}

export interface Fetched<T> {
    facts: T[]
    errors: string[]
}

/** A coverage answer, which also says which of the asked serials were not answered. */
export interface CoverageFetched extends Fetched<CoverageFact> {
    /** Serials whose call failed, so nothing is known about them; the others were answered. */
    failed: string[]
    /** Serials the vendor answered with an error of its own (e.g. not in the account): retry them only after the refresh interval. */
    rejected: string[]
}
