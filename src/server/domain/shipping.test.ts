import { describe, expect, it } from 'vitest'
import type { HttpRequest } from './http'
import { addressProblem, buyLabel, labelRequestBody, parseTrackingWebhook, tokenMatches, type Address, type LabelInput } from './shipping'

const depot: Address = { name: 'NaaS Depot', company: 'Demo NaaS Provider', line1: '1 Depot Way', city: 'Utrecht', postalCode: '3511AA', country: 'nl' }
const site: Address = { name: 'Acme HQ reception', phone: '+31 20 000', line1: '5 Main St', city: 'Amsterdam', postalCode: '1011AB', country: 'NL' }
const input: LabelInput = { serviceCode: 'ups_standard', from: depot, to: site, packages: 2, weightKg: 4.5, reference: 'NORD0001234' }

describe('labelRequestBody', () => {
    it('builds one package per box with the order reference', () => {
        const body = JSON.parse(labelRequestBody(input))
        expect(body.shipment.service_code).toBe('ups_standard')
        expect(body.shipment.ship_from).toMatchObject({ address_line1: '1 Depot Way', country_code: 'NL', company_name: 'Demo NaaS Provider' })
        expect(body.shipment.ship_to).toMatchObject({ name: 'Acme HQ reception', city_locality: 'Amsterdam', postal_code: '1011AB' })
        expect(body.shipment.packages).toHaveLength(2)
        expect(body.shipment.packages[0]).toEqual({ weight: { value: 4.5, unit: 'kilogram' }, label_messages: { reference1: 'NORD0001234' } })
    })
})

describe('addressProblem', () => {
    it('names the missing parts', () => {
        expect(addressProblem({ ...site, line1: '', postalCode: '' })).toBe('missing line1, postalCode')
        expect(addressProblem(site)).toBeNull()
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

    it('rejects payloads without a tracking number', () => {
        expect(parseTrackingWebhook({ data: {} })).toEqual({ error: 'not a tracking update (no tracking number)' })
        expect(parseTrackingWebhook('nonsense')).toHaveProperty('error')
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
