import { GlideRecord, gs } from '@servicenow/glide'
import type { RESTAPIRequest, RESTAPIResponse } from '@servicenow/glide/sn_ws_int'
import { messageOf } from '../domain/errors.ts'
import { REQUEUE, type HeldLock } from '../domain/job-lock.ts'
import { LOCK } from '../domain/lock-names.ts'
import {
    applyTracking,
    buyLabel,
    labelVoidable,
    newTrackingEvents,
    OPEN_SHIPMENTS,
    parseTrackingRetry,
    parseTrackingWebhook,
    returnLabelRefusal,
    statusOvertaken,
    tokenMatches,
    trackingEventKey,
    trackingRetryParams,
    voidedLabelOrderNote,
    WEBHOOK_TOKEN_HEADER,
    webhookToken,
    type Address,
    type LabelRef,
    type LabelResult,
    type TrackingEvent,
    type TrackingUpdate,
} from '../domain/shipping.ts'
import type { ShipmentDirection, ShipmentStatus } from '../domain/vocabulary.ts'
import { msToGlide, nowMs } from '../platform/clock.ts'
import { EVENT, fire, requeue } from '../platform/events.ts'
import { withLock, withLockTries } from '../platform/locks.ts'
import { boolProperty, intProperty, PROPERTY, stagingStockroom, stringProperty } from '../platform/properties.ts'
import { count, findById, refusal, str } from '../platform/records.ts'
import { restMessagePort } from '../platform/rest-messages.ts'
import { queryParam, reply } from '../platform/rest-api.ts'

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
    direction: ShipmentDirection,
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
        const bought = `Label ${label} bought for ${str(parent, 'number')}`
        lock.lostAfter(bought, { check: 'void any second label bought for it meanwhile' })
        return result
    }
    // The label is paid for, yet tracking, a later Ship and the open-label check cannot find it: name it to be voided.
    const reason = refusal(shipment)
    gs.warn(`[x_daas_ham] Label bought for ${str(parent, 'number')} but no Shipment saved (${label}): ${reason}`)
    return { ok: false, error: `the label bought (${label}) was not recorded: ${reason}. Void it with the carrier` }
}

/**
 * Buy the outbound label for an Order's staged Assets and put its tracking number on the Order (does not save). The
 * caller holds `lock` on the Order (platform/delivery shipOrder).
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
    const label = withLock(LOCK.returnLabel(returnOrderId), (lock) => {
        const open = openReturnLabel(returnOrderId)
        if (!open) return createShipment('return', current, packages, lock)
        gs.addErrorMessage(returnLabelRefusal(open.trackingNumber, open.status))
        return null
    })
    if (!label.ran) {
        return void gs.addErrorMessage('A return label is already being bought for this return: reload it to see it')
    }
    const result = label.value
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
 * UI action "Mark label voided" on a Shipment, once the person voided the label with the carrier (nothing is sent to
 * the aggregator). Voided is final. A return label stops counting as open, so the Return order can get a new one and
 * the customer page stops offering it. An outbound label is cleared from its Order (`voidOutboundLabel`); its units
 * stay shipped and nothing is bought. Edits on the form are not saved with it.
 */
export function uiMarkLabelVoided(current: GlideRecord): void {
    const shipmentId = current.getUniqueValue()
    const trackingNumber = str(current, 'tracking_number')
    // Its direction and Order as saved, not as edited on the form.
    const shipment = findById('x_daas_ham_shipment', shipmentId)
    if (!shipment) return void gs.addErrorMessage(`Label ${trackingNumber} no longer exists`)
    const orderId = str(shipment, 'order')
    const outbound = str(shipment, 'direction') === 'to_site' && orderId
    if (outbound) return voidOutboundLabel(shipmentId, trackingNumber, orderId)
    const voided = saveVoided(shipmentId, trackingNumber)
    if (!voided) return
    const returnOrder = findById('x_daas_ham_return_order', str(voided, 'return_order'))
    if (returnOrder) {
        returnOrder.setValue('work_notes', `Return label ${trackingNumber} voided with the carrier: do not ship on it.`)
        returnOrder.update()
    }
    gs.addInfoMessage(`Label ${trackingNumber} marked voided`)
}

