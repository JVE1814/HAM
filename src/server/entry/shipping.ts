// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.
import { GlideDateTime, GlideRecord, gs } from '@servicenow/glide'
import type { RESTAPIRequest, RESTAPIResponse } from '@servicenow/glide/sn_ws_int'
import { buyLabel, nextShipmentStatus, parseTrackingWebhook, tokenMatches, type Address, type LabelResult, type ShipmentStatus } from '../domain/shipping'
import { boolProperty, intProperty, PROPERTY, stringProperty } from '../platform/properties'
import { findById, str } from '../platform/records'
import { restMessagePort } from '../platform/rest-port'
import { queryParam, reply } from '../platform/rest-api'

/** Shipping aggregator: labels for Orders and ship-back returns, tracking webhooks (P3.26, D73). */

export function shippingEnabled(): boolean {
    return boolProperty(PROPERTY.shippingEnabled, false)
}

function aggregator() {
    return restMessagePort('NaaS Shipping aggregator')
}

/** A cmn_location as a carrier address, addressed to `name`. */
function addressOf(locationId: string, name: string, company: string): Address | null {
    const location = findById('cmn_location', locationId)
    if (!location) return null
    return {
        name: name || str(location, 'name'),
        company,
        phone: str(location, 'phone'),
        line1: str(location, 'street'),
        city: str(location, 'city'),
        state: str(location, 'state'),
        postalCode: str(location, 'zip'),
        country: str(location, 'country'),
    }
}

function siteContactName(siteId: string): string {
    const site = findById('cmn_location', siteId)
    const first = site ? str(site, 'x_daas_ham_site_contacts').split(',')[0] : ''
    const contact = first ? findById('customer_contact', first) : null
    return contact ? str(contact, 'name') : ''
}

function depot(): GlideRecord | null {
    return findById('alm_stockroom', stringProperty(PROPERTY.stagingStockroom))
}

interface ShipmentSpec {
    direction: 'to_site' | 'return'
    siteId: string
    /** The Order or Return order, whose `customer` the shipment is for. */
    parent: GlideRecord
    packages: number
    reference: string
    link: { field: 'order' | 'return_order'; id: string }
}

/** Buy a label between the depot and a Site and record the shipment. */
function createShipment(spec: ShipmentSpec): { result: LabelResult; shipmentId?: string } {
    const stockroom = depot()
    if (!stockroom) return { result: { ok: false, error: 'set x_daas_ham.staging.default_stockroom to the depot that ships' } }
    const depotAddress = addressOf(str(stockroom, 'location'), str(stockroom, 'name'), stringProperty(PROPERTY.shippingSenderName))
    const siteAddress = addressOf(spec.siteId, siteContactName(spec.siteId), spec.parent.getDisplayValue('customer'))
    if (!depotAddress || !siteAddress) return { result: { ok: false, error: 'the depot or the Site has no location' } }
    const serviceCode = stringProperty(PROPERTY.shippingServiceCode)
    const result = buyLabel(aggregator(), {
        serviceCode,
        from: spec.direction === 'to_site' ? depotAddress : siteAddress,
        to: spec.direction === 'to_site' ? siteAddress : depotAddress,
        packages: Math.min(Math.max(spec.packages, 1), 20),
        weightKg: intProperty(PROPERTY.shippingPackageKg, 5),
        reference: spec.reference,
    })
    if (!result.ok) return { result }
    const shipment = new GlideRecord('x_daas_ham_shipment')
    shipment.initialize()
    shipment.setValue('direction', spec.direction)
    shipment.setValue(spec.link.field, spec.link.id)
    shipment.setValue('customer', str(spec.parent, 'customer'))
    shipment.setValue('site', spec.siteId)
    shipment.setValue('stockroom', stockroom.getUniqueValue())
    shipment.setValue('carrier', result.carrier)
    shipment.setValue('service_code', serviceCode)
    shipment.setValue('packages', Math.min(Math.max(spec.packages, 1), 20))
    shipment.setValue('tracking_number', result.trackingNumber)
    shipment.setValue('label_id', result.labelId)
    shipment.setValue('label_url', result.labelUrl)
    shipment.setValue('cost', result.cost)
    shipment.setValue('currency', result.currency)
    shipment.setValue('status', 'label_created')
    return { result, shipmentId: shipment.insert() ?? undefined }
}

