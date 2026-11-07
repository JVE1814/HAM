import { describe, expect, it } from 'vitest'
import type { HttpRequest } from './http'
import {
    addressProblem,
    applyTracking,
    buyLabel,
    countryCode,
    labelRequestBody,
    newTrackingEvents,
    nextShipmentStatus,
    packageCount,
    parseTrackingWebhook,
    tokenMatches,
    trackingEventKey,
    WEBHOOK_TOKEN_HEADER,
    webhookToken,
    type Address,
    type LabelInput,
    type ShipmentStatus,
    type TrackingEvent,
    type TrackingUpdate,
} from './shipping'

const depot: Address = { name: 'NaaS Depot', company: 'Demo NaaS Provider', phone: '+31 30 000', line1: '1 Depot Way', city: 'Utrecht', postalCode: '3511AA', country: 'nl' }
const site: Address = { name: 'Acme HQ reception', phone: '+31 20 000', line1: '5 Main St', city: 'Amsterdam', postalCode: '1011AB', country: 'The Netherlands' }
const input: LabelInput = { carrierId: 'se-28529731', serviceCode: 'ups_standard', from: depot, to: site, packages: 2, weightKg: 4.5, reference: 'NORD0001234' }

describe('labelRequestBody', () => {
    it('builds a ShipEngine POST /v1/labels body with the carrier account, one package per box and the order reference', () => {
        const body = JSON.parse(labelRequestBody(input))
        expect(body).toEqual({
            shipment: {
                carrier_id: 'se-28529731',
                service_code: 'ups_standard',
                ship_from: {
                    name: 'NaaS Depot',
                    company_name: 'Demo NaaS Provider',
                    phone: '+31 30 000',
                    address_line1: '1 Depot Way',
                    city_locality: 'Utrecht',
                    postal_code: '3511AA',
                    country_code: 'NL',
                },
                ship_to: {
                    name: 'Acme HQ reception',
                    phone: '+31 20 000',
                    address_line1: '5 Main St',
                    city_locality: 'Amsterdam',
                    postal_code: '1011AB',
                    country_code: 'NL',
                },
                packages: [
                    { weight: { value: 4.5, unit: 'kilogram' }, label_messages: { reference1: 'NORD0001234' } },
                    { weight: { value: 4.5, unit: 'kilogram' }, label_messages: { reference1: 'NORD0001234' } },
                ],
            },
            label_format: 'pdf',
        })
    })

    it('leaves out empty address parts instead of sending empty strings', () => {
        const body = JSON.parse(labelRequestBody({ ...input, to: { ...site, company: '', phone: '', line2: '', state: '' } }))
        expect(Object.values(body.shipment.ship_to)).not.toContain('')
        expect(Object.keys(body.shipment.ship_to)).toEqual(['name', 'address_line1', 'city_locality', 'postal_code', 'country_code'])
        const full = JSON.parse(labelRequestBody({ ...input, to: { ...site, company: 'Acme', line2: 'Floor 3', state: 'NH' } }))
        expect(full.shipment.ship_to).toMatchObject({ company_name: 'Acme', address_line2: 'Floor 3', state_province: 'NH' })
    })

    it('sends between 1 and 20 boxes', () => {
        expect(JSON.parse(labelRequestBody({ ...input, packages: 0 })).shipment.packages).toHaveLength(1)
        expect(JSON.parse(labelRequestBody({ ...input, packages: 35 })).shipment.packages).toHaveLength(20)
    })
})

describe('packageCount', () => {
    it('is a whole number from 1 to 20', () => {
        expect(packageCount(3)).toBe(3)
        expect(packageCount(2.7)).toBe(2)
        expect(packageCount(0)).toBe(1)
        expect(packageCount(-4)).toBe(1)
        expect(packageCount(21)).toBe(20)
        expect(packageCount(Number.NaN)).toBe(1)
    })
})