/**
 * Mark an outbound label voided and, while its Order still tracks it, clear the Order's tracking number and carrier
 * with a work note saying to buy the replacement with the carrier (domain/shipping `voidedLabelOrderNote`).
 *
 * Checking the Order's tracking number and clearing it is a check-then-write that a Ship of the Order, buying a label
 * for Assets staged since, could interleave with: its new number would be cleared. So both are made under the Order's
 * Ship lock (platform/delivery `shipOrder`), taken before the tracking lock as in ADR 0013's order; one that finds it held
 * (a Ship, or a void of one of the Order's labels, a second press included) changes nothing and asks the user to try
 * again. Taking it throws only when an insert is refused with no lock row (platform/locks); that error escapes.
 */
function voidOutboundLabel(shipmentId: string, trackingNumber: string, orderId: string): void {
    const voiding = withLock(LOCK.shipOrder(orderId), () => {
        const voided = saveVoided(shipmentId, trackingNumber)
        const label = voided && { trackingNumber: str(voided, 'tracking_number'), carrier: str(voided, 'carrier') }
        if (label) clearOrderTracking(orderId, label)
    })
    if (!voiding.ran) {
        const busy = 'a Ship of its Order, or a void of one of its labels, is running. Try again once it has finished'
        gs.addErrorMessage(`Label ${trackingNumber} not marked voided: ${busy}`)
    }
}

/** Clear voided outbound `label` from its Order, with a work note, while it still tracks it; else the Order stays. */
function clearOrderTracking(orderId: string, label: LabelRef): void {
    const order = findById('x_daas_ham_order', orderId)
    const tracked = order ? { trackingNumber: str(order, 'tracking_number'), carrier: str(order, 'carrier') } : null
    const note = tracked && voidedLabelOrderNote(tracked, label)
    if (!order || !note) return void gs.addInfoMessage(`Label ${label.trackingNumber} marked voided`)
    order.setValue('tracking_number', '')
    order.setValue('carrier', '')
    order.setValue('work_notes', note)
    const number = str(order, 'number')
    if (!order.update()) {
        const left = `${number} still names it (${refusal(order)}): clear its tracking number and carrier by hand`
        return void gs.addErrorMessage(`Label ${label.trackingNumber} marked voided, but ${left}`)
    }
    const replace = 'buy the replacement with the carrier and type its tracking number on the Order'
    gs.addInfoMessage(`Label ${label.trackingNumber} marked voided and cleared from ${number}: ${replace}`)
}

/**
 * Mark the Shipment voided, from it read again under its tracking lock: the Shipment saved, or null once the user is
 * told why not. A tracking update that read the label as created before the void and saved after it would put the
 * voided label back (an EasyPost `cancelled` is an Exception); held off through every try, nothing changes and the
 * user is asked to try again. The lock is a leaf (ADR 0013): the Order or Return order is noted after it is released.
 * Taking it throws only when an insert is refused with no lock row (platform/locks `withLockTries` tries again, and
 * that error escapes only when every try threw).
 */
function saveVoided(shipmentId: string, trackingNumber: string): GlideRecord | null {
    const voiding = withLockTries(LOCK.trackShipment(shipmentId), () => voidHolding(shipmentId, trackingNumber))
    if (voiding.ran) return voiding.value
    const busy = 'a tracking update of it is being saved. Try again'
    gs.addErrorMessage(`Label ${trackingNumber} not marked voided: ${busy}`)
    return null
}

