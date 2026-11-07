// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.
import { GlideRecord, gs } from '@servicenow/glide'
import type { RESTAPIRequest, RESTAPIResponse } from '@servicenow/glide/sn_ws_int'
import {
    applyTracking,
    buyLabel,
    labelVoidable,
    newTrackingEvents,
    OPEN_SHIPMENTS,
    parseTrackingWebhook,
    returnLabelRefusal,
    tokenMatches,
    trackingEventKey,
    WEBHOOK_TOKEN_HEADER,
    webhookToken,
    type Address,
    type LabelResult,
    type ShipmentStatus,
    type TrackingEvent,
    type TrackingUpdate,
} from '../domain/shipping'
import { msToGlide, nowMs } from '../platform/clock'
import { withLock, withLockTries, type HeldLock } from '../platform/locks'
import { boolProperty, intProperty, PROPERTY, stagingStockroom, stringProperty } from '../platform/properties'
import { count, findById, refusal, str } from '../platform/records'
import { restMessagePort } from '../platform/rest-port'
import { queryParam, reply } from '../platform/rest-api'

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
 * A label bought whose Shipment the platform refuses is a failure that names the label, not a success.
 * The caller holds `lock` on the parent so that two requests do not both buy its label. A holder that outlasted it
 * (ADR 0013) may overlap the request that took it over: it buys only while it holds it, and one that lost it during the
 * purchase is logged, as both may have bought one.
 */
function createShipment(
    direction: 'to_site' | 'return',
    parent: GlideRecord,
    packages: number,
    lock: HeldLock,
): LabelResult {
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
    if (!lock.held()) return { ok: false, error: 'another request took over buying this label: reload to see it' }
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
    const label = `${result.carrier} ${result.trackingNumber}, label ${result.labelId}`
    if (shipment.insert()) {
        const late = `Label ${label} bought for ${str(parent, 'number')} after its lock was lost`
        if (!lock.held()) gs.warn(`[x_daas_ham] ${late}: void any second label bought for it meanwhile`)
        return result
    }
    // The label is paid for, yet tracking, a later Ship and the open-label check cannot find it: name it to be voided.
    const reason = refusal(shipment)
    gs.warn(`[x_daas_ham] Label bought for ${str(parent, 'number')} but no Shipment saved (${label}): ${reason}`)
    return { ok: false, error: `the label bought (${label}) was not recorded: ${reason}. Void it with the carrier` }
}

/**
 * Buy the outbound label for an Order's staged Assets and put its tracking number on the Order (does not save). The
 * caller holds `lock` on the Order (entry/delivery shipOrder).
 */
export function labelOrder(order: GlideRecord, packages: number, lock: HeldLock): LabelResult {
    const result = createShipment('to_site', order, packages, lock)
    if (result.ok) {
        order.setValue('carrier', result.carrier)
        order.setValue('tracking_number', result.trackingNumber)
    }
    return result
}

/**
 * UI action "Create return label" on a ship-back Return order: the Site contact prints it.
 *
 * Each label is paid for: one open return label per Return order (to replace it, void it and mark it voided). Two users
 * pressing this while the first purchase is in flight would both find none open, so the check, the purchase and the
 * Shipment are made under a lock on the Return order; one that finds it held buys nothing and is told a label is being
 * bought. Taking the lock throws only when an insert is refused with no lock row (platform/locks); that error escapes.
 */
