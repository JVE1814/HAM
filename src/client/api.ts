import { restErrorMessage } from './rest-error'

/** The app's scripted REST API (src/fluent/logic/rest.now.ts), which the three pages call. */
const BASE = '/api/x_daas_ham/naas'

/** A failed call, with its HTTP status. */
export class ApiError extends Error {
    status: number

    constructor(message: string, status: number) {
        super(message)
        this.status = status
    }
}

/** A path with values in it, each URL-encoded: path`/assets/${code}`. */
export function path(parts: TemplateStringsArray, ...values: string[]): string {
    return parts.reduce((text, part, i) => text + encodeURIComponent(values[i - 1]) + part)
}

async function call<T>(method: 'GET' | 'POST', to: string, body?: object): Promise<T> {
    const response = await fetch(`${BASE}${to}`, {
        method,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-UserToken': window.g_ck },
        body: body ? JSON.stringify(body) : undefined,
    })
    const payload = await response.json().catch(() => ({}))
    const result = payload.result ?? payload
    if (!response.ok) throw new ApiError(restErrorMessage(result.error, response.status), response.status)
    return result as T
}

export function get<T>(to: string): Promise<T> {
    return call<T>('GET', to)
}

export function post<T>(to: string, body?: object): Promise<T> {
    return call<T>('POST', to, body)
}
