import { currencyCode } from './billing.ts'
import { failureText, isSuccess, type HttpPort } from './http.ts'
import { asArray, field, isoDate, parseJson, text } from './json.ts'
import { SHIPMENT_STATUS, type ShipmentStatus } from './vocabulary.ts'
import { REST_MESSAGE } from './rest-message-names.ts'

/**
 * Shipping aggregator (P3.26, D73): one adapter buys labels and reads tracking webhooks. Requests
 * follow the ShipEngine label shape; webhooks are read in both ShipEngine and EasyPost shapes so the
 * Provider can use either.
 */

export interface Address {
    name: string
    company?: string
    phone?: string
    line1: string
    line2?: string
    city: string
    state?: string
    postalCode: string
    country: string
}

export interface LabelInput {
    /** ShipEngine carrier account (se-...) billed for the label. */
    carrierId: string
    serviceCode: string
    from: Address
    to: Address
    packages: number
    weightKg: number
    reference: string
}

export type LabelResult =
    /** `currency` is the carrier's three-letter code for `cost`, '' when the aggregator gave none. */
    | { ok: true; labelId: string; trackingNumber: string; carrier: string; labelUrl: string; cost: number; currency: string }
    | { ok: false; error: string }

/** ISO 3166-1 alpha-2 codes for country names as they are commonly written on locations. */
const COUNTRY_CODES: Record<string, string> = {
    'united states': 'US', 'united states of america': 'US', usa: 'US', canada: 'CA', mexico: 'MX', brazil: 'BR',
    'united kingdom': 'GB', 'great britain': 'GB', uk: 'GB', england: 'GB', scotland: 'GB', wales: 'GB', ireland: 'IE',
    netherlands: 'NL', 'the netherlands': 'NL', holland: 'NL', belgium: 'BE', luxembourg: 'LU', germany: 'DE',
    deutschland: 'DE', france: 'FR', spain: 'ES', portugal: 'PT', italy: 'IT', switzerland: 'CH', austria: 'AT',
    denmark: 'DK', norway: 'NO', sweden: 'SE', finland: 'FI', iceland: 'IS', poland: 'PL', czechia: 'CZ',
    'czech republic': 'CZ', slovakia: 'SK', hungary: 'HU', romania: 'RO', bulgaria: 'BG', greece: 'GR',
    croatia: 'HR', slovenia: 'SI', serbia: 'RS', estonia: 'EE', latvia: 'LV', lithuania: 'LT', turkey: 'TR',
    israel: 'IL', 'united arab emirates': 'AE', uae: 'AE', 'saudi arabia': 'SA', qatar: 'QA', 'south africa': 'ZA',
    india: 'IN', singapore: 'SG', japan: 'JP', china: 'CN', 'hong kong': 'HK', australia: 'AU', 'new zealand': 'NZ',
}

/** A location's country as an ISO alpha-2 code, or '' when it cannot be told. */
export function countryCode(country: string): string {
    const value = country.trim()
    if (/^[A-Za-z]{2}$/.test(value)) return value.toUpperCase()
    return COUNTRY_CODES[value.toLowerCase().replace(/\s+/g, ' ')] ?? ''
}

/** Countries whose carriers need a state or province (ShipEngine allows only abbreviations for the U.S.). */
const STATE_REQUIRED: ReadonlySet<string> = new Set(['US', 'CA'])

const ADDRESS_PARTS = ['name', 'phone', 'line1', 'city', 'state', 'postalCode', 'country'] as const

/** Whether a carrier needs this part: the phone only on the sender (`ship_from`) side, the state only in the U.S. and Canada. */
function partRequired(part: (typeof ADDRESS_PARTS)[number], side: 'from' | 'to', country: string): boolean {
    if (part === 'phone') return side === 'from'
    if (part === 'state') return STATE_REQUIRED.has(country)
    return true
}