export function uiCreateReturnLabel(current: GlideRecord): void {
    const returnOrderId = current.getUniqueValue()
    const packages = count('x_daas_ham_return_order_line', `return_order=${returnOrderId}^status=awaiting`)
    if (packages === 0) return void gs.addErrorMessage('Nothing on this return is still awaited')
    // Set inside the lock; left null when an open label is found there.
    let result = null as LabelResult | null
    const taken = withLock(`return_label_${returnOrderId}`, (lock) => {
        const open = openReturnLabel(returnOrderId)
        if (open) return void gs.addErrorMessage(returnLabelRefusal(open.trackingNumber, open.status))
        result = createShipment('return', current, packages, lock)
    })
    if (!taken) {
        return void gs.addErrorMessage('A return label is already being bought for this return: reload it to see it')
    }
    if (!result) return
    if (!result.ok) return void gs.addErrorMessage(`No label: ${result.error}`)
    current.setValue('work_notes', `Return label ${result.trackingNumber} (${result.carrier}): ${result.labelUrl}`)
    current.update()
    gs.addInfoMessage(`Return label ${result.trackingNumber} created`)
}

/** The Return order's latest return label still in use (as platform/shipments returnLabels finds it), with its status. */
function openReturnLabel(returnOrderId: string): { trackingNumber: string; status: ShipmentStatus } | null {
    const shipment = new GlideRecord('x_daas_ham_shipment')
    shipment.addEncodedQuery(`direction=return^${OPEN_SHIPMENTS}^return_order=${returnOrderId}`)
    shipment.orderByDesc('sys_created_on')
    shipment.setLimit(1)
    shipment.query()
    if (!shipment.next()) return null
    return { trackingNumber: str(shipment, 'tracking_number'), status: str(shipment, 'status') as ShipmentStatus }
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
    // A refused form save (the platform says why) leaves the label open: the Return order is not told it is voided.
    if (!current.update()) return
    const returnOrder = findById('x_daas_ham_return_order', str(current, 'return_order'))
    if (returnOrder) {
        returnOrder.setValue('work_notes', `Return label ${trackingNumber} voided with the carrier: do not ship on it.`)
        returnOrder.update()
    }
    gs.addInfoMessage(`Label ${trackingNumber} marked voided`)
}

/**
 * Tries at taking a Shipment's tracking lock, back to back: a holder keeps it for one status save and that update's new
 * events only, and a delivery held off is answered at once (EasyPost waits 7 s) for the aggregator to send again.
 */
const TRACKING_LOCK_TRIES = 5

/** What a tracking update did to its Shipment under the lock: why it was not saved, or its status and what follows. */
type Tracked =
    | { error: string }
    | { status: ShipmentStatus; deliveredNow: boolean; orderId: string; carrier: string; unrecorded: number }

/**
 * POST /shipping/tracking: tracking webhook from the aggregator (no platform login), authenticated by
 * the X-NaaS-Webhook-Token header, or by ?token= when the header is absent. A Shipment or tracking event
 * the platform refuses is answered 500, not as a success, so an aggregator that retries failed deliveries
 * (EasyPost does) sends the update again; a retry is harmless, as the events already stored are skipped
 * and a saved delivery is not noted twice.
 *
 * Deliveries can overlap (a retry sent while a slow first try runs, or two updates moments apart): both reading the
 * Shipment and its events before the other saved, both would insert the same events, and an older status could replace
 * a delivery or note it twice. So each is applied under the lock `track_shipment_<sys_id>`, from the Shipment and its
 * events read again there; one held off through every try saves nothing and is answered 503 to be sent again. The lock
 * is taken alone and takes no other (the Order is noted after it). Taking it throws only when an insert is refused with
 * no lock row (platform/locks `withLockTries` tries again, and that error escapes only when every try threw).
 */
