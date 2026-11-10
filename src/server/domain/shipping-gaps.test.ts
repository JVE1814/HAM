import { describe, expect, it } from 'vitest'
import type { HttpResponse } from './http'
import { buyLabel, type Address, type LabelInput } from './shipping'

/*
 * buyLabel's answers without a tracking number: a label is recorded on a Shipment and put on the Order only with its
 * tracking number, so a 2xx that carries none (missing, blank, or a body that is not JSON) is a failure, never a label.
 */

const depot: Address = { name: 'NaaS Depot', company: 'Demo NaaS Provider', phone: '+31 30 000', line1: '1 Depot Way', city: 'Utrecht', postalCode: '3511AA', country: 'NL' }
const site: Address = { name: 'Acme HQ reception', phone: '+31 20 000', line1: '5 Main St', city: 'Amsterdam', postalCode: '1011AB', country: 'NL' }
const input: LabelInput = { carrierId: 'se-28529731', serviceCode: 'ups_standard', from: depot, to: site, packages: 1, weightKg: 5, reference: 'NORD0001234' }

const label = (fields: Record<string, unknown>): HttpResponse => ({
    status: 200,
    body: JSON.stringify({ label_id: 'se-1', carrier_code: 'ups', shipment_cost: { currency: 'usd', amount: 9.5 }, label_download: { pdf: 'https://labels.example/se-1.pdf' }, ...fields }),
})

const noTrackingNumber = { ok: false, error: 'the aggregator returned no tracking number' }

describe('buyLabel without a tracking number', () => {
    it('fails a label answer that carries no tracking number', () => {
        expect(buyLabel(() => label({}), input)).toEqual(noTrackingNumber)
    })

    it('fails a blank or null tracking number', () => {
        expect(buyLabel(() => label({ tracking_number: '   ' }), input)).toEqual(noTrackingNumber)
        expect(buyLabel(() => label({ tracking_number: null }), input)).toEqual(noTrackingNumber)
        expect(buyLabel(() => label({ tracking_number: { value: '1Z999' } }), input)).toEqual(noTrackingNumber)
    })

    it('fails a 2xx whose body is not JSON, or is empty', () => {
        expect(buyLabel(() => ({ status: 200, body: '<html>OK</html>' }), input)).toEqual(noTrackingNumber)
        expect(buyLabel(() => ({ status: 201, body: '' }), input)).toEqual(noTrackingNumber)
    })

    it('trims the tracking number it keeps', () => {
        expect(buyLabel(() => label({ tracking_number: ' 1Z999 ' }), input)).toMatchObject({ ok: true, trackingNumber: '1Z999' })
    })
})
