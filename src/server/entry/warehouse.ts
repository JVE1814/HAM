import { gs, type GlideRecord } from '@servicenow/glide'
import type { RESTAPIRequest, RESTAPIResponse } from '@servicenow/glide/sn_ws_int'
import type { AssetSummary, StockroomList } from '../domain/rest-contracts.ts'
import { ROLE } from '../domain/visibility.ts'
import { readStage } from '../platform/assets.ts'
import { lookUp, pick, putAway, receive, receivingStockrooms, type Scan, type ScanRefusal } from '../platform/receiving.ts'
import { str } from '../platform/records.ts'
import { reply } from '../platform/rest-api.ts'

/** Warehouse scanning API used by the warehouse React app (P1.5): platform/receiving. */

function summarise(asset: GlideRecord): AssetSummary {
    return {
        id: asset.getUniqueValue(),
        serial: str(asset, 'serial_number'),
        providerTag: str(asset, 'asset_tag'),
        model: asset.getDisplayValue('model'),
        pid: str(asset, 'model.x_daas_ham_oem_pid'),
        stage: readStage(asset) ?? 'unknown',
        stockroom: asset.getDisplayValue('stockroom'),
        customer: asset.getDisplayValue('company'),
        orderLine: asset.getDisplayValue('x_daas_ham_order_line'),
    }
}

/** The HTTP status each kind of refused scan answers with (platform/receiving `ScanRefusal`). */
const REFUSAL_STATUS: Record<ScanRefusal['reason'], number> = {
    invalid: 400,
    unknown: 404,
    conflict: 409,
    refused: 422,
    busy: 503,
}

/** Answer a scan: the Asset as it now stands, or the error and status of its refusal. */
function answer(response: RESTAPIResponse, scan: Scan): void {
    if ('asset' in scan) return reply(response, 200, summarise(scan.asset))
    reply(response, REFUSAL_STATUS[scan.reason], { error: scan.why })
}

/** Receive, put away, pick and the stockroom list are depot work: inventory techs (asset managers and admins too). */
function allowed(response: RESTAPIResponse): boolean {
    if (gs.hasRole(ROLE.inventoryTech)) return true
    reply(response, 403, { error: 'Requires the inventory tech role' })
    return false
}

/** A look-up only reads the Asset, so field techs, who read every Asset, may look up too. */
function allowedLookup(response: RESTAPIResponse): boolean {
    if (gs.hasRole(ROLE.inventoryTech) || gs.hasRole(ROLE.fieldTech)) return true
    reply(response, 403, { error: 'Requires the inventory tech or field tech role' })
    return false
}

function body(request: RESTAPIRequest): Record<string, string> {
    const data = request.body.data as Record<string, unknown> | null
    return Object.fromEntries(Object.entries(data ?? {}).map(([k, v]) => [k, String(v ?? '').trim()]))
}

/** GET /assets/{code}: look a fleet asset up by serial, Provider tag or Customer tag (not the Provider IT's). */
export function lookupAsset(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!allowedLookup(response)) return
    answer(response, lookUp(String(request.pathParams.code ?? '')))
}

/**
 * POST /receive { code, stockroom, pid?, manufacturer? }: confirm an in-transit asset (ASN) or create one received
 * without an ASN; tag it and allocate it to an Order line waiting for this purchase (platform/receiving `receive`).
 */
export function receiveAsset(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!allowed(response)) return
    const input = body(request)
    if (!input.code || !input.stockroom) return reply(response, 400, { error: 'code and stockroom are required' })
    answer(response, receive({ code: input.code, pid: input.pid, manufacturer: input.manufacturer }, input.stockroom))
}

/** POST /putaway { code, stockroom }: record the stockroom an in-stock asset now sits in (platform/receiving `putAway`). */
export function putAwayAsset(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!allowed(response)) return
    const input = body(request)
    answer(response, putAway(input.code ?? '', input.stockroom ?? ''))
}

/** POST /pick { code, order }: confirm a scanned fleet asset is a staged asset of this Order. */
export function pickAsset(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!allowed(response)) return
    const input = body(request)
    answer(response, pick(input.code ?? '', input.order))
}

/** GET /stockrooms: stockrooms the user may receive into (visibility rules apply). */
export function listStockrooms(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!allowed(response)) return
    reply(response, 200, { stockrooms: receivingStockrooms() } satisfies StockroomList)
}