describe('addressProblem', () => {
    it('names the missing parts', () => {
        expect(addressProblem({ ...site, line1: '', postalCode: '' })).toBe('missing line1, postalCode')
        expect(addressProblem(site)).toBeNull()
    })

    it('needs the phone on the sender (ship_from) side only', () => {
        const noPhone: Address = { ...depot, phone: undefined }
        expect(addressProblem(noPhone, 'from')).toBe('missing phone')
        expect(addressProblem({ ...noPhone, city: '' }, 'from')).toBe('missing phone, city')
        expect(addressProblem(noPhone, 'to')).toBeNull()
        expect(addressProblem(noPhone)).toBeNull()
        expect(addressProblem(depot, 'from')).toBeNull()
    })

    it('needs a state in the U.S. and Canada', () => {
        const austin: Address = { name: 'Acme Austin', phone: '+1 512 000 0000', line1: '1 Congress Ave', city: 'Austin', postalCode: '78701', country: 'US' }
        expect(addressProblem(austin)).toBe('missing state')
        expect(addressProblem({ ...austin, country: 'Canada' }, 'from')).toBe('missing state')
        expect(addressProblem({ ...austin, state: 'TX' })).toBeNull()
        expect(addressProblem(site)).toBeNull()
    })

    it('needs a country it can turn into an ISO code', () => {
        expect(addressProblem({ ...site, country: 'Atlantis' })).toBe('unknown country "Atlantis" (use the ISO code)')
    })
})

describe('countryCode', () => {
    it('reads ISO codes and common country names', () => {
        expect(countryCode('de')).toBe('DE')
        expect(countryCode('Germany')).toBe('DE')
        expect(countryCode(' United  Kingdom ')).toBe('GB')
        expect(countryCode('Switzerland')).toBe('CH')
        expect(countryCode('Narnia')).toBe('')
    })
})

/** A ShipEngine `create_label_response_body` as in the API reference (only the parts the app reads, plus the required ones). */
const LABEL_RESPONSE = {
    label_id: 'se-28529731',
    status: 'completed',
    shipment_id: 'se-28529731',
    tracking_number: '1Z63R096YW00000000',
    carrier_id: 'se-28529731',
    carrier_code: 'ups',
    service_code: 'ups_standard',
    shipment_cost: { currency: 'usd', amount: 21.4 },
    label_download: {
        href: 'https://api.shipengine.com/v1/downloads/10/F91Hn4rNBEOKgWsR5ez3Ww/label-28529731.pdf',
        pdf: 'https://api.shipengine.com/v1/downloads/10/F91Hn4rNBEOKgWsR5ez3Ww/label-28529731.pdf',
        png: 'https://api.shipengine.com/v1/downloads/10/F91Hn4rNBEOKgWsR5ez3Ww/label-28529731.png',
        zpl: 'https://api.shipengine.com/v1/downloads/10/F91Hn4rNBEOKgWsR5ez3Ww/label-28529731.zpl',
    },
}

describe('buyLabel', () => {
    it('posts the label request and reads the tracking number and label', () => {
        const calls: HttpRequest[] = []
        const result = buyLabel(
            (request) => {
                calls.push(request)
                return { status: 200, body: JSON.stringify(LABEL_RESPONSE) }
            },
            input,
        )
        expect(calls).toHaveLength(1)
        expect(calls[0]).toMatchObject({ fn: 'create_label', params: {} })
        expect(JSON.parse(calls[0].body ?? '').shipment).toMatchObject({ carrier_id: 'se-28529731', service_code: 'ups_standard' })
        expect(result).toEqual({
            ok: true,
            labelId: 'se-28529731',
            trackingNumber: '1Z63R096YW00000000',
            carrier: 'ups',
            labelUrl: LABEL_RESPONSE.label_download.pdf,
            cost: 21.4,
            currency: 'USD',
        })
    })

    it('falls back to the label href and a EUR currency', () => {
        const body = JSON.stringify({ ...LABEL_RESPONSE, label_download: { href: 'https://labels.example/se-1.pdf' }, shipment_cost: { amount: 0 } })
        expect(buyLabel(() => ({ status: 200, body }), input)).toMatchObject({ ok: true, labelUrl: 'https://labels.example/se-1.pdf', cost: 0, currency: 'EUR' })
    })

    it('reports aggregator errors and incomplete addresses without calling out', () => {
        expect(buyLabel(() => ({ status: 400, body: '{"errors":[{"message":"Invalid postal code"}]}' }), input)).toEqual({ ok: false, error: 'HTTP 400: Invalid postal code' })
        let called = false
        const http = () => {
            called = true
            return { status: 200, body: '{}' }
        }
        expect(buyLabel(http, { ...input, to: { ...site, city: '' } })).toEqual({ ok: false, error: 'to address missing city' })
        expect(buyLabel(http, { ...input, from: { ...depot, phone: '' } })).toEqual({ ok: false, error: 'from address missing phone' })
        expect(buyLabel(http, { ...input, from: { ...site, phone: '' }, to: depot })).toEqual({ ok: false, error: 'from address missing phone' })
        expect(called).toBe(false)
    })
})

