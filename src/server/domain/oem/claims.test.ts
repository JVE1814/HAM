import { describe, expect, it } from 'vitest'
import type { HttpRequest, HttpResponse } from '../http'
import { CLAIM_ROUTES, type ClaimTarget } from './claims'

function fake(responses: Array<HttpResponse | ((request: HttpRequest) => HttpResponse)>) {
    const calls: HttpRequest[] = []
    let i = 0
    const http = (request: HttpRequest): HttpResponse => {
        calls.push(request)
        const next = responses[Math.min(i++, responses.length - 1)]
        return typeof next === 'function' ? next(request) : next
    }
    return { http, calls }
}

const target = (stepId: string, overrides: Partial<ClaimTarget> = {}): ClaimTarget => ({
    stepId,
    serial: `Q2XX-${stepId}`,
    mac: '00:11:22:33:44:55',
    claimCode: `CODE${stepId}`,
    account: 'org1',
    ...overrides,
})

describe('Meraki claim', () => {
    const run = CLAIM_ROUTES.meraki!.oem_claim!.run

    it('claims serials per org and ticks the ones returned', () => {
        const { http, calls } = fake([{ status: 200, body: JSON.stringify({ serials: ['Q2XX-A'] }) }])
        const result = run([target('A'), target('B')], http, 10)
        expect(calls).toHaveLength(1)
        expect(calls[0]).toMatchObject({ fn: 'claim_inventory', params: { org_id: 'org1' } })
        expect(JSON.parse(calls[0].body ?? '')).toEqual({ serials: ['Q2XX-A', 'Q2XX-B'] })
        expect(result.outcomes.map((o) => [o.stepId, o.ok])).toEqual([
            ['A', true],
            ['B', false],
        ])
    })

    it('stops at the call budget and leaves the rest for the next run', () => {
        const { http } = fake([{ status: 200, body: '{}' }])
        const result = run([target('A'), target('B', { account: 'org2' })], http, 1)
        expect(result.calls).toBe(1)
        expect(result.outcomes.map((o) => o.stepId)).toEqual(['A'])
    })

    it('fails a batch on an API error and needs an org', () => {
        const { http } = fake([{ status: 400, body: JSON.stringify({ errors: ['Device already claimed in another organization'] }) }])
        const result = run([target('A'), target('B', { account: '' })], http, 10)
        expect(result.outcomes).toEqual([
            { stepId: 'B', ok: false, message: 'no cloud account configured for this customer' },
            { stepId: 'A', ok: false, message: 'HTTP 400: Device already claimed in another organization' },
        ])
    })
})

describe('Mist claim', () => {
    const run = CLAIM_ROUTES.mist!.oem_claim!.run

    it('counts added and duplicated codes as done and reports the reason for errors', () => {
        const { http, calls } = fake([
            { status: 200, body: JSON.stringify({ added: ['CODEA'], duplicated: ['CODEB'], error: ['CODEC'], reason: ['invalid claim code'] }) },
        ])
        const result = run([target('A'), target('B'), target('C')], http, 5)
        expect(JSON.parse(calls[0].body ?? '')).toEqual(['CODEA', 'CODEB', 'CODEC'])
        expect(result.outcomes.map((o) => [o.stepId, o.ok, o.message])).toEqual([
            ['A', true, 'claimed into Mist org org1'],
            ['B', true, 'claimed into Mist org org1'],
            ['C', false, 'invalid claim code'],
        ])
    })

    it('needs a claim code', () => {
        const { http, calls } = fake([{ status: 200, body: '{}' }])
        expect(run([target('A', { claimCode: '' })], http, 5).outcomes).toEqual([{ stepId: 'A', ok: false, message: 'missing claim code' }])
        expect(calls).toHaveLength(0)
    })
})

