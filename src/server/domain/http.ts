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