export function postTrackingUpdate(request: RESTAPIRequest, response: RESTAPIResponse): void {
    const token = webhookToken(request.getHeader(WEBHOOK_TOKEN_HEADER), queryParam(request, 'token'))
    if (!tokenMatches(token, gs.getPropertySecured(PROPERTY.shippingWebhookToken, ''))) return reply(response, 401, { error: 'bad token' })
    const update = parseTrackingWebhook(request.body.data)
    if ('error' in update) return reply(response, 400, { error: update.error })
    const found = new GlideRecord('x_daas_ham_shipment')
    if (!found.get('tracking_number', update.trackingNumber)) return reply(response, 200, { matched: false })
    const shipmentId = found.getUniqueValue()

    // Set inside the lock; left null when the Shipment is gone by then.
    let tracked = null as Tracked | null
    const ran = withLockTries(`track_shipment_${shipmentId}`, TRACKING_LOCK_TRIES, () => {
        const shipment = findById('x_daas_ham_shipment', shipmentId)
        if (shipment) tracked = track(shipment, update)
    })
    if (!ran) return reply(response, 503, { error: 'Another update of this Shipment is being saved; send it again' })
    if (!tracked) return reply(response, 200, { matched: false })
    if ('error' in tracked) return reply(response, 500, { error: tracked.error })

    if (tracked.deliveredNow) {
        const order = findById('x_daas_ham_order', tracked.orderId)
        if (order) {
            const site = order.getDisplayValue('site')
            order.setValue('work_notes', `Delivered to ${site} (${tracked.carrier} ${update.trackingNumber}).`)
            order.update()
        }
    }
    if (tracked.unrecorded > 0) {
        const error = `${tracked.unrecorded} tracking event(s) not recorded; send the update again`
        return reply(response, 500, { error })
    }
    reply(response, 200, { matched: true, status: tracked.status })
}

/**
 * Apply `update` to `shipment`, read again under its tracking lock, save it and add the events not stored yet. A holder
 * does not check that it still holds the lock: its few writes take a moment, far inside the lock's ten minutes.
 */
function track(shipment: GlideRecord, update: TrackingUpdate): Tracked {
    const { status, detail, deliveredNow } = applyTracking(str(shipment, 'status') as ShipmentStatus, update)
    shipment.setValue('status', status)
    if (detail !== undefined) shipment.setValue('status_detail', detail)
    if (update.estimatedDelivery) shipment.setValue('estimated_delivery', update.estimatedDelivery)
    if (deliveredNow) {
        const deliveredMs = Date.parse(update.deliveredAt ?? '')
        shipment.setValue('delivered_at', msToGlide(Number.isFinite(deliveredMs) ? deliveredMs : nowMs()))
    }
    if (!shipment.update()) {
        // Nothing below runs on a status that was not saved: the retry does it.
        const reason = refusal(shipment)
        gs.warn(`[x_daas_ham] Tracking update of ${update.trackingNumber} not saved: ${reason}`)
        return { error: 'Shipment not saved; send the update again' }
    }
    const unrecorded = recordEvents(shipment.getUniqueValue(), update.trackingNumber, update.events)
    return { status, deliveredNow, orderId: str(shipment, 'order'), carrier: str(shipment, 'carrier'), unrecorded }
}

/**
 * Add the tracking events not stored yet (the aggregator resends the whole history); returns how many were refused. The
 * caller holds the Shipment's tracking lock, so no other delivery inserts between this read and these inserts.
 */
function recordEvents(shipmentId: string, trackingNumber: string, events: readonly TrackingEvent[]): number {
    const known = new Set<string>()
    const existing = new GlideRecord('x_daas_ham_shipment_event')
    existing.addQuery('shipment', shipmentId)
    existing.query()
    while (existing.next()) known.add(trackingEventKey({ occurredAt: str(existing, 'occurred_at'), description: str(existing, 'description') }))
    let refused = 0
    for (const event of newTrackingEvents(known, events)) {
        const record = new GlideRecord('x_daas_ham_shipment_event')
        record.initialize()
        record.setValue('shipment', shipmentId)
        record.setValue('occurred_at', event.occurredAt)
        record.setValue('status', event.status)
        record.setValue('description', event.description)
        record.setValue('location', event.location)
        if (record.insert()) continue
        refused++
        const reason = refusal(record)
        gs.warn(`[x_daas_ham] Tracking event of ${trackingNumber} at ${event.occurredAt} not recorded: ${reason}`)
    }
    return refused
}