describe('GreenLake', () => {
    it('adds network devices with serial and MAC', () => {
        const { http, calls } = fake([{ status: 202, body: '' }])
        const result = CLAIM_ROUTES.aruba!.oem_claim!.run([target('A', { account: '' })], http, 5)
        expect(JSON.parse(calls[0].body ?? '')).toEqual({ network: [{ serialNumber: 'Q2XX-A', macAddress: '00:11:22:33:44:55' }] })
        expect(result.outcomes[0].ok).toBe(true)
    })

    it('assigns the subscription after finding the device, two calls each', () => {
        const { http, calls } = fake([
            { status: 200, body: JSON.stringify({ items: [{ id: 'dev-1' }] }) },
            { status: 202, body: '' },
        ])
        const result = CLAIM_ROUTES.aruba!.oem_licence!.run([target('A', { account: 'sub-9' }), target('B', { account: 'sub-9' })], http, 3)
        expect(calls.map((c) => c.fn)).toEqual(['find_device', 'assign_subscription'])
        expect(calls[1]).toMatchObject({ params: { device_id: 'dev-1' } })
        expect(JSON.parse(calls[1].body ?? '')).toEqual({ subscription: [{ id: 'sub-9' }] })
        expect(result).toEqual({ outcomes: [{ stepId: 'A', ok: true, message: 'subscription sub-9 assigned' }], calls: 2 })
    })

    it('waits while the device is not in the workspace yet', () => {
        const { http } = fake([{ status: 200, body: JSON.stringify({ items: [] }) }])
        expect(CLAIM_ROUTES.aruba!.oem_licence!.run([target('A')], http, 5).outcomes).toEqual([
            { stepId: 'A', ok: false, message: 'device not in the GreenLake workspace yet' },
        ])
    })
})

describe('Fortinet', () => {
    it('registers serials without a customer account (status 0 = registered)', () => {
        const { http, calls } = fake([{ status: 200, body: JSON.stringify({ status: 0, message: 'Success' }) }])
        const result = CLAIM_ROUTES.fortinet!.oem_claim!.run([target('A', { account: '' })], http, 5)
        expect(JSON.parse(calls[0].body ?? '').registrationUnits[0]).toMatchObject({ serialNumber: 'Q2XX-A' })
        expect(result.outcomes[0]).toEqual({ stepId: 'A', ok: true, message: 'registered in FortiCloud' })
    })

    it('reports a refused registration', () => {
        const { http } = fake([{ status: 200, body: JSON.stringify({ status: 1, message: 'Serial number already registered' }) }])
        expect(CLAIM_ROUTES.fortinet!.oem_claim!.run([target('A')], http, 5).outcomes[0]).toEqual({ stepId: 'A', ok: false, message: 'Serial number already registered' })
    })

    it('provisions through FortiZTP to the customer FortiManager', () => {
        const { http, calls } = fake([{ status: 200, body: '{}' }])
        const result = CLAIM_ROUTES.fortinet!.oem_ztp!.run([target('A', { account: 'FMG-1' })], http, 5)
        expect(calls[0]).toMatchObject({ fn: 'provision_device', params: { serial: 'Q2XX-A' } })
        expect(JSON.parse(calls[0].body ?? '')).toMatchObject({ provisionStatus: 'provisioned', fortiManagerOid: 'FMG-1' })
        expect(result.outcomes[0].ok).toBe(true)
    })
})

describe('Check Point Zero Touch', () => {
    it('assigns the gateway to the customer template', () => {
        const { http, calls } = fake([{ status: 500, body: JSON.stringify({ message: 'Unknown template' }) }])
        const result = CLAIM_ROUTES.checkpoint!.oem_ztp!.run([target('A', { account: 'branch-tpl' })], http, 5)
        expect(JSON.parse(calls[0].body ?? '')).toEqual({ serialNumber: 'Q2XX-A', template: 'branch-tpl' })
        expect(result.outcomes[0]).toEqual({ stepId: 'A', ok: false, message: 'HTTP 500: Unknown template' })
    })
})

describe('CLAIM_ROUTES', () => {
    it('has nothing for Cisco (PnP has no public API)', () => {
        expect(CLAIM_ROUTES.cisco).toBeUndefined()
    })
})