/** What is missing from the sender (`from`) or recipient (`to`) address before a carrier will accept it, or null. */
export function addressProblem(address: Address, side: 'from' | 'to'): string | null {
    const country = countryCode(address.country)
    const missing = ADDRESS_PARTS.filter((part) => !address[part] && partRequired(part, side, country))
    if (missing.length > 0) return `missing ${missing.join(', ')}`
    if (!country) return `unknown country "${address.country}" (use the ISO code)`
    // ShipEngine takes U.S. and Canadian states and provinces as their two-letter codes only.
    if (STATE_REQUIRED.has(country) && !/^[A-Za-z]{2}$/.test((address.state ?? '').trim())) return `state "${address.state}" must be the two-letter code`
    return null
}

/** An address in ShipEngine's shape, leaving out empty parts (the API rejects `''` where it needs a value). */
function toAggregatorAddress(address: Address): Record<string, string> {
    const parts: Record<string, string> = {
        name: address.name,
        company_name: address.company ?? '',
        phone: address.phone ?? '',
        address_line1: address.line1,
        address_line2: address.line2 ?? '',
        city_locality: address.city,
        state_province: address.state ?? '',
        postal_code: address.postalCode,
        country_code: countryCode(address.country),
    }
    return Object.fromEntries(Object.entries(parts).filter(([, value]) => value !== ''))
}

/** The most boxes one label covers; larger shipments get their tracking numbers by hand. */
const MAX_LABEL_PACKAGES = 20

/** How many boxes a label covers: a whole number, at least 1 (buyLabel refuses more than MAX_LABEL_PACKAGES first). */
export function packageCount(n: number): number {
    if (Number.isNaN(n)) return 1
    return Math.max(1, Math.floor(n))
}

export function labelRequestBody(input: LabelInput): string {
    const count = packageCount(input.packages)
    const weight = Math.max(0.1, input.weightKg)
    return JSON.stringify({
        shipment: {
            carrier_id: input.carrierId,
            service_code: input.serviceCode,
            ship_from: toAggregatorAddress(input.from),
            ship_to: toAggregatorAddress(input.to),
            packages: Array.from({ length: count }, () => ({ weight: { value: weight, unit: 'kilogram' }, label_messages: { reference1: input.reference } })),
        },
        label_format: 'pdf',
    })
}

/**
 * Buy a label: POST to the aggregator's `create_label` function. Nothing is called for more boxes
 * than one label covers or for an address a carrier would refuse.
 */
export function buyLabel(http: HttpPort, input: LabelInput): LabelResult {
    // One package per Asset: never buy a label that leaves boxes unlabelled.
    if (input.packages > MAX_LABEL_PACKAGES) {
        return { ok: false, error: `${input.packages} packages is more than one label covers (${MAX_LABEL_PACKAGES}); enter the carrier and tracking number by hand` }
    }
    for (const [side, address] of [['from', input.from], ['to', input.to]] as const) {
        const problem = addressProblem(address, side)
        if (problem) return { ok: false, error: `${side} address ${problem}` }
    }
    const response = http({ fn: REST_MESSAGE.shipping.fn.createLabel, params: {}, body: labelRequestBody(input) })
    if (!isSuccess(response.status)) return { ok: false, error: failureText(response) }
    const json = parseJson(response.body)
    const trackingNumber = text(field(json, 'tracking_number'))
    if (!trackingNumber) return { ok: false, error: 'the aggregator returned no tracking number' }
    return {
        ok: true,
        labelId: text(field(json, 'label_id')),
        trackingNumber,
        carrier: text(field(json, 'carrier_code')),
        labelUrl: text(field(json, 'label_download', 'pdf')) || text(field(json, 'label_download', 'href')),
        cost: Number(field(json, 'shipment_cost', 'amount')) || 0,
        // The carrier's currency, kept on the Shipment and costed in it by Margin: never a default ('' when not given).
        currency: currencyCode(text(field(json, 'shipment_cost', 'currency'))),
    }
}

