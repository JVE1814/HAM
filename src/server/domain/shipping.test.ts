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
    type Address,
    type LabelInput,
    type ShipmentStatus,
    type TrackingEvent,
    type TrackingUpdate,
} from './shipping'

const depot: Address = { name: 'NaaS Depot', company: 'Demo NaaS Provider', line1: '1 Depot Way', city: 'Utrecht', postalCode: '3511AA', country: 'nl' }
const site: Address = { name: 'Acme HQ reception', phone: '+31 20 000', line1: '5 Main St', city: 'Amsterdam', postalCode: '1011AB', country: 'The Netherlands' }
const input: LabelInput = { serviceCode: 'ups_standard', from: depot, to: site, packages: 2, weightKg: 4.5, reference: 'NORD0001234' }

describe('labelRequestBody', () => {
    it('builds one package per box with the order reference', () => {
        const body = JSON.parse(labelRequestBody(input))
        expect(body.shipment.service_code).toBe('ups_standard')
        expect(body.shipment.ship_from).toMatchObject({ address_line1: '1 Depot Way', country_code: 'NL', company_name: 'Demo NaaS Provider' })
        expect(body.shipment.ship_to).toMatchObject({ name: 'Acme HQ reception', city_locality: 'Amsterdam', postal_code: '1011AB', country_code: 'NL' })
        expect(body.shipment.packages).toHaveLength(2)
        expect(body.shipment.packages[0]).toEqual({ weight: { value: 4.5, unit: 'kilogram' }, label_messages: { reference1: 'NORD0001234' } })
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

describe('buyLabel', () => {
    it('posts the label request and reads the tracking number and label', () => {
        const calls: HttpRequest[] = []
        const result = buyLabel(
            (request) => {
                calls.push(request)
                return {
                    status: 200,
                    body: JSON.stringify({
                        label_id: 'se-1',
                        tracking_number: '1Z999',
                        carrier_code: 'ups',
                        label_download: { pdf: 'https://labels.example/se-1.pdf' },
                        shipment_cost: { amount: 21.4, currency: 'eur' },
                    }),
                }
            },
            input,
        )
        expect(calls[0].fn).toBe('create_label')
        expect(result).toEqual({ ok: true, labelId: 'se-1', trackingNumber: '1Z999', carrier: 'ups', labelUrl: 'https://labels.example/se-1.pdf', cost: 21.4, currency: 'EUR' })
    })

    it('reports aggregator errors and incomplete addresses without calling out', () => {
        expect(buyLabel(() => ({ status: 400, body: '{"errors":[{"message":"Invalid postal code"}]}' }), input)).toEqual({ ok: false, error: 'HTTP 400: Invalid postal code' })
        let called = false
        const result = buyLabel(
            () => {
                called = true
                return { status: 200, body: '{}' }
            },
            { ...input, to: { ...site, city: '' } },
        )
        expect(result).toEqual({ ok: false, error: 'to address missing city' })
        expect(called).toBe(false)
    })
})

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
        const update = parseTrackingWebhook({
            object: 'Event',
            description: 'tracker.updated',
            result: {
                tracking_code: 'EZ100',
                status: 'out_for_delivery',
                est_delivery_date: '2026-11-07',
                tracking_details: [
                    { datetime: '2026-11-06T08:00:00Z', status: 'in_transit', message: 'Departed hub', tracking_location: { city: 'Utrecht', country: 'NL' } },
                    { datetime: '2026-11-07T07:10:00Z', status: 'out_for_delivery', message: 'Out for delivery', tracking_location: { city: 'Amsterdam' } },
                ],
            },
        })
        expect(update).toMatchObject({ trackingNumber: 'EZ100', status: 'out_for_delivery', description: 'Out for delivery', estimatedDelivery: '2026-11-07' })
        expect('events' in update && update.events.map((e) => e.location)).toEqual(['Utrecht, NL', 'Amsterdam'])
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

describe('tokenMatches', () => {
    it('matches only the configured, non-empty secret', () => {
        expect(tokenMatches('s3cret', 's3cret')).toBe(true)
        expect(tokenMatches('s3creT', 's3cret')).toBe(false)
        expect(tokenMatches('s3cre', 's3cret')).toBe(false)
        expect(tokenMatches('', '')).toBe(false)
    })
})
