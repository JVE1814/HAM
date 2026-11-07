/** Calls to the NaaS scripted REST API (/api/x_daas_ham/naas). */

export interface AssetSummary {
    id: string
    serial: string
    providerTag: string
    customerTag: string
    model: string
    pid: string
    stage: string
    stockroom: string
    customer: string
    orderLine: string
}

export interface Stockroom {
    id: string
    name: string
    type: string
}

const BASE = '/api/x_daas_ham/naas'

async function call<T>(method: 'GET' | 'POST', path: string, body?: object): Promise<T> {
    const response = await fetch(`${BASE}${path}`, {
        method,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-UserToken': window.g_ck },
        body: body ? JSON.stringify(body) : undefined,
    })
    const payload = await response.json().catch(() => ({}))
    const result = payload.result ?? payload
    if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`)
    return result as T
}

export const warehouseApi = {
    lookup: (code: string) => call<AssetSummary>('GET', `/assets/${encodeURIComponent(code)}`),
    receive: (input: { code: string; stockroom: string; pid?: string; manufacturer?: string }) =>
        call<AssetSummary>('POST', '/receive', input),
    putAway: (input: { code: string; stockroom: string }) => call<AssetSummary>('POST', '/putaway', input),
    pick: (input: { code: string; order: string }) => call<AssetSummary>('POST', '/pick', input),
    auditScan: (input: { audit: string; code: string }) =>
        call<{ audit: string; scanned: string }>('POST', `/audits/${encodeURIComponent(input.audit)}/scan`, { code: input.code }),
    stockrooms: () => call<{ stockrooms: Stockroom[] }>('GET', '/stockrooms').then((r) => r.stockrooms),
}
