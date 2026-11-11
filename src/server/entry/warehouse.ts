import type { RESTAPIRequest, RESTAPIResponse } from '@servicenow/glide/sn_ws_int'
import type { PickRequest, PutAwayRequest, ReceiveRequest, StockroomList } from '../domain/rest-contracts.ts'
import { ROLE } from '../domain/roles.ts'
import { assetSummary, lookUp, pick, putAway, receive, receivingStockrooms, type Scan, type ScanRefusal } from '../platform/receiving.ts'
import { pathParam, reply, requireRole, requireScanner, textBodyOf } from '../platform/rest-api.ts'

/** Warehouse scanning API used by the warehouse React app (P1.5): platform/receiving. */

const REFUSAL_STATUS: Record<ScanRefusal['reason'], number> = {
    invalid: 400,
    unknown: 404,
    conflict: 409,
    refused: 422,
    busy: 503,
}

function answer(response: RESTAPIResponse, scan: Scan): void {
    if ('asset' in scan) return reply(response, 200, assetSummary(scan.asset))
    reply(response, REFUSAL_STATUS[scan.reason], { error: scan.why })
}

/** Receive, put away, pick and the stockroom list are depot work: inventory techs (asset managers and admins too). */
function allowed(response: RESTAPIResponse): boolean {
    return requireRole(response, [ROLE.inventoryTech], 'Requires the inventory tech role')
}

/**
 * GET /assets/{code}: look a fleet asset up by serial, Provider tag or Customer tag (not the Provider IT's). A look-up
 * only reads the Asset, so field techs, who read every Asset, may look up too.
 */
export function lookupAsset(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!requireScanner(response)) return
    answer(response, lookUp(pathParam(request, 'code')))
}

export function receiveAsset(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!allowed(response)) return
    const input: Partial<ReceiveRequest> = textBodyOf(request)
    if (!input.code || !input.stockroom) return reply(response, 400, { error: 'code and stockroom are required' })
    answer(response, receive({ code: input.code, pid: input.pid }, input.stockroom))
}

export function putAwayAsset(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!allowed(response)) return
    const input: Partial<PutAwayRequest> = textBodyOf(request)
    answer(response, putAway(input.code ?? '', input.stockroom ?? ''))
}

export function pickAsset(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!allowed(response)) return
    const input: Partial<PickRequest> = textBodyOf(request)
    answer(response, pick(input.code ?? '', input.order ?? ''))
}

export function listStockrooms(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!allowed(response)) return
    reply(response, 200, { stockrooms: receivingStockrooms() } satisfies StockroomList)
}
