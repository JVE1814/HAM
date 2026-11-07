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
