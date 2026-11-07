import type { RESTAPIRequest, RESTAPIResponse } from '@servicenow/glide/sn_ws_int'

/** Helpers for the Scripted REST resources in entry/. */

export function reply(response: RESTAPIResponse, status: number, body: object): void {
    response.setStatus(status)
    response.setBody(body as never)
}

/** The first value of a query parameter, '' when absent (the platform passes each as an array). */
export function queryParam(request: RESTAPIRequest, name: string): string {
    const raw = ([] as unknown[]).concat(request.queryParams?.[name] ?? [])[0]
    return raw === undefined || raw === null ? '' : String(raw)
}

/** A non-negative integer query parameter, or `fallback`. */
export function queryInt(request: RESTAPIRequest, name: string, fallback: number): number {
    const value = parseInt(queryParam(request, name), 10)
    return Number.isFinite(value) && value >= 0 ? value : fallback
}