/** An EasyPost Event envelope as in the Events reference; `result` is the object the Event is about. */
function easyPostEvent(description: string, result: Record<string, unknown>) {
    return {
        id: 'evt_7a7e8c8e5a5a11f0a6b23cecef1b359e',
        object: 'Event',
        mode: 'test',
        description,
        previous_attributes: {},
        result,
        status: 'pending',
        pending_urls: ['https://example.service-now.com/api/x_daas_ham/naas/shipping/tracking'],
        completed_urls: [],
        created_at: '2026-11-07T07:10:05Z',
        updated_at: '2026-11-07T07:10:05Z',
    }
}

describe('parseTrackingWebhook', () => {
    it('reads ShipEngine track events', () => {
        const update = parseTrackingWebhook({
            resource_type: 'API_TRACK',
            data: {
                tracking_number: '1Z999',
                status_code: 'DE',
                status_description: 'Delivered',
                actual_delivery_date: '2026-11-06T14:02:00Z',
                events: [{ occurred_at: '2026-11-06T14:02:00Z', status_code: 'DE', description: 'Delivered, front desk', city_locality: 'Amsterdam', country_code: 'NL' }],
            },
        })
        expect(update).toEqual({
            trackingNumber: '1Z999',
            status: 'delivered',
            description: 'Delivered',
            estimatedDelivery: undefined,
            deliveredAt: '2026-11-06T14:02:00Z',
            events: [{ occurredAt: '2026-11-06T14:02:00Z', status: 'delivered', description: 'Delivered, front desk', location: 'Amsterdam, NL' }],
        })
    })

    it('reads EasyPost tracker updates', () => {
        const update = parseTrackingWebhook(easyPostEvent('tracker.updated', {
            id: 'trk_c8e0edb5bb284caa934a0d3db23a148z',
            object: 'Tracker',
            mode: 'test',
            tracking_code: 'EZ100',
            status: 'out_for_delivery',
            status_detail: 'out_for_delivery',
            est_delivery_date: '2026-11-07',
            carrier: 'UPS',
            tracking_details: [
                { object: 'TrackingDetail', datetime: '2026-11-06T08:00:00Z', status: 'in_transit', message: 'Departed hub', tracking_location: { object: 'TrackingLocation', city: 'Utrecht', state: null, country: 'NL', zip: null } },
                { object: 'TrackingDetail', datetime: '2026-11-07T07:10:00Z', status: 'out_for_delivery', message: 'Out for delivery', tracking_location: { object: 'TrackingLocation', city: 'Amsterdam', state: null, country: null, zip: null } },
            ],
        }))
        expect(update).toMatchObject({ trackingNumber: 'EZ100', status: 'out_for_delivery', description: 'Out for delivery', estimatedDelivery: '2026-11-07' })
        expect('events' in update && update.events.map((e) => e.location)).toEqual(['Utrecht, NL', 'Amsterdam'])
    })

    it('takes the latest EasyPost scan by its time, whatever the order and time zone', () => {
        const update = parseTrackingWebhook(easyPostEvent('tracker.updated', {
            object: 'Tracker',
            tracking_code: 'EZ100',
            status: 'delivered',
            status_detail: 'arrived_at_destination',
            tracking_details: [
                { datetime: '2026-11-07T10:30:00Z', status: 'delivered', message: 'Delivered, front desk' },
                { datetime: '2026-11-07T11:15:00+02:00', status: 'out_for_delivery', message: 'Out for delivery' },
                { datetime: '2026-11-06T08:00:00Z', status: 'in_transit', message: 'Departed hub' },
                { status: 'unknown', message: 'Undated note' },
            ],
        }))
        expect(update).toMatchObject({ status: 'delivered', description: 'Delivered, front desk', deliveredAt: '2026-11-07T10:30:00Z' })
        expect('events' in update && update.events.map((e) => e.description)).toEqual(['Delivered, front desk', 'Out for delivery', 'Departed hub', 'Undated note'])
    })

    it('falls back to the status detail when no scan is listed', () => {
        expect(parseTrackingWebhook(easyPostEvent('tracker.created', { object: 'Tracker', tracking_code: 'EZ100', status: 'pre_transit', status_detail: 'label_created', tracking_details: [] }))).toMatchObject({
            status: 'label_created',
            description: 'label_created',
            events: [],
        })
    })

    it('refuses EasyPost Events about other objects, such as a cancelled insurance', () => {
        const insurance = easyPostEvent('insurance.cancelled', {
            id: 'ins_1ca9c4d6bbb04ba6b3d8fbf2bbee1b47',
            object: 'Insurance',
            mode: 'test',
            tracking_code: 'EZ100',
            status: 'cancelled',
            amount: '100.00',
        })
        expect(parseTrackingWebhook(insurance)).toEqual({ error: 'not a tracking update (Insurance)' })
    })

    it('gives the estimated delivery as a calendar date', () => {
        const shipEngine = parseTrackingWebhook({ data: { tracking_number: '1Z999', status_code: 'IT', estimated_delivery_date: '2026-11-07T00:00:00Z' } })
        expect(shipEngine).toMatchObject({ status: 'in_transit', estimatedDelivery: '2026-11-07', deliveredAt: undefined })
        const easyPost = parseTrackingWebhook({ result: { tracking_code: 'EZ100', status: 'in_transit', est_delivery_date: '2026-11-07T18:00:00Z' } })
        expect(easyPost).toMatchObject({ estimatedDelivery: '2026-11-07' })
    })

    it('reads unrecognised carrier statuses as unknown', () => {
        const update = parseTrackingWebhook({ data: { tracking_number: '1Z999', status_code: 'ZZ', events: [{ occurred_at: '2026-11-06T08:00:00Z', status_code: 'QQ' }] } })
        expect(update).toMatchObject({ status: 'unknown', events: [{ status: 'unknown', location: '' }] })
    })

    it('treats statuses outside the table as unknown, even inherited property names', () => {
        expect(parseTrackingWebhook({ result: { tracking_code: 'X', status: 'constructor' } })).toMatchObject({ status: 'unknown' })
        expect(parseTrackingWebhook({ data: { tracking_number: 'X', status_code: 'ZZ' } })).toMatchObject({ status: 'unknown' })
    })

    it('rejects payloads without a tracking number', () => {
        expect(parseTrackingWebhook({ data: {} })).toEqual({ error: 'not a tracking update (no tracking number)' })
        expect(parseTrackingWebhook('nonsense')).toHaveProperty('error')
    })
})

