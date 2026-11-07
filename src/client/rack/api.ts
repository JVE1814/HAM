import type { PowerBudget } from '../../server/domain/rack'

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

async function get<T>(path: string): Promise<T> {
    const response = await fetch(`/api/x_daas_ham/naas${path}`, {
        headers: { Accept: 'application/json', 'X-UserToken': window.g_ck },
    })
    const payload = await response.json().catch(() => ({}))
    const result = payload.result ?? payload
    if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`)
    return result as T
}

export const rackApi = {
    sites: () => get<{ sites: Site[] }>('/sites').then((r) => r.sites),
    racks: (siteId: string) => get<{ racks: Rack[] }>(`/racks?site=${encodeURIComponent(siteId)}`).then((r) => r.racks),
    rack: (rackId: string) => get<{ rack: Rack; devices: RackDevice[] }>(`/racks/${encodeURIComponent(rackId)}`),
}