const SHIPENGINE_STATUS: Record<string, ShipmentStatus> = {
    AC: 'label_created',
    NY: 'label_created',
    IT: 'in_transit',
    AT: 'in_transit',
    DE: 'delivered',
    SP: 'delivered',
    EX: 'exception',
    UN: 'unknown',
}

const EASYPOST_STATUS: Record<string, ShipmentStatus> = {
    pre_transit: 'label_created',
    in_transit: 'in_transit',
    out_for_delivery: 'out_for_delivery',
    delivered: 'delivered',
    available_for_pickup: 'out_for_delivery',
    return_to_sender: 'returned',
    failure: 'exception',
    error: 'exception',
    cancelled: 'exception',
    unknown: 'unknown',
}

export interface TrackingEvent {
    occurredAt: string
    status: ShipmentStatus
    description: string
    location: string
}

export interface TrackingUpdate {
    trackingNumber: string
    status: ShipmentStatus
    description: string
    estimatedDelivery?: string
    deliveredAt?: string
    events: TrackingEvent[]
}

/** A status from the aggregator's table; anything else (including inherited names like "constructor") is unknown. */
function lookupStatus(table: Record<string, ShipmentStatus>, key: string): ShipmentStatus {
    return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : 'unknown'
}

function shipEngineStatus(code: unknown): ShipmentStatus {
    return lookupStatus(SHIPENGINE_STATUS, text(code).toUpperCase())
}

function easyPostStatus(status: unknown): ShipmentStatus {
    return lookupStatus(EASYPOST_STATUS, text(status).toLowerCase())
}

function placeName(...parts: string[]): string {
    return parts.filter(Boolean).join(', ')
}

/** The EasyPost scan with the latest `datetime` (the docs promise no order); undated scans lose, ties go to the later one listed. */
function latestDetail(details: readonly unknown[]): unknown {
    let latest: unknown = undefined
    let latestMs = -Infinity
    for (const detail of details) {
        const ms = Date.parse(text(field(detail, 'datetime')))
        const at = Number.isFinite(ms) ? ms : -Infinity
        if (at >= latestMs) {
            latest = detail
            latestMs = at
        }
    }
    return latest
}

/**
 * A tracking webhook in ShipEngine (`data.status_code`) or EasyPost (`result.status`) shape. EasyPost
 * Events about other objects (e.g. an Insurance in `insurance.cancelled`) are refused. The estimated
 * delivery is a YYYY-MM-DD date; `deliveredAt` is the carrier's own timestamp.
 */
export function parseTrackingWebhook(body: unknown): TrackingUpdate | { error: string } {
    const shipEngine = field(body, 'data')
    const shipEngineNumber = text(field(shipEngine, 'tracking_number'))
    if (shipEngineNumber) {
        const status = shipEngineStatus(field(shipEngine, 'status_code'))
        return {
            trackingNumber: shipEngineNumber,
            status,
            description: text(field(shipEngine, 'status_description')) || text(field(shipEngine, 'carrier_status_description')),
            estimatedDelivery: isoDate(field(shipEngine, 'estimated_delivery_date')),
            deliveredAt: status === 'delivered' ? text(field(shipEngine, 'actual_delivery_date')) || undefined : undefined,
            events: asArray(field(shipEngine, 'events')).map((event) => ({
                occurredAt: text(field(event, 'occurred_at')),
                status: shipEngineStatus(field(event, 'status_code')),
                description: text(field(event, 'description')),
                location: placeName(text(field(event, 'city_locality')), text(field(event, 'country_code'))),
            })),
        }
    }
    const easyPost = field(body, 'result')
    const kind = text(field(easyPost, 'object'))
    if (kind && kind !== 'Tracker') return { error: `not a tracking update (${kind})` }
    const easyPostNumber = text(field(easyPost, 'tracking_code'))
    if (easyPostNumber) {
        const status = easyPostStatus(field(easyPost, 'status'))
        const details = asArray(field(easyPost, 'tracking_details'))
        const latest = latestDetail(details)
        return {
            trackingNumber: easyPostNumber,
            status,
            description: text(field(latest, 'message')) || text(field(easyPost, 'status_detail')),
            estimatedDelivery: isoDate(field(easyPost, 'est_delivery_date')),
            deliveredAt: status === 'delivered' ? text(field(latest, 'datetime')) || undefined : undefined,
            events: details.map((detail) => ({
                occurredAt: text(field(detail, 'datetime')),
                status: easyPostStatus(field(detail, 'status')),
                description: text(field(detail, 'message')),
                location: placeName(text(field(detail, 'tracking_location', 'city')), text(field(detail, 'tracking_location', 'country'))),
            })),
        }
    }
    return { error: 'not a tracking update (no tracking number)' }
}

