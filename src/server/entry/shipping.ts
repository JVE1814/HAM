// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.
import { GlideRecord, gs } from '@servicenow/glide'
import type { RESTAPIRequest, RESTAPIResponse } from '@servicenow/glide/sn_ws_int'
import {
    applyTracking,
    buyLabel,
    labelVoidable,
    newTrackingEvents,
    parseTrackingWebhook,
    tokenMatches,
    trackingEventKey,
    WEBHOOK_TOKEN_HEADER,
    webhookToken,
    type Address,
    type LabelResult,
    type ShipmentStatus,
    type TrackingEvent,
} from '../domain/shipping'
import { msToGlide, nowMs } from '../platform/clock'
import { boolProperty, intProperty, PROPERTY, stagingStockroom, stringProperty } from '../platform/properties'
import { count, findById, str } from '../platform/records'
import { restMessagePort } from '../platform/rest-port'
import { queryParam, reply } from '../platform/rest-api'
import { returnLabels } from '../platform/shipments'

/** Shipping aggregator: labels for Orders and ship-back returns, tracking webhooks (P3.26, D73). */

export function shippingEnabled(): boolean {
    return boolProperty(PROPERTY.shippingEnabled, false)
}

function aggregator() {
    return restMessagePort('NaaS Shipping aggregator')
}

/** A cmn_location as a carrier address for `contact` (a name and phone; the location's phone first). */
function addressOf(location: GlideRecord, contact: { name: string; phone: string }, company: string): Address {
    return {
        name: contact.name || str(location, 'name'),
        company,
        phone: str(location, 'phone') || contact.phone,
        line1: str(location, 'street'),
        city: str(location, 'city'),
        state: str(location, 'state'),
        postalCode: str(location, 'zip'),
        country: str(location, 'country'),
    }
}

/** A Site's first contact: name and phone (business, else mobile); empty when it has none. */
function siteContact(site: GlideRecord): { name: string; phone: string } {
    const first = str(site, 'x_daas_ham_site_contacts').split(',')[0]
    const contact = first ? findById('customer_contact', first) : null
    return contact ? { name: str(contact, 'name'), phone: str(contact, 'phone') || str(contact, 'mobile_phone') } : { name: '', phone: '' }
}

function depot(): GlideRecord | null {
    return findById('alm_stockroom', stagingStockroom())
}

/**
 * Buy a label between the depot and the Site of `parent` (an Order shipping `to_site`, or a Return order
 * shipping back as a `return`) and record the shipment against it. `packages` is one box per Asset
 * (buyLabel refuses more than one label covers); the label carries the parent's number as its reference.
 */
function createShipment(direction: 'to_site' | 'return', parent: GlideRecord, packages: number): LabelResult {
    const carrierId = stringProperty(PROPERTY.shippingCarrierId)
    if (!carrierId) return { ok: false, error: `set ${PROPERTY.shippingCarrierId} to the ShipEngine carrier account (se-...) billed for labels` }
    const stockroom = depot()
    if (!stockroom) return { ok: false, error: `set ${PROPERTY.stagingStockroom} to the depot that ships` }
    const siteId = str(parent, 'site')
    const depotLocation = findById('cmn_location', str(stockroom, 'location'))
    const site = findById('cmn_location', siteId)
    if (!depotLocation || !site) return { ok: false, error: 'the depot or the Site has no location' }
    const depotAddress = addressOf(depotLocation, { name: str(stockroom, 'name'), phone: stringProperty(PROPERTY.shippingSenderPhone) }, stringProperty(PROPERTY.shippingSenderName))
    const siteAddress = addressOf(site, siteContact(site), parent.getDisplayValue('customer'))
    const serviceCode = stringProperty(PROPERTY.shippingServiceCode)
    const result = buyLabel(aggregator(), {
        carrierId,
        serviceCode,
        from: direction === 'to_site' ? depotAddress : siteAddress,
        to: direction === 'to_site' ? siteAddress : depotAddress,
        packages,
        weightKg: intProperty(PROPERTY.shippingPackageKg, 5),
        reference: str(parent, 'number'),
    })
    if (!result.ok) return result
    const shipment = new GlideRecord('x_daas_ham_shipment')
    shipment.initialize()
    shipment.setValue('direction', direction)
    shipment.setValue(direction === 'to_site' ? 'order' : 'return_order', parent.getUniqueValue())
    shipment.setValue('customer', str(parent, 'customer'))
    shipment.setValue('site', siteId)
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
    const result = createShipment('to_site', order, packages)
    if (result.ok) {
        order.setValue('carrier', result.carrier)
        order.setValue('tracking_number', result.trackingNumber)
    }
    return result
}

/** UI action "Create return label" on a ship-back Return order: the Site contact prints it. */
export function uiCreateReturnLabel(current: GlideRecord): void {
    const returnOrderId = current.getUniqueValue()
    const packages = count('x_daas_ham_return_order_line', `return_order=${returnOrderId}^status=awaiting`)
    if (packages === 0) return void gs.addErrorMessage('Nothing on this return is still awaited')
    // Each label is paid for: one open return label per Return order (to replace it, void it and mark it voided).
    const open = returnLabels([returnOrderId]).get(returnOrderId)
    if (open) {
        const step = 'void it with the carrier, then use Mark label voided on its Shipment, before buying another'
        return void gs.addErrorMessage(`Return label ${open.trackingNumber} is still open; ${step}`)
    }
    const result = createShipment('return', current, packages)
    if (!result.ok) return void gs.addErrorMessage(`No label: ${result.error}`)
    current.setValue('work_notes', `Return label ${result.trackingNumber} (${result.carrier}): ${result.labelUrl}`)
    current.update()
    gs.addInfoMessage(`Return label ${result.trackingNumber} created`)
}

/**
 * UI action "Mark label voided" on a return Shipment, once the person voided the label with the carrier
 * (nothing is sent to the aggregator): the label stops counting as open, so the Return order can get a
 * new one and the customer page stops offering it.
 */
export function uiMarkLabelVoided(current: GlideRecord): void {
    const trackingNumber = str(current, 'tracking_number')
    if (!labelVoidable(str(current, 'status') as ShipmentStatus)) {
        const status = current.getDisplayValue('status')
        return void gs.addErrorMessage(`Label ${trackingNumber} is ${status}, so it cannot be marked voided`)
    }
    current.setValue('status', 'voided')
    current.setValue('status_detail', `Voided with the carrier (marked by ${gs.getUserDisplayName()})`)
    current.update()
    const returnOrder = findById('x_daas_ham_return_order', str(current, 'return_order'))
    if (returnOrder) {
        returnOrder.setValue('work_notes', `Return label ${trackingNumber} voided with the carrier: do not ship on it.`)
        returnOrder.update()
    }
    gs.addInfoMessage(`Label ${trackingNumber} marked voided`)
}

/**
 * POST /shipping/tracking: tracking webhook from the aggregator (no platform login), authenticated by
 * the X-NaaS-Webhook-Token header, or by ?token= when the header is absent.
 */
export function postTrackingUpdate(request: RESTAPIRequest, response: RESTAPIResponse): void {
    const token = webhookToken(request.getHeader(WEBHOOK_TOKEN_HEADER), queryParam(request, 'token'))
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
