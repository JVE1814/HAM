import { asArray, field, parseJson, text } from './json'

/** The outbound HTTP seam shared by OEM and shipping integrations (ADR 0008). */

/** A call to a named function of a REST message, with ${variable} substitutions and an optional JSON body. */
export interface HttpRequest {
    fn: string
    params: Record<string, string>
    body?: string
}

export interface HttpResponse {
    status: number
    body: string
}

/** Transport: the platform adapter calls sn_ws.RESTMessageV2; tests use fakes. */
export type HttpPort = (request: HttpRequest) => HttpResponse

export function isSuccess(status: number): boolean {
    return status >= 200 && status < 300
}

/** "HTTP 400: <first error>" from the common error shapes (errors[] of strings or objects, message, detail). */
export function errorText(status: number, body: string): string {
    const json = parseJson(body)
    const first = asArray(field(json, 'errors'))[0]
    const detail = text(first) || text(field(first, 'message')) || text(field(json, 'message')) || text(field(json, 'detail'))
    return `HTTP ${status}${detail ? `: ${detail}` : ''}`
}