const FINAL: ReadonlySet<ShipmentStatus> = new Set([SHIPMENT_STATUS.delivered, SHIPMENT_STATUS.returned, SHIPMENT_STATUS.voided])

/**
 * Encoded query on x_daas_ham_shipment: shipments not delivered, returned or voided (their label is still in use).
 * Written out from the status names, as Fluent metadata, which imports it for the workspace's list, reads no function
 * call (domain/shipping.test.ts holds it to the final statuses).
 */
export const OPEN_SHIPMENTS = `statusNOT IN${SHIPMENT_STATUS.delivered},${SHIPMENT_STATUS.returned},${SHIPMENT_STATUS.voided}`

/**
 * The status a shipment takes from a tracking update. Webhooks can arrive late or out of order, so a
 * delivered, returned or voided shipment keeps that status (only a return to sender overrides a
 * delivery), and an `unknown` update never replaces a known status.
 */
export function nextShipmentStatus(current: ShipmentStatus, incoming: ShipmentStatus): ShipmentStatus {
    if (incoming === 'unknown') return current
    if (current === 'delivered' && incoming === 'returned') return 'returned'
    if (FINAL.has(current)) return current
    return incoming
}

/**
 * Whether a person may mark a shipment's label voided once they voided it with the carrier: while it is
 * bought but not moving (label created) or stuck (exception). Nothing is sent to the aggregator.
 */
export function labelVoidable(status: ShipmentStatus): boolean {
    return status === 'label_created' || status === 'exception'
}

/**
 * Why a Return order gets no new return label while label `trackingNumber` is still open in `status`. Voiding is
 * advised only where Mark label voided is offered (labelVoidable); a label already moving is the return under way.
 */
export function returnLabelRefusal(trackingNumber: string, status: ShipmentStatus): string {
    if (labelVoidable(status)) {
        return `Return label ${trackingNumber} is still open; void it with the carrier, then use Mark label voided on its Shipment, before buying another`
    }
    if (status === 'in_transit' || status === 'out_for_delivery') {
        return `Return label ${trackingNumber} is already under way with the carrier; no other label is needed`
    }
    return `Return label ${trackingNumber} is still open and its status is unknown; check it with the carrier before buying another`
}

export interface LabelRef {
    trackingNumber: string
    carrier: string
}

/**
 * The work note for an Order whose outbound label `label` was voided, or null when the Order (`order`) tracks another
 * label (a later Ship's, or one typed since), which stays. The note goes with clearing the Order's tracking number and
 * carrier, so a voided number does not pass for the shipment under way; an Order's empty carrier still matches.
 */
export function voidedLabelOrderNote(order: LabelRef, label: LabelRef): string | null {
    const tracking = label.trackingNumber.trim()
    if (!tracking || order.trackingNumber.trim() !== tracking) return null
    const carrier = order.carrier.trim().toLowerCase()
    if (carrier && carrier !== label.carrier.trim().toLowerCase()) return null
    const voided = [label.carrier.trim(), tracking].filter(Boolean).join(' ')
    return (
        `Shipping label ${voided} was voided with the carrier, so its tracking number and carrier were cleared from ` +
        'this Order; its units stay shipped. Buy the replacement label with the carrier, then type its carrier and ' +
        'tracking number on the Order.'
    )
}

