// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.
import { GlideRecord, gs } from '@servicenow/glide'
import type { RESTAPIRequest, RESTAPIResponse } from '@servicenow/glide/sn_ws_int'
import {
    applyTracking,
    buyLabel,
    newTrackingEvents,
    packageCount,
    parseTrackingWebhook,
    tokenMatches,
    trackingEventKey,
    type Address,
    type LabelResult,
    type ShipmentStatus,
    type TrackingEvent,
} from '../domain/shipping'
import { msToGlide, nowMs } from '../platform/clock'
import { boolProperty, intProperty, PROPERTY, stringProperty } from '../platform/properties'
import { count, findById, str } from '../platform/records'
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
function addressOf(location: GlideRecord, name: string, company: string): Address {
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

/** The name of a Site's first contact, or '' when it has none. */
function siteContactName(site: GlideRecord): string {
    const first = str(site, 'x_daas_ham_site_contacts').split(',')[0]
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
function createShipment(spec: ShipmentSpec): LabelResult {
    const stockroom = depot()
    if (!stockroom) return { ok: false, error: 'set x_daas_ham.staging.default_stockroom to the depot that ships' }
    const depotLocation = findById('cmn_location', str(stockroom, 'location'))
    const site = findById('cmn_location', spec.siteId)
    if (!depotLocation || !site) return { ok: false, error: 'the depot or the Site has no location' }
    const depotAddress = addressOf(depotLocation, str(stockroom, 'name'), stringProperty(PROPERTY.shippingSenderName))
    const siteAddress = addressOf(site, siteContactName(site), spec.parent.getDisplayValue('customer'))
    const serviceCode = stringProperty(PROPERTY.shippingServiceCode)
    const packages = packageCount(spec.packages)
    const result = buyLabel(aggregator(), {
        serviceCode,
        from: spec.direction === 'to_site' ? depotAddress : siteAddress,
        to: spec.direction === 'to_site' ? siteAddress : depotAddress,
        packages,
        weightKg: intProperty(PROPERTY.shippingPackageKg, 5),
        reference: spec.reference,
    })
    if (!result.ok) return result
    const shipment = new GlideRecord('x_daas_ham_shipment')
    shipment.initialize()
    shipment.setValue('direction', spec.direction)
    shipment.setValue(spec.link.field, spec.link.id)
    shipment.setValue('customer', str(spec.parent, 'customer'))
    shipment.setValue('site', spec.siteId)
    shipment.setValue('stockroom', stockroom.getUniqueValue())
    shipment.setValue('carrier', result.carrier)
    shipment.setValue('service_code', serviceCode)
    shipment.setValue('packages', packages)
    shipment.setValue('tracking_number', result.trackingNumber)
    shipment.setValue('label_id', result.labelId)
    shipment.setValue('label_url', result.labelUrl)
    shipment.setValue('cost', result.cost)
    shipment.setValue('currency', result.currency)
    shipment.setValue('status', 'label_created')
    shipment.insert()
    return result
}

/** Buy the outbound label for an Order's staged Assets and put its tracking number on the Order (does not save). */
export function labelOrder(order: GlideRecord, packages: number): LabelResult {
    const result = createShipment({
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
    const packages = count('x_daas_ham_return_order_line', `return_order=${current.getUniqueValue()}^status=awaiting`)
    if (packages === 0) return void gs.addErrorMessage('Nothing on this return is still awaited')
    const result = createShipment({
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

    const { status, detail, deliveredNow } = applyTracking(str(shipment, 'status') as ShipmentStatus, update)
    shipment.setValue('status', status)
    if (detail !== undefined) shipment.setValue('status_detail', detail)
    if (update.estimatedDelivery) shipment.setValue('estimated_delivery', update.estimatedDelivery)
    if (deliveredNow) {
        const deliveredMs = Date.parse(update.deliveredAt ?? '')
        shipment.setValue('delivered_at', msToGlide(Number.isFinite(deliveredMs) ? deliveredMs : nowMs()))
    }
    shipment.update()
    recordEvents(shipment.getUniqueValue(), update.events)

    if (deliveredNow) {
        const order = findById('x_daas_ham_order', str(shipment, 'order'))
        if (order) {
            order.setValue('work_notes', `Delivered to ${order.getDisplayValue('site')} (${str(shipment, 'carrier')} ${update.trackingNumber}).`)
            order.update()
        }
    }
    reply(response, 200, { matched: true, status })
}

/** Add the tracking events not recorded yet (the aggregator resends the whole history). */
function recordEvents(shipmentId: string, events: readonly TrackingEvent[]): void {
    const known = new Set<string>()
    const existing = new GlideRecord('x_daas_ham_shipment_event')
    existing.addQuery('shipment', shipmentId)
    existing.query()
    while (existing.next()) known.add(trackingEventKey({ occurredAt: str(existing, 'occurred_at'), description: str(existing, 'description') }))
    for (const event of newTrackingEvents(known, events)) {
        const record = new GlideRecord('x_daas_ham_shipment_event')
        record.initialize()
        record.setValue('shipment', shipmentId)
        record.setValue('occurred_at', event.occurredAt)
        record.setValue('status', event.status)
        record.setValue('description', event.description)
        record.setValue('location', event.location)
        record.insert()
    }
}