/** The void, made holding the Shipment's tracking lock on the Shipment read again (see `saveVoided`). */
function voidHolding(shipmentId: string, trackingNumber: string): GlideRecord | null {
    const notVoided = (why: string) => {
        gs.addErrorMessage(why)
        return null
    }
    const shipment = findById('x_daas_ham_shipment', shipmentId)
    if (!shipment) return notVoided(`Label ${trackingNumber} no longer exists`)
    if (!labelVoidable(str(shipment, 'status') as ShipmentStatus)) {
        const status = shipment.getDisplayValue('status')
        return notVoided(`Label ${trackingNumber} is ${status}, so it cannot be marked voided`)
    }
    shipment.setValue('status', 'voided')
    shipment.setValue('status_detail', `Voided with the carrier (marked by ${gs.getUserDisplayName()})`)
    // A refused save leaves the label open: its Order or Return order is not told it is voided.
    if (!shipment.update()) return notVoided(`Label ${trackingNumber} not marked voided: ${refusal(shipment)}`)
    return shipment
}

/** What a tracking update did to its saved Shipment: its status and what follows. */
type Saved = { status: ShipmentStatus; deliveredNow: boolean; orderId: string; carrier: string; unrecorded: number }

/** What a tracking update did to its Shipment under the lock: why it was not saved, or what it saved. */
type Tracked = { error: string } | Saved

/**
 * POST /shipping/tracking: tracking webhook from the aggregator (no platform login), authenticated by
 * the X-NaaS-Webhook-Token header, or by ?token= when the header is absent. A Shipment or tracking event
 * the platform refuses is answered 500, not as a success, so an aggregator that retries failed deliveries
 * sends the update again; a retry is harmless, as the events already stored are skipped and a saved
 * delivery is not noted twice.
 *
 * Deliveries can overlap (a retry sent while a slow first try runs, or two updates moments apart): both reading the
 * Shipment and its events before the other saved, both would insert the same events, an older status could replace a
 * delivery, and both could note the delivery. So each is applied under the Shipment's tracking lock, from the Shipment
 * and its events read again there (`trackUnderLock`). One held off through every try is answered 202 and queued to be
 * applied in the background (`trackLater`), not left to the aggregator: ShipEngine resends at most twice, typically
 * 30 minutes apart, then drops it. Only an update that cannot be queued is answered 503.
 */
export function postTrackingUpdate(request: RESTAPIRequest, response: RESTAPIResponse): void {
    const token = webhookToken(request.getHeader(WEBHOOK_TOKEN_HEADER), queryParam(request, 'token'))
    if (!tokenMatches(token, gs.getPropertySecured(PROPERTY.shippingWebhookToken, ''))) return reply(response, 401, { error: 'bad token' })
    const update = parseTrackingWebhook(request.body.data)
    if ('error' in update) return reply(response, 400, { error: update.error })
    const found = new GlideRecord('x_daas_ham_shipment')
    if (!found.get('tracking_number', update.trackingNumber)) return reply(response, 200, { matched: false })

    const tracked = trackUnderLock(found.getUniqueValue(), update)
    if (tracked === 'busy') {
        if (trackLater(found, update)) return reply(response, 202, { matched: true, queued: true })
        return reply(response, 503, { error: 'Another update of this Shipment is being saved; send it again' })
    }
    if (!tracked) return reply(response, 200, { matched: false })
    if ('error' in tracked) return reply(response, 500, { error: tracked.error })
    noteDelivery(tracked, update.trackingNumber)
    if (tracked.unrecorded > 0) {
        const error = `${tracked.unrecorded} tracking event(s) not recorded; send the update again`
        return reply(response, 500, { error })
    }
    reply(response, 200, { matched: true, status: tracked.status })
}