/**
 * The length of what a carrier says, as stored: a Shipment's `status_detail` and a Shipment event's `description`. An
 * event is known again by its description cut to this length (`trackingEventKey`), so the columns must hold as much.
 */
export const TRACKING_DESCRIPTION_LENGTH = 255

/** The length of a Shipment event's `location`. */
export const TRACKING_LOCATION_LENGTH = 120

/**
 * What a tracking update does to a shipment: its next status, the status detail to store (only when
 * the shipment took the update's status, cut to the stored length) and whether it was delivered just now.
 */
export function applyTracking(previous: ShipmentStatus, update: TrackingUpdate): { status: ShipmentStatus; detail?: string; deliveredNow: boolean } {
    const status = nextShipmentStatus(previous, update.status)
    const deliveredNow = status === 'delivered' && previous !== 'delivered'
    return status === update.status ? { status, detail: update.description.slice(0, TRACKING_DESCRIPTION_LENGTH), deliveredNow } : { status, deliveredNow }
}

/** The identity of a stored tracking event: when it happened and what the carrier said (as stored, cut to its length). */
export function trackingEventKey(event: { occurredAt: string; description: string }): string {
    return `${event.occurredAt}|${event.description.slice(0, TRACKING_DESCRIPTION_LENGTH)}`
}

/**
 * The events of a tracking update not stored yet (the aggregator resends the whole history), once
 * each, cut to the stored lengths of its description and location.
 */
export function newTrackingEvents(known: ReadonlySet<string>, events: readonly TrackingEvent[]): TrackingEvent[] {
    const seen = new Set<string>()
    const fresh: TrackingEvent[] = []
    for (const event of events) {
        const key = trackingEventKey(event)
        if (known.has(key) || seen.has(key)) continue
        seen.add(key)
        fresh.push({
            occurredAt: event.occurredAt,
            status: event.status,
            description: event.description.slice(0, TRACKING_DESCRIPTION_LENGTH),
            location: event.location.slice(0, TRACKING_LOCATION_LENGTH),
        })
    }
    return fresh
}

/** The statuses tracking can set: what the aggregators' codes map to (never `voided`). */
const TRACKING_STATUSES: ReadonlySet<string> = new Set([
    ...Object.values(SHIPENGINE_STATUS),
    ...Object.values(EASYPOST_STATUS),
])

/** A status read back from a queued retry; anything else is unknown, which changes no status. */
function trackingStatus(value: unknown): ShipmentStatus {
    return typeof value === 'string' && TRACKING_STATUSES.has(value) ? (value as ShipmentStatus) : 'unknown'
}

/** A string as written, untrimmed so that a retried event keeps the key it is stored under; '' for anything else. */
function written(value: unknown): string {
    return typeof value === 'string' ? value : ''
}

/** The most characters one queued tracking retry carries: its event's parm1, a 4000-character string on sysevent. */
export const TRACKING_RETRY_CHARS = 4000

/** A tracking update queued to be applied in the background, and when its newest event happened ('' if undated). */
export interface QueuedTracking {
    update: TrackingUpdate
    newestAt: string
}

/** When the newest of `events` happened, as the carrier wrote it; '' when none is dated. */
export function newestEventAt(events: readonly { occurredAt: string }[]): string {
    let newest = ''
    let newestMs = -Infinity
    for (const event of events) {
        const ms = Date.parse(event.occurredAt)
        if (Number.isFinite(ms) && ms > newestMs) {
            newest = event.occurredAt
            newestMs = ms
        }
    }
    return newest
}

