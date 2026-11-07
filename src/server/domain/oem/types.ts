import type { LifecycleDates } from '../model-lifecycle'

/** OEM integrations behind one port per capability (ADR 0008). */

export type OemVendor = 'cisco' | 'meraki' | 'fortinet' | 'mist' | 'aruba' | 'checkpoint'

/** A call to a named function of the vendor's REST message, with ${variable} substitutions. */
export interface HttpRequest {
    fn: string
    params: Record<string, string>
}

export interface HttpResponse {
    status: number
    body: string
}

/** Transport: the platform adapter calls sn_ws.RESTMessageV2; tests use fakes. */
export type HttpPort = (request: HttpRequest) => HttpResponse

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
