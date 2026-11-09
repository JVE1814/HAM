import type { PowerBudget } from '../../server/domain/rack'
import { restErrorMessage } from '../rest-error'

/** Calls to the NaaS rack endpoints (/api/x_daas_ham/naas). */

export interface Site {
    id: string
    name: string
    customer: string
}

export interface Rack {
    id: string
    name: string
    units: number
    room?: string
    power?: PowerBudget
}

export interface RackDevice {
    id: string
    tag: string
    serial: string
    model: string
    ruStart: number
    height: number
    face: 'front' | 'rear'
    stage: string
    customer: string
    lifecyclePhase: string
    coverageEnd: string
    refreshDue: string
}

/** A GET of the API; `signal` aborts it when the view no longer wants its answer. */
async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`/api/x_daas_ham/naas${path}`, {
        headers: { Accept: 'application/json', 'X-UserToken': window.g_ck },
        signal,
    })
    const payload = await response.json().catch(() => ({}))
    const result = payload.result ?? payload
    if (!response.ok) throw new Error(restErrorMessage(result.error, response.status))
    return result as T
}

export const rackApi = {
    sites: (signal?: AbortSignal) => get<{ sites: Site[] }>('/sites', signal).then((r) => r.sites),
    racks: (siteId: string, signal?: AbortSignal) =>
        get<{ racks: Rack[] }>(`/racks?site=${encodeURIComponent(siteId)}`, signal).then((r) => r.racks),
    rack: (rackId: string, signal?: AbortSignal) => get<{ rack: Rack; devices: RackDevice[] }>(`/racks/${encodeURIComponent(rackId)}`, signal),
}