/** Buy the outbound label for an Order's staged Assets and put its tracking number on the Order (does not save). */
export function labelOrder(order: GlideRecord, packages: number): LabelResult {
    const { result } = createShipment({
        direction: 'to_site',
        siteId: str(order, 'site'),
        parent: order,
        packages,
        reference: str(order, 'number'),
        link: { field: 'order', id: order.getUniqueValue() },
    })
    if (result.ok) {
        order.setValue('carrier', result.carrier)
        order.setValue('tracking_number', result.trackingNumber)
    }
    return result
}

/** UI action "Create return label" on a ship-back Return order: the Site contact prints it. */
export function uiCreateReturnLabel(current: GlideRecord): void {
    const lines = new GlideRecord('x_daas_ham_return_order_line')
    lines.addQuery('return_order', current.getUniqueValue())
    lines.addQuery('status', 'awaiting')
    lines.query()
    const packages = lines.getRowCount()
    if (packages === 0) return void gs.addErrorMessage('Nothing on this return is still awaited')
    const { result } = createShipment({
        direction: 'return',
        siteId: str(current, 'site'),
        parent: current,
        packages,
        reference: str(current, 'number'),
        link: { field: 'return_order', id: current.getUniqueValue() },
    })
    if (!result.ok) return void gs.addErrorMessage(`No label: ${result.error}`)
    current.setValue('work_notes', `Return label ${result.trackingNumber} (${result.carrier}): ${result.labelUrl}`)
    current.update()
    gs.addInfoMessage(`Return label ${result.trackingNumber} created`)
}

/** POST /shipping/tracking?token=...: tracking webhook from the aggregator (no platform login). */
export function postTrackingUpdate(request: RESTAPIRequest, response: RESTAPIResponse): void {
    const token = queryParam(request, 'token')
    if (!tokenMatches(token, gs.getPropertySecured(PROPERTY.shippingWebhookToken, ''))) return reply(response, 401, { error: 'bad token' })
    const update = parseTrackingWebhook(request.body.data)
    if ('error' in update) return reply(response, 400, { error: update.error })
    const shipment = new GlideRecord('x_daas_ham_shipment')
    if (!shipment.get('tracking_number', update.trackingNumber)) return reply(response, 200, { matched: false })

    const previous = str(shipment, 'status') as ShipmentStatus
    const status = nextShipmentStatus(previous, update.status)
    shipment.setValue('status', status)
    if (status === update.status) shipment.setValue('status_detail', update.description.slice(0, 255))
    if (update.estimatedDelivery) shipment.setValue('estimated_delivery', update.estimatedDelivery.slice(0, 10))
    if (status === 'delivered' && previous !== 'delivered') shipment.setValue('delivered_at', glideDateTime(update.deliveredAt))
    shipment.update()
    recordEvents(shipment.getUniqueValue(), update.events)

    if (status === 'delivered' && previous !== 'delivered') {
        const order = findById('x_daas_ham_order', str(shipment, 'order'))
        if (order) {
            order.setValue('work_notes', `Delivered to ${order.getDisplayValue('site')} (${str(shipment, 'carrier')} ${update.trackingNumber}).`)
            order.update()
        }
    }
    reply(response, 200, { matched: true, status })
}

/** A carrier timestamp as a Glide date-time (UTC), or now when it is missing or unreadable. */
function glideDateTime(iso: string | undefined): string {
    const ms = iso ? Date.parse(iso) : NaN
    const value = new GlideDateTime()
    if (Number.isFinite(ms)) value.setNumericValue(ms)
    return value.getValue()
}

/** Add the tracking events not recorded yet (the aggregator resends the whole history). */
function recordEvents(shipmentId: string, events: ReadonlyArray<{ occurredAt: string; status: string; description: string; location: string }>): void {
    const known = new Set<string>()
    const existing = new GlideRecord('x_daas_ham_shipment_event')
    existing.addQuery('shipment', shipmentId)
    existing.query()
    while (existing.next()) known.add(`${str(existing, 'occurred_at')}|${str(existing, 'description')}`)
    for (const event of events) {
        const key = `${event.occurredAt}|${event.description.slice(0, 255)}`
        if (known.has(key)) continue
        known.add(key)
        const record = new GlideRecord('x_daas_ham_shipment_event')
        record.initialize()
        record.setValue('shipment', shipmentId)
        record.setValue('occurred_at', event.occurredAt)
        record.setValue('status', event.status)
        record.setValue('description', event.description.slice(0, 255))
        record.setValue('location', event.location.slice(0, 120))
        record.insert()
    }
}