describe('nextShipmentStatus', () => {
    it('follows the carrier until the shipment is delivered or returned', () => {
        expect(nextShipmentStatus('label_created', 'in_transit')).toBe('in_transit')
        expect(nextShipmentStatus('exception', 'in_transit')).toBe('in_transit')
        expect(nextShipmentStatus('in_transit', 'delivered')).toBe('delivered')
    })

    it('ignores late or unknown updates', () => {
        expect(nextShipmentStatus('delivered', 'in_transit')).toBe('delivered')
        expect(nextShipmentStatus('returned', 'out_for_delivery')).toBe('returned')
        expect(nextShipmentStatus('in_transit', 'unknown')).toBe('in_transit')
    })

    it('lets a return to sender override a delivery', () => {
        expect(nextShipmentStatus('delivered', 'returned')).toBe('returned')
    })
})

function trackingUpdate(status: ShipmentStatus, description = 'Carrier says so'): TrackingUpdate {
    return { trackingNumber: '1Z999', status, description, events: [] }
}

describe('applyTracking', () => {
    it('takes the carrier status and its description', () => {
        expect(applyTracking('label_created', trackingUpdate('in_transit', 'Departed hub'))).toEqual({ status: 'in_transit', detail: 'Departed hub', deliveredNow: false })
    })

    it('marks the first delivery only', () => {
        expect(applyTracking('in_transit', trackingUpdate('delivered', 'Delivered'))).toEqual({ status: 'delivered', detail: 'Delivered', deliveredNow: true })
        expect(applyTracking('delivered', trackingUpdate('delivered', 'Delivered'))).toEqual({ status: 'delivered', detail: 'Delivered', deliveredNow: false })
    })

    it('keeps the status and its detail on a late or unknown update', () => {
        const late = applyTracking('delivered', trackingUpdate('in_transit', 'Departed hub'))
        expect(late).toEqual({ status: 'delivered', deliveredNow: false })
        expect(late).not.toHaveProperty('detail')
        const unknown = applyTracking('in_transit', trackingUpdate('unknown', 'Status not available'))
        expect(unknown).toEqual({ status: 'in_transit', deliveredNow: false })
        expect(unknown).not.toHaveProperty('detail')
    })

    it('cuts the detail to 255 characters', () => {
        expect(applyTracking('in_transit', trackingUpdate('exception', 'x'.repeat(300))).detail).toHaveLength(255)
    })
})

