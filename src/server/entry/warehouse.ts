// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.
import { GlideRecord, gs } from '@servicenow/glide'
import type { RESTAPIRequest, RESTAPIResponse } from '@servicenow/glide/sn_ws_int'
import { normalizeSerial } from '../domain/asn'
import type { StockroomType } from '../domain/sourcing'
import { ROLE } from '../domain/visibility'
import { awaitsReceipt, putAwayProblem, RECEIVING_STOCKROOM_TYPES, receivingProblem } from '../domain/warehouse'
import { findAssetByIdentifier, moveAndSave, moveAsset, newAsset, readStage } from '../platform/assets'
import { loadNormalizationData, resolveModel } from '../platform/normalization'
import { PROPERTY, stringProperty } from '../platform/properties'
import { lineAwaitingRma } from '../platform/oem-rma'
import { purchaseOrderId } from '../platform/procurement'
import { findById, num, refusal, str } from '../platform/records'
import { openStagingTask } from '../platform/staging-tasks'
import { nextProviderTag } from '../platform/tags'
import { receiveReturnedAsset } from './returns'
import { reply } from '../platform/rest-api'

/** Warehouse scanning API used by the warehouse React app (P1.5). */

interface AssetSummary {
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

function summarise(asset: GlideRecord): AssetSummary {
    return {
        id: asset.getUniqueValue(),
        serial: str(asset, 'serial_number'),
        providerTag: str(asset, 'asset_tag'),
        customerTag: str(asset, 'x_daas_ham_customer_tag'),
        model: asset.getDisplayValue('model'),
        pid: str(asset, 'model.x_daas_ham_oem_pid'),
        stage: readStage(asset) ?? 'unknown',
        stockroom: asset.getDisplayValue('stockroom'),
        customer: asset.getDisplayValue('company'),
        orderLine: asset.getDisplayValue('x_daas_ham_order_line'),
    }
}

function allowed(response: RESTAPIResponse): boolean {
    if (gs.hasRole(ROLE.inventoryTech) || gs.hasRole(ROLE.fieldTech)) return true
    reply(response, 403, { error: 'Requires the inventory tech or field tech role' })
    return false
}

/** The stockroom, if the user may see it (the stockroom visibility rule applies to this lookup). */
function visibleStockroom(stockroomId: string | undefined): GlideRecord | null {
    return findById('alm_stockroom', stockroomId ?? '')
}

/** The stockroom's type; a stockroom saved without one counts as a central depot, the field's default. */
function stockroomType(stockroom: GlideRecord): StockroomType {
    return (str(stockroom, 'x_daas_ham_stockroom_type') || 'central_depot') as StockroomType
}

function body(request: RESTAPIRequest): Record<string, string> {
    const data = request.body.data as Record<string, unknown> | null
    return Object.fromEntries(Object.entries(data ?? {}).map(([k, v]) => [k, String(v ?? '').trim()]))
}

/** GET /assets/{code}: look an asset up by serial, Provider tag or Customer tag. */
export function lookupAsset(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!allowed(response)) return
    const asset = findAssetByIdentifier(String(request.pathParams.code ?? ''))
    if (!asset) return reply(response, 404, { error: 'No asset with that serial or tag' })
    reply(response, 200, summarise(asset))
}

/**
 * POST /receive { code, stockroom, pid?, manufacturer? }: confirm an in-transit asset (ASN) or create
 * one received without an ASN; tag it and allocate it to an Order line waiting for this purchase.
 */
export function receiveAsset(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!allowed(response)) return
    const input = body(request)
    if (!input.code || !input.stockroom) return reply(response, 400, { error: 'code and stockroom are required' })

    const stockroom = visibleStockroom(input.stockroom)
    if (!stockroom) return reply(response, 400, { error: 'Choose one of your stockrooms' })
    // A visible stockroom may be a customer site (field techs see them all); units arrive only at the Provider's own.
    const wrongStockroom = receivingProblem(stockroomType(stockroom))
    if (wrongStockroom) return reply(response, 400, { error: wrongStockroom })

    // Arriving units (bought or returned) sit in none of the user's stockrooms yet, so the lookup goes past the stockroom
    // rule; only those stages are received below, never stock held elsewhere.
    let asset = findAssetByIdentifier(input.code, { beyondVisibility: true })
    if (!asset) {
        if (!input.pid) return reply(response, 404, { error: 'Unknown serial: scan the PID too to receive without an ASN' })
        const created = createReceivedAsset(input)
        if ('error' in created) return reply(response, 422, created)
        asset = created.asset
    }
    // A unit coming back from a Site is received ('') or refused, staying pending return (or missing) for a rescan, and
    // its unsaved move is not shown. Any other unit (null) is received as stock below.
    const returnRefusal = receiveReturnedAsset(asset, input.stockroom)
    if (returnRefusal) return reply(response, 422, { error: `Not received: ${returnRefusal}` })
    if (returnRefusal === '') return reply(response, 200, summarise(asset))
    const stage = readStage(asset)
    if (!awaitsReceipt(stage) || !moveAsset(asset, 'available').allowed) {
        return reply(response, 409, { error: `Not awaiting receipt (${stage ?? 'unknown stage'})` })
    }
    const tag = str(asset, 'asset_tag') || nextProviderTag()
    if (!tag) return reply(response, 503, { error: 'Other receipts are taking Provider tags: scan again' })
    asset.setValue('asset_tag', tag)
    asset.setValue('stockroom', input.stockroom)
    // A refused save leaves the unit in transit or on order for a rescan, and allocates nothing.
    if (!asset.update()) return reply(response, 422, { error: `Not received: ${refusal(asset)}` })
    allocateToWaitingLine(asset)
    reply(response, 200, summarise(asset))
}

