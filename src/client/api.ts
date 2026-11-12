import { restErrorMessage } from './rest-error'

const NAAS = '/api/x_daas_ham/naas'
const NOW = '/api/now'

export class ApiError extends Error {
    status: number

    constructor(message: string, status: number) {
        super(message)
        this.status = status
    }
}

export function path(parts: TemplateStringsArray, ...values: string[]): string {
    return parts.reduce((text, part, i) => text + encodeURIComponent(values[i - 1]) + part)
}

async function call(method: 'GET' | 'POST', url: string, body?: object, signal?: AbortSignal): Promise<{ result: unknown; response: Response }> {
    const response = await fetch(url, {
        method,
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            ...(window.g_ck ? { 'X-UserToken': window.g_ck } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal,
    })
    const payload = await response.json().catch(() => ({}))
    const result = payload.result ?? payload
    if (!response.ok) throw new ApiError(restErrorMessage(result.error ?? payload.error, response.status), response.status)
    return { result, response }
}

export async function get<T>(to: string, signal?: AbortSignal): Promise<T> {
    return (await call('GET', `${NAAS}${to}`, undefined, signal)).result as T
}

export async function post<T>(to: string, body?: object): Promise<T> {
    return (await call('POST', `${NAAS}${to}`, body)).result as T
}

/** A GET of a platform API: its `result`, unparsed, and the row count its X-Total-Count header gives (0 when absent). */
export async function platformGet(to: string, params: Record<string, string>, signal?: AbortSignal): Promise<{ result: unknown; total: number }> {
    const { result, response } = await call('GET', `${NOW}${to}?${new URLSearchParams(params)}`, undefined, signal)
    return { result, total: Number(response.headers.get('X-Total-Count') ?? 0) }
}