/**
 * Whether a queued update's status is older news than the Shipment's: an event stored while it waited (`storedTimes`)
 * happened after its newest (`newestAt`), so an update applied meanwhile is newer, and this one's status, detail and
 * estimate would move the Shipment back (say from Out for delivery to In transit). A delivery or return is never
 * older news: final, it would have stayed had the updates come in order (`nextShipmentStatus`).
 */
export function statusOvertaken(update: TrackingUpdate, newestAt: string, storedTimes: Iterable<string>): boolean {
    const asOf = Date.parse(newestAt)
    if (FINAL.has(update.status) || !Number.isFinite(asOf)) return false
    for (const time of storedTimes) if (Date.parse(time) > asOf) return true
    return false
}

/**
 * A tracking update held off by its Shipment's lock, as the parm1 (JSON, at most `maxChars` long) of each event that
 * retries it. Each carries the update's status, detail, estimate, delivery time and newest event time, and the events
 * not in `known` (stored already, so never needed again) are shared out among them. Applying them all, in any order,
 * does what the update would have: the status is the same in each, a delivery is noted by the first, and stored events
 * are skipped. Null when one event does not fit on its own.
 */
export function trackingRetryParams(
    update: TrackingUpdate,
    known: ReadonlySet<string>,
    maxChars = TRACKING_RETRY_CHARS,
): string[] | null {
    const head = {
        trackingNumber: update.trackingNumber,
        status: update.status,
        description: update.description.slice(0, TRACKING_DESCRIPTION_LENGTH),
        estimatedDelivery: update.estimatedDelivery,
        deliveredAt: update.deliveredAt,
        // Of the whole update, not only the events carried: those already stored are left out.
        newestAt: newestEventAt(update.events),
    }
    const encode = (events: TrackingEvent[]) => JSON.stringify({ ...head, events })
    const fits = (events: TrackingEvent[]) => encode(events).length <= maxChars
    if (!fits([])) return null
    const parts: TrackingEvent[][] = [[]]
    for (const event of newTrackingEvents(known, update.events)) {
        const last = parts[parts.length - 1]
        if (fits([...last, event])) last.push(event)
        else if (fits([event])) parts.push([event])
        else return null
    }
    return parts.map(encode)
}

/** A queued retry's parm1 back as the update it carries (`trackingRetryParams`), or null when it is not one. */
export function parseTrackingRetry(param: string): QueuedTracking | null {
    const json = parseJson(param)
    const trackingNumber = written(field(json, 'trackingNumber'))
    const events = field(json, 'events')
    if (!trackingNumber || !Array.isArray(events)) return null
    const update: TrackingUpdate = {
        trackingNumber,
        status: trackingStatus(field(json, 'status')),
        description: written(field(json, 'description')),
        estimatedDelivery: isoDate(field(json, 'estimatedDelivery')),
        deliveredAt: written(field(json, 'deliveredAt')) || undefined,
        events: events.map((event: unknown) => ({
            occurredAt: written(field(event, 'occurredAt')),
            status: trackingStatus(field(event, 'status')),
            description: written(field(event, 'description')),
            location: written(field(event, 'location')),
        })),
    }
    return { update, newestAt: written(field(json, 'newestAt')) }
}

/** The header the aggregators are registered to send the webhook token in (registered as X-NaaS-Webhook-Token; names are case-insensitive). */
export const WEBHOOK_TOKEN_HEADER = 'x-naas-webhook-token'

/** The webhook token: the header when sent (ShipEngine `headers`, EasyPost `custom_headers`), else the `?token=` fallback. */
export function webhookToken(header: unknown, query: string): string {
    const given = header === undefined || header === null ? '' : String(header)
    return given || query
}

/** Constant-time comparison of a webhook token with the configured secret (never matches an empty secret). */
export function tokenMatches(given: string, secret: string): boolean {
    if (!secret || given.length !== secret.length) return false
    let difference = 0
    for (let i = 0; i < secret.length; i++) difference |= given.charCodeAt(i) ^ secret.charCodeAt(i)
    return difference === 0
}