function createReceivedAsset(input: Record<string, string>): { asset: GlideRecord } | { error: string } {
    const resolution = resolveModel({ manufacturer: input.manufacturer ?? '', model: input.pid }, loadNormalizationData())
    if (!resolution.modelId) return { error: `PID ${input.pid} does not map to a model` }
    const asset = newAsset(resolution.modelId, 'on_order')
    asset.setValue('serial_number', normalizeSerial(input.code))
    asset.setValue('company', stringProperty(PROPERTY.providerCompany))
    asset.setValue('x_daas_ham_legal_owner', 'provider')
    if (!asset.insert()) return { error: `Not received: ${refusal(asset)}` }
    return { asset }
}

/**
 * A received purchase (or OEM advance replacement, announced with its RMA number in the PO field)
 * goes straight to the Order line waiting for it.
 */
function allocateToWaitingLine(asset: GlideRecord): void {
    const poNumber = str(asset, 'po_number')
    if (!poNumber) return
    const line = new GlideRecord('x_daas_ham_order_line')
    const viaRma = lineAwaitingRma(poNumber, str(asset, 'model'))
    if (viaRma) {
        if (!line.get(viaRma.lineId)) return
        const rma = findById('x_daas_ham_oem_rma', viaRma.rmaId)
        rma?.setValue('state', 'replacement_received')
        rma?.setValue('replacement_serial', str(asset, 'serial_number'))
        // The unit still goes to its line, which needs it; an RMA left open counts as a replacement still to come.
        if (rma && !rma.update()) {
            gs.warn(`[x_daas_ham] RMA ${str(rma, 'rma_number')} not marked replacement received: ${refusal(rma)}`)
        }
    } else {
        // A line lists every purchase order it raised, so units of an earlier one still find it.
        const poId = purchaseOrderId(poNumber)
        if (!poId) return
        line.addQuery('purchase_orders', 'CONTAINS', poId)
        line.addQuery('model', str(asset, 'model'))
        line.addQuery('line_stage', 'awaiting_stock')
        line.setLimit(1)
        line.query()
        if (!line.next()) return
        // Arrived, so no longer on order: re-sourcing covers quantity - allocated - on order and must not wait for it.
        // A refused count is logged to correct by hand; the unit still goes to the line, which would otherwise wait.
        line.setValue('quantity_to_purchase', Math.max(0, num(line, 'quantity_to_purchase') - 1))
        if (!line.update()) gs.warn(`[x_daas_ham] ${str(line, 'number')} keeps a unit on order: ${refusal(line)}`)
    }
    if (!moveAsset(asset, 'reserved').allowed) return
    asset.setValue('x_daas_ham_order_line', line.getUniqueValue())
    asset.setValue('company', str(line, 'order.customer'))
    asset.setValue('x_daas_ham_agreement', str(line, 'order.agreement'))
    if (!asset.update()) {
        // The receipt is saved; the reservation is not, so no Staging task opens and the reply shows the unit as saved.
        gs.warn(`[x_daas_ham] Received ${str(asset, 'serial_number')} not reserved for its Order line: ${refusal(asset)}`)
        asset.get(asset.getUniqueValue())
        return
    }
    // Without its Staging task the Asset stays reserved for the line, not staging with no task to finish. A refused
    // move (moveAndSave warns) leaves it reserved too, so it is read again for the reply, as above.
    if (!openStagingTask(asset, line.getUniqueValue())) return
    if (!moveAndSave(asset, 'staging', 'receiving')) asset.get(asset.getUniqueValue())
}

/** POST /putaway { code, stockroom }: record the stockroom an in-stock asset now sits in, when it is free to move there. */
export function putAwayAsset(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!allowed(response)) return
    const input = body(request)
    const stockroom = visibleStockroom(input.stockroom)
    if (!stockroom) return reply(response, 400, { error: 'Choose one of your stockrooms' })
    const asset = findAssetByIdentifier(input.code ?? '')
    if (!asset) return reply(response, 404, { error: 'No asset with that serial or tag' })
    const problem = putAwayProblem(readStage(asset), stockroomType(stockroom))
    if (problem) return reply(response, 409, { error: problem })
    asset.setValue('stockroom', input.stockroom)
    if (!asset.update()) return reply(response, 422, { error: `Not put away: ${refusal(asset)}` })
    reply(response, 200, summarise(asset))
}

/** POST /pick { code, order }: confirm a scanned asset is a staged asset of this Order. */
export function pickAsset(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!allowed(response)) return
    const input = body(request)
    const asset = findAssetByIdentifier(input.code ?? '')
    if (!asset) return reply(response, 404, { error: 'No asset with that serial or tag' })
    const orderNumber = str(asset, 'x_daas_ham_order_line.order.number')
    if (orderNumber !== input.order) {
        return reply(response, 409, { error: orderNumber ? `Belongs to ${orderNumber}` : 'Not allocated to an order' })
    }
    if (readStage(asset) !== 'staged') return reply(response, 409, { error: `Not ready to ship (${readStage(asset)})` })
    reply(response, 200, summarise(asset))
}

/** GET /stockrooms: stockrooms the user may receive into (visibility rules apply). */
export function listStockrooms(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!allowed(response)) return
    const stockroom = new GlideRecord('alm_stockroom')
    stockroom.addQuery('x_daas_ham_stockroom_type', 'IN', RECEIVING_STOCKROOM_TYPES.join(','))
    stockroom.orderBy('name')
    stockroom.setLimit(500)
    stockroom.query()
    const list: Array<{ id: string; name: string; type: string }> = []
    while (stockroom.next()) {
        list.push({ id: stockroom.getUniqueValue(), name: str(stockroom, 'name'), type: str(stockroom, 'x_daas_ham_stockroom_type') })
    }
    reply(response, 200, { stockrooms: list })
}