/**
 * Script action on x_daas_ham.shipment.track (parm1: a tracking update `trackLater` queued, parm2: how many times it
 * was queued again): apply it to the Shipment as the webhook does, under its tracking lock. Updates applied while it
 * waited may be newer: one of them having stored a later event, its status is not taken, only its events (`track`).
 * One held off again, or whose Shipment or events the platform refused, is queued again a minute later, as often as
 * sourcing's requests are (domain/job-lock `REQUEUE`: past the lock's abandonment, so a lock left by a dead holder does
 * not drop it), then dropped with a warning naming the Shipment; a retry repeats nothing, as stored events are skipped
 * and a delivery is noted once. Taking the lock throws only when an insert is refused with no lock row
 * (platform/locks); that error escapes.
 */
export function retryTrackingUpdate(event: GlideRecord, current: GlideRecord): void {
    const shipmentId = current.getUniqueValue()
    // The Shipment is gone: nothing to apply.
    if (!shipmentId) return
    const param = str(event, 'parm1')
    const queued = parseTrackingRetry(param)
    if (!queued) {
        return void gs.warn(`[x_daas_ham] Tracking retry of ${shipmentName(current)} dropped: parm1 is not an update`)
    }
    const { update, newestAt } = queued
    const tries = Number(str(event, 'parm2')) || 0
    let tracked: ReturnType<typeof trackUnderLock>
    try {
        tracked = trackUnderLock(shipmentId, update, newestAt)
    } catch (error) {
        // The webhook answered 2xx, so nothing else would bring this update back: try again like a busy lock, and
        // the give-up warning names it if the error persists.
        return trackAgain(current, param, tries, messageOf(error))
    }
    if (tracked === 'busy') return trackAgain(current, param, tries, 'another update held its lock')
    if (!tracked) return
    if ('error' in tracked) return trackAgain(current, param, tries, 'the platform refused the Shipment')
    noteDelivery(tracked, update.trackingNumber)
    if (tracked.unrecorded > 0) trackAgain(current, param, tries, `${tracked.unrecorded} tracking event(s) not saved`)
}

/** A Shipment for the log: its number and tracking number. */
function shipmentName(shipment: GlideRecord): string {
    return `Shipment ${str(shipment, 'number') || shipment.getUniqueValue()} (${str(shipment, 'tracking_number')})`
}

/**
 * Apply `update` to the Shipment `shipmentId` under its tracking lock (`track`, on the Shipment read again there): what
 * it did, null when the Shipment is gone, or 'busy' when other holders kept the lock through every try. `newestAt` is
 * given for a queued update only (`track`). The lock is a leaf (ADR 0013): taken holding no other lock, and none is
 * taken under it, so the Order is noted after it is released (`noteDelivery`). It is tried back to back: a holder keeps
 * it for one status save and that update's new events only, and a webhook held off through every try is answered at
 * once (EasyPost waits 7 s, ShipEngine 10 s). Taking it throws only when an insert is refused with no lock row
 * (platform/locks `withLockTries` tries again, and that error escapes only when every try threw).
 */
function trackUnderLock(shipmentId: string, update: TrackingUpdate, newestAt?: string): Tracked | null | 'busy' {
    const tracked = withLockTries(LOCK.trackShipment(shipmentId), () => {
        const shipment = findById('x_daas_ham_shipment', shipmentId)
        return shipment ? track(shipment, update, newestAt) : null
    })
    return tracked.ran ? tracked.value : 'busy'
}

/** Put a work note on the Order of a Shipment the update delivered just now (only the first delivery is noted). */
function noteDelivery(saved: Saved, trackingNumber: string): void {
    if (!saved.deliveredNow) return
    const order = findById('x_daas_ham_order', saved.orderId)
    if (!order) return
    order.setValue('work_notes', `Delivered to ${order.getDisplayValue('site')} (${saved.carrier} ${trackingNumber}).`)
    order.update()
}

