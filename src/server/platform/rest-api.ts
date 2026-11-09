import { gs } from '@servicenow/glide'
import type { RESTAPIRequest, RESTAPIResponse } from '@servicenow/glide/sn_ws_int'
import { ROLE } from '../domain/visibility.ts'

/** Helpers for the Scripted REST resources in entry/. */

export function reply(response: RESTAPIResponse, status: number, body: object): void {
    response.setStatus(status)
    response.setBody(body as never)
}

/**
 * A resource's role guard: whether the caller holds one of `roles`, as gs.hasRole counts them (a role that contains
 * one, and admin, hold it too). A caller who holds none is answered 403 with `error`.
 */
export function requireRole(response: RESTAPIResponse, roles: readonly string[], error: string): boolean {
    if (roles.some((role) => gs.hasRole(role))) return true
    reply(response, 403, { error })
    return false
}

/** The guard of the resources a scan reads or records against (look a unit up, scan into an audit): inventory techs and field techs. */
export function requireScanner(response: RESTAPIResponse): boolean {
    return requireRole(response, [ROLE.inventoryTech, ROLE.fieldTech], 'Requires the inventory tech or field tech role')
}

/** A path parameter, '' when absent. */
export function pathParam(request: RESTAPIRequest, name: string): string {
    return String(request.pathParams[name] ?? '')
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