describe('trackingEventKey', () => {
    it('is the time and the stored description', () => {
        expect(trackingEventKey({ occurredAt: '2026-11-06T14:02:00Z', description: 'Delivered' })).toBe('2026-11-06T14:02:00Z|Delivered')
        expect(trackingEventKey({ occurredAt: 't', description: 'y'.repeat(300) })).toBe(`t|${'y'.repeat(255)}`)
    })
})

describe('newTrackingEvents', () => {
    const departed: TrackingEvent = { occurredAt: '2026-11-06T08:00:00Z', status: 'in_transit', description: 'Departed hub', location: 'Utrecht, NL' }
    const delivered: TrackingEvent = { occurredAt: '2026-11-07T10:00:00Z', status: 'delivered', description: 'Delivered', location: 'Amsterdam, NL' }

    it('skips events already stored', () => {
        expect(newTrackingEvents(new Set([trackingEventKey(departed)]), [departed, delivered])).toEqual([delivered])
        expect(newTrackingEvents(new Set([trackingEventKey(departed), trackingEventKey(delivered)]), [departed, delivered])).toEqual([])
    })

    it('keeps one of each event within a batch', () => {
        expect(newTrackingEvents(new Set(), [departed, delivered, { ...departed }])).toEqual([departed, delivered])
    })

    it('cuts description and location to the stored lengths', () => {
        const long: TrackingEvent = { ...departed, description: 'd'.repeat(300), location: 'l'.repeat(150) }
        const [event] = newTrackingEvents(new Set(), [long])
        expect(event.description).toBe('d'.repeat(255))
        expect(event.location).toBe('l'.repeat(120))
        expect(newTrackingEvents(new Set([trackingEventKey(long)]), [{ ...long, description: `${'d'.repeat(255)}more` }])).toEqual([])
    })
})

describe('webhookToken', () => {
    it('reads the documented custom header and falls back to ?token=', () => {
        expect(WEBHOOK_TOKEN_HEADER).toBe('x-naas-webhook-token')
        expect(webhookToken('s3cret', '')).toBe('s3cret')
        expect(webhookToken('s3cret', 'old')).toBe('s3cret')
        expect(webhookToken(undefined, 'old')).toBe('old')
        expect(webhookToken(null, 'old')).toBe('old')
        expect(webhookToken('', 'old')).toBe('old')
        expect(webhookToken(undefined, '')).toBe('')
    })
})

describe('tokenMatches', () => {
    it('matches only the configured, non-empty secret', () => {
        expect(tokenMatches('s3cret', 's3cret')).toBe(true)
        expect(tokenMatches('s3creT', 's3cret')).toBe(false)
        expect(tokenMatches('s3cre', 's3cret')).toBe(false)
        expect(tokenMatches('', '')).toBe(false)
    })
})
