// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.
import { GlideRecord, gs } from '@servicenow/glide'
import type { RESTAPIRequest, RESTAPIResponse } from '@servicenow/glide/sn_ws_int'
import { normalizeSerial } from '../domain/asn'
import { ROLE } from '../domain/visibility'
import { findAssetByIdentifier, moveAndSave, moveAsset, newAsset, readStage } from '../platform/assets'
import { loadNormalizationData, resolveModel } from '../platform/normalization'
import { PROPERTY, stringProperty } from '../platform/properties'
import { str } from '../platform/records'
import { openStagingTask } from '../platform/staging-tasks'
import { nextProviderTag } from '../platform/tags'

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

function reply(response: RESTAPIResponse, status: number, body: object): void {
    response.setStatus(status)
    response.setBody(body as never)
}

function allowed(response: RESTAPIResponse): boolean {
    if (gs.hasRole(ROLE.inventoryTech) || gs.hasRole(ROLE.fieldTech)) return true
    reply(response, 403, { error: 'Requires the inventory tech or field tech role' })
    return false
}

/** A stockroom the user may see (the stockroom visibility rule applies to this lookup). */
function visibleStockroom(stockroomId: string | undefined): boolean {
    if (!stockroomId) return false
    const stockroom = new GlideRecord('alm_stockroom')
    return stockroom.get(stockroomId)
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

    if (!visibleStockroom(input.stockroom)) return reply(response, 400, { error: 'Choose one of your stockrooms' })

    let asset = findAssetByIdentifier(input.code, { beyondVisibility: true })
    if (!asset) {
        if (!input.pid) return reply(response, 404, { error: 'Unknown serial: scan the PID too to receive without an ASN' })
        const created = createReceivedAsset(input)
        if ('error' in created) return reply(response, 422, created)
        asset = created.asset
    }
    const verdict = moveAsset(asset, 'available')
    if (!verdict.allowed) return reply(response, 409, { error: `Already received (${readStage(asset)})` })
    asset.setValue('stockroom', input.stockroom)
    if (!str(asset, 'asset_tag')) asset.setValue('asset_tag', nextProviderTag())
    asset.update()
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
    asset.insert()
    return { asset }
}

/** A received purchase goes straight to the Order line that requested it. */
function allocateToWaitingLine(asset: GlideRecord): void {
    const poNumber = str(asset, 'po_number')
    if (!poNumber) return
    const line = new GlideRecord('x_daas_ham_order_line')
    line.addQuery('purchase_order.number', poNumber)
    line.addQuery('model', str(asset, 'model'))
    line.addQuery('line_stage', 'awaiting_stock')
    line.setLimit(1)
    line.query()
    if (!line.next()) return
    if (!moveAsset(asset, 'reserved').allowed) return
    asset.setValue('x_daas_ham_order_line', line.getUniqueValue())
    asset.setValue('company', str(line, 'order.customer'))
    asset.setValue('x_daas_ham_agreement', str(line, 'order.agreement'))
    asset.update()
    openStagingTask(asset, line.getUniqueValue())
    moveAndSave(asset, 'staging', 'receiving')
}

/** POST /putaway { code, stockroom }: record where an in-stock asset now sits. */
export function putAwayAsset(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!allowed(response)) return
    const input = body(request)
    if (!visibleStockroom(input.stockroom)) return reply(response, 400, { error: 'Choose one of your stockrooms' })
    const asset = findAssetByIdentifier(input.code ?? '')
    if (!asset) return reply(response, 404, { error: 'No asset with that serial or tag' })
    if (str(asset, 'install_status') !== '6') return reply(response, 409, { error: 'Only in-stock assets can be put away' })
    asset.setValue('stockroom', input.stockroom)
    asset.update()
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
    stockroom.addQuery('x_daas_ham_stockroom_type', 'IN', 'central_depot,staging_centre')
    stockroom.orderBy('name')
    stockroom.setLimit(500)
    stockroom.query()
    const list: Array<{ id: string; name: string; type: string }> = []
    while (stockroom.next()) {
        list.push({ id: stockroom.getUniqueValue(), name: str(stockroom, 'name'), type: str(stockroom, 'x_daas_ham_stockroom_type') })
    }
    reply(response, 200, { stockrooms: list })
}
