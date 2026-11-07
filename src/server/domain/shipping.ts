import type { HttpPort } from './http'
import { asArray, field, parseJson, text } from './json'

/**
 * Shipping aggregator (P3.26, D73): one adapter buys labels and reads tracking webhooks. Requests
 * follow the ShipEngine label shape; webhooks are read in both ShipEngine and EasyPost shapes so the
 * Provider can use either.
 */

export type ShipmentStatus = 'label_created' | 'in_transit' | 'out_for_delivery' | 'delivered' | 'exception' | 'returned' | 'unknown'

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
    serviceCode: string
    from: Address
    to: Address
    packages: number
    weightKg: number
    reference: string
}

export type LabelResult =
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

/** What is missing from an address before a carrier will accept it, or null. */
export function addressProblem(address: Address): string | null {
    const missing = (['name', 'line1', 'city', 'postalCode', 'country'] as const).filter((key) => !address[key])
    if (missing.length > 0) return `missing ${missing.join(', ')}`
    return countryCode(address.country) ? null : `unknown country "${address.country}" (use the ISO code)`
}

function toAggregatorAddress(address: Address): Record<string, string> {
    return {
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
}

export function labelRequestBody(input: LabelInput): string {
    const count = Math.max(1, Math.floor(input.packages))
    const weight = Math.max(0.1, input.weightKg)
    return JSON.stringify({
        shipment: {
            service_code: input.serviceCode,
            ship_from: toAggregatorAddress(input.from),
            ship_to: toAggregatorAddress(input.to),
            packages: Array.from({ length: count }, () => ({ weight: { value: weight, unit: 'kilogram' }, label_messages: { reference1: input.reference } })),
        },
        label_format: 'pdf',
    })
}

/** Buy a label: POST to the aggregator's `create_label` function. */
export function buyLabel(http: HttpPort, input: LabelInput): LabelResult {
    for (const [side, address] of [['from', input.from], ['to', input.to]] as const) {
        const problem = addressProblem(address)
        if (problem) return { ok: false, error: `${side} address ${problem}` }
    }
    const response = http({ fn: 'create_label', params: {}, body: labelRequestBody(input) })
    const json = parseJson(response.body)
    if (response.status < 200 || response.status >= 300) {
        const message = text(field(asArray(field(json, 'errors'))[0], 'message'))
        return { ok: false, error: `HTTP ${response.status}${message ? `: ${message}` : ''}` }
    }
    const trackingNumber = text(field(json, 'tracking_number'))
    if (!trackingNumber) return { ok: false, error: 'the aggregator returned no tracking number' }
    return {
        ok: true,
        labelId: text(field(json, 'label_id')),
        trackingNumber,
        carrier: text(field(json, 'carrier_code')),
        labelUrl: text(field(json, 'label_download', 'pdf')) || text(field(json, 'label_download', 'href')),
        cost: Number(field(json, 'shipment_cost', 'amount')) || 0,
        currency: text(field(json, 'shipment_cost', 'currency')).toUpperCase() || 'EUR',
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

/** A tracking webhook in ShipEngine (`data.status_code`) or EasyPost (`result.status`) shape. */
export function parseTrackingWebhook(body: unknown): TrackingUpdate | { error: string } {
    const shipEngine = field(body, 'data')
    if (text(field(shipEngine, 'tracking_number'))) {
        const status = SHIPENGINE_STATUS[text(field(shipEngine, 'status_code')).toUpperCase()] ?? 'unknown'
        return {
            trackingNumber: text(field(shipEngine, 'tracking_number')),
            status,
            description: text(field(shipEngine, 'status_description')) || text(field(shipEngine, 'carrier_status_description')),
            estimatedDelivery: text(field(shipEngine, 'estimated_delivery_date')) || undefined,
            deliveredAt: status === 'delivered' ? text(field(shipEngine, 'actual_delivery_date')) || undefined : undefined,
            events: asArray(field(shipEngine, 'events')).map((event) => ({
                occurredAt: text(field(event, 'occurred_at')),
                status: SHIPENGINE_STATUS[text(field(event, 'status_code')).toUpperCase()] ?? 'unknown',
                description: text(field(event, 'description')),
                location: [text(field(event, 'city_locality')), text(field(event, 'country_code'))].filter(Boolean).join(', '),
            })),
        }
    }
    const easyPost = field(body, 'result')
    if (text(field(easyPost, 'tracking_code'))) {
        const status = EASYPOST_STATUS[text(field(easyPost, 'status')).toLowerCase()] ?? 'unknown'
        const details = asArray(field(easyPost, 'tracking_details'))
        const last = details[details.length - 1]
        return {
            trackingNumber: text(field(easyPost, 'tracking_code')),
            status,
            description: text(field(last, 'message')) || text(field(easyPost, 'status_detail')),
            estimatedDelivery: text(field(easyPost, 'est_delivery_date')) || undefined,
            deliveredAt: status === 'delivered' ? text(field(last, 'datetime')) || undefined : undefined,
            events: details.map((detail) => ({
                occurredAt: text(field(detail, 'datetime')),
                status: EASYPOST_STATUS[text(field(detail, 'status')).toLowerCase()] ?? 'unknown',
                description: text(field(detail, 'message')),
                location: [text(field(detail, 'tracking_location', 'city')), text(field(detail, 'tracking_location', 'country'))].filter(Boolean).join(', '),
            })),
        }
    }
    return { error: 'not a tracking update (no tracking number)' }
}

const FINAL: ReadonlySet<ShipmentStatus> = new Set(['delivered', 'returned'])

/**
 * The status a shipment takes from a tracking update. Webhooks can arrive late or out of order, so a
 * delivered or returned shipment keeps that status (only a return to sender overrides a delivery),
 * and an `unknown` update never replaces a known status.
 */
export function nextShipmentStatus(current: ShipmentStatus, incoming: ShipmentStatus): ShipmentStatus {
    if (incoming === 'unknown') return current
    if (FINAL.has(current)) return incoming === 'returned' ? 'returned' : current
    return incoming
}

/** Constant-time comparison of a webhook token with the configured secret (never matches an empty secret). */
export function tokenMatches(given: string, secret: string): boolean {
    if (!secret || given.length !== secret.length) return false
    let difference = 0
    for (let i = 0; i < secret.length; i++) difference |= given.charCodeAt(i) ^ secret.charCodeAt(i)
    return difference === 0
}