/**
 * Queue `update`, held off by its Shipment's lock, for `retryTrackingUpdate` to apply in the background; false, once
 * logged, when it cannot be queued. It travels in the events' parm1 rather than in a record of its own: no table, ACL
 * or clean-up is needed, and the events not stored yet usually fit one parameter. When they do not, they are
 * shared out over several events, each a whole update that applies on its own (domain/shipping
 * `trackingRetryParams`); only an event too long for a parameter by itself leaves it unqueued.
 */
function trackLater(shipment: GlideRecord, update: TrackingUpdate): boolean {
    const params = trackingRetryParams(update, storedEvents(shipment.getUniqueValue()).keys)
    if (!params) {
        gs.warn(`[x_daas_ham] Tracking update of ${shipmentName(shipment)} not queued: an event is too long to queue`)
        return false
    }
    for (const param of params) fire(EVENT.trackShipment, shipment, param, '0')
    const name = shipmentName(shipment)
    gs.info(`[x_daas_ham] Tracking update of ${name} queued in ${params.length} event(s): another update held its lock`)
    return true
}

/** Queue the retry `param` of `shipment` again a minute later, unless it was already queued again `tries` times. */
function trackAgain(shipment: GlideRecord, param: string, tries: number, why: string): void {
    const name = shipmentName(shipment)
    if (tries >= REQUEUE.times) {
        const check = 'check the Shipment with the carrier'
        return void gs.warn(`[x_daas_ham] Tracking update of ${name} dropped after ${tries} tries (${why}): ${check}`)
    }
    gs.info(`[x_daas_ham] Tracking update of ${name} tried again in ${REQUEUE.delaySeconds} s: ${why}`)
    requeue(EVENT.trackShipment, shipment, param, String(tries + 1))
}

/**
 * Apply `update` to `shipment`, read again under its tracking lock, save it and add the events not stored yet. A queued
 * update (`newestAt`: when its newest event happened) overtaken by an update applied while it waited (domain/shipping
 * `statusOvertaken`) adds only its events, so its older status cannot move the Shipment back. A holder does not check
 * that it still holds the lock: its few writes take a moment, far inside the lock's ten minutes.
 */
function track(shipment: GlideRecord, update: TrackingUpdate, newestAt?: string): Tracked {
    const shipmentId = shipment.getUniqueValue()
    // Read under the lock, so no other delivery inserts between this read and the inserts below.
    const stored = storedEvents(shipmentId)
    let status = str(shipment, 'status') as ShipmentStatus
    let deliveredNow = false
    if (newestAt === undefined || !statusOvertaken(update, newestAt, stored.times)) {
        const applied = applyTracking(status, update)
        status = applied.status
        deliveredNow = applied.deliveredNow
        shipment.setValue('status', status)
        if (applied.detail !== undefined) shipment.setValue('status_detail', applied.detail)
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
    }
    const unrecorded = recordEvents(shipmentId, update.trackingNumber, newTrackingEvents(stored.keys, update.events))
    return { status, deliveredNow, orderId: str(shipment, 'order'), carrier: str(shipment, 'carrier'), unrecorded }
}

/**
 * Add `fresh`, the tracking events not stored yet (the aggregator resends the whole history); returns how many were
 * refused. The caller holds the Shipment's tracking lock and read the stored events under it.
 */
function recordEvents(shipmentId: string, trackingNumber: string, fresh: readonly TrackingEvent[]): number {
    let refused = 0
    for (const event of fresh) {
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

/** The tracking events stored for a Shipment: their keys (domain/shipping `trackingEventKey`) and carrier times. */
function storedEvents(shipmentId: string): { keys: Set<string>; times: string[] } {
    const keys = new Set<string>()
    const times: string[] = []
    const existing = new GlideRecord('x_daas_ham_shipment_event')
    existing.addQuery('shipment', shipmentId)
    existing.query()
    while (existing.next()) {
        const stored = { occurredAt: str(existing, 'occurred_at'), description: str(existing, 'description') }
        keys.add(trackingEventKey(stored))
        times.push(stored.occurredAt)
    }
    return { keys, times }
}
