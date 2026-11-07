import { restErrorMessage } from '../rest-error'

/** Customer self-service endpoints (/api/x_daas_ham/naas/customer). */

export interface CustomerAsset {
    id: string
    tag: string
    serial: string
    customerTag: string
    model: string
    site: string
    siteId: string
    stage: string
    inServiceDate: string
    refreshDue: string
}

export interface CustomerOrder {
    id: string
    number: string
    type: string
    site: string
    stage: string
    stageLabel: string
    canConfirmInstall: boolean
}

export interface AttestationItem {
    id: string
    tag: string
    serial: string
    model: string
    response: '' | 'confirmed' | 'missing' | 'unknown'
}

export interface Overview {
    customer: string
    isCustomerAdmin: boolean
    assets: CustomerAsset[]
    orders: CustomerOrder[]
    returns: Array<{ number: string; site: string; trigger: string; dueDate: string; labelUrl: string; trackingNumber: string }>
    attestations: Array<{ id: string; number: string; site: string; items: AttestationItem[] }>
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: object): Promise<T> {
    const response = await fetch(`/api/x_daas_ham/naas/customer${path}`, {
        method,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-UserToken': window.g_ck },
        body: body ? JSON.stringify(body) : undefined,
    })
    const payload = await response.json().catch(() => ({}))
    const result = payload.result ?? payload
    if (!response.ok) throw new Error(restErrorMessage(result.error, response.status))
    return result as T
}

export const customerApi = {
    overview: () => call<Overview>('GET', '/overview'),
    reportFault: (asset: string, description: string) => call<{ case: string }>('POST', '/faults', { asset, description }),
    confirmInstalled: (orderId: string) => call<{ order: string }>('POST', `/orders/${orderId}/installed`),
    answerAttestation: (id: string, items: Array<{ id: string; response: string }>, submit: boolean) =>
        call<{ attestation: string }>('POST', `/attestations/${id}`, { items, submit }),
    requestReturn: (input: { site: string; assets: string[]; decommission: boolean; method: string }) =>
        call<{ returnOrder: string }>('POST', '/returns', input),
}
