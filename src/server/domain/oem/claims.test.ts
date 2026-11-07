import { describe, expect, it } from 'vitest'
import type { HttpRequest, HttpResponse } from '../http'
import { CLAIM_ROUTES, CLAIM_VENDORS, dueStepsQuery, runVendorClaims, type ClaimAction, type ClaimOutcome, type ClaimStore, type ClaimTarget } from './claims'

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
    it('fails every device of a refused GreenLake batch with the API error', () => {
        const { http } = fake([{ status: 403, body: JSON.stringify({ message: 'Forbidden' }) }])
        const result = CLAIM_ROUTES.aruba!.oem_claim!.run([target('A', { account: '' }), target('B', { account: '' })], http, 5)
        expect(result.outcomes).toEqual([
            { stepId: 'A', ok: false, message: 'HTTP 403: Forbidden' },
            { stepId: 'B', ok: false, message: 'HTTP 403: Forbidden' },
        ])
    })

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
        expect(result.outcomes[0]).toEqual({ stepId: 'A', ok: true, message: 'provisioned to FortiManager FMG-1' })
    })

    it('makes one FortiZTP call per device within the budget, and needs the FortiManager', () => {
        const { http, calls } = fake([{ status: 200, body: '{}' }])
        const result = CLAIM_ROUTES.fortinet!.oem_ztp!.run([target('A', { account: '' }), target('B'), target('C'), target('D')], http, 2)
        expect(calls).toHaveLength(2)
        expect(result.outcomes.map((o) => [o.stepId, o.ok])).toEqual([
            ['A', false],
            ['B', true],
            ['C', true],
        ])
        expect(result.outcomes[0].message).toBe('no cloud account configured for this customer')
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

/** A ClaimStore over fixed due steps per action (cut to `limit`), recording what is loaded and settled. */
function fakeStore(due: Partial<Record<ClaimAction, ClaimTarget[]>> = {}) {
    const loads: Array<[ClaimAction, number]> = []
    const vendors: string[] = []
    const settled: ClaimOutcome[] = []
    const store: ClaimStore = {
        due: (vendor, action, limit) => {
            vendors.push(vendor)
            loads.push([action, limit])
            return (due[action] ?? []).slice(0, limit)
        },
        settle: (outcome) => {
            settled.push(outcome)
        },
    }
    return { store, loads, vendors, settled }
}

/** A transport that hands out one HTTP fake, recording which REST message each action asked for. */
function fakeTransport(responses: Array<HttpResponse | ((request: HttpRequest) => HttpResponse)>) {
    const { http, calls } = fake(responses)
    const messages: string[] = []
    const transport = (message: string) => {
        messages.push(message)
        return http
    }
    return { transport, messages, calls }
}

/** Answers every vendor function with success (GreenLake finds the device, FortiCloud status 0). */
const succeed = (request: HttpRequest): HttpResponse =>
    request.fn === 'find_device' ? { status: 200, body: JSON.stringify({ items: [{ id: 'dev-1' }] }) } : { status: 200, body: JSON.stringify({ status: 0 }) }

const many = (prefix: string, count: number, accounts = 1): ClaimTarget[] =>
    Array.from({ length: count }, (_, i) => target(`${prefix}${i}`, { account: `acct${i % accounts}` }))

describe('runVendorClaims', () => {
    it('loads the steps of the vendor it runs, sized for Mist and Check Point too', () => {
        const { store, loads, vendors } = fakeStore()
        runVendorClaims('mist', store, fakeTransport([succeed]).transport, 1)
        runVendorClaims('checkpoint', store, fakeTransport([succeed]).transport, 8)
        expect(vendors).toEqual(['mist', 'checkpoint'])
        expect(loads).toEqual([
            ['oem_claim', 100],
            ['oem_ztp', 8],
        ])
    })

    it('loads as many steps as the budget can carry, at most 200', () => {
        const { store, loads } = fakeStore()
        runVendorClaims('meraki', store, fakeTransport([succeed]).transport, 8)
        runVendorClaims('meraki', store, fakeTransport([succeed]).transport, 1)
        expect(loads).toEqual([
            ['oem_claim', 200],
            ['oem_claim', 50],
        ])
    })

    it('adds Aruba devices before assigning subscriptions, from one shared budget', () => {
        const { store, loads, settled } = fakeStore({
            oem_claim: [target('A', { account: '' }), target('B', { account: '' })],
            oem_licence: many('L', 5),
        })
        const { transport, messages, calls } = fakeTransport([succeed])
        expect(runVendorClaims('aruba', store, transport, 8)).toBe(7)
        expect(loads).toEqual([
            ['oem_claim', 200],
            ['oem_licence', 4],
        ])
        expect(messages).toEqual(['NaaS HPE GreenLake', 'NaaS HPE GreenLake'])
        expect(calls.map((c) => c.fn)).toEqual(['add_devices', ...Array(3).fill(['find_device', 'assign_subscription']).flat()])
        expect(settled.map((o) => o.stepId)).toEqual(['A', 'B', 'L0', 'L1', 'L2'])
    })

    it('registers FortiGates in FortiCloud before provisioning them through FortiZTP', () => {
        const { store, loads } = fakeStore({ oem_claim: [target('A', { account: '' })], oem_ztp: [target('B', { account: 'FMG-1' })] })
        const { transport, messages } = fakeTransport([succeed])
        expect(runVendorClaims('fortinet', store, transport, 8)).toBe(2)
        expect(loads).toEqual([
            ['oem_claim', 80],
            ['oem_ztp', 7],
        ])
        expect(messages).toEqual(['NaaS FortiCare', 'NaaS FortiZTP'])
    })

    it('spends no calls on an action with no due steps', () => {
        const { store, loads } = fakeStore()
        const { transport, messages } = fakeTransport([succeed])
        expect(runVendorClaims('aruba', store, transport, 8)).toBe(0)
        expect(loads).toEqual([
            ['oem_claim', 200],
            ['oem_licence', 4],
        ])
        expect(messages).toEqual([])
    })

    it('does not load later actions once the budget is spent', () => {
        const { store, loads } = fakeStore({ oem_claim: [target('A')], oem_ztp: [target('B')] })
        expect(runVendorClaims('fortinet', store, fakeTransport([succeed]).transport, 1)).toBe(1)
        expect(loads).toEqual([['oem_claim', 10]])
    })

    it('loads nothing when no calls are allowed', () => {
        const { store, loads } = fakeStore({ oem_claim: [target('A')] })
        expect(runVendorClaims('meraki', store, fakeTransport([succeed]).transport, 0)).toBe(0)
        expect(loads).toEqual([])
    })

    it('never makes more calls than maxCalls', () => {
        for (const vendor of CLAIM_VENDORS) {
            for (let maxCalls = 0; maxCalls <= 12; maxCalls++) {
                const { store } = fakeStore({ oem_claim: many('C', 300, 7), oem_licence: many('L', 300, 7), oem_ztp: many('Z', 300, 7) })
                const { transport, calls } = fakeTransport([succeed])
                const made = runVendorClaims(vendor, store, transport, maxCalls)
                expect(calls.length, `${vendor} with ${maxCalls} calls`).toBeLessThanOrEqual(maxCalls)
                expect(made, `${vendor} with ${maxCalls} calls`).toBe(calls.length)
            }
        }
    })

    it('settles every attempted or refused step once, with the message cut to 255 characters', () => {
        const error = 'x'.repeat(300)
        const { store, settled } = fakeStore({ oem_claim: [target('A'), target('B', { account: '' })] })
        runVendorClaims('meraki', store, fakeTransport([{ status: 400, body: JSON.stringify({ errors: [error] }) }]).transport, 8)
        expect(settled).toEqual([
            { stepId: 'B', ok: false, message: 'no cloud account configured for this customer' },
            { stepId: 'A', ok: false, message: `HTTP 400: ${error}`.slice(0, 255) },
        ])
        expect(settled[1].message).toHaveLength(255)
    })

    it('leaves loaded steps the budget did not reach for the next run', () => {
        const { store, settled } = fakeStore({ oem_claim: [target('A'), target('B', { account: 'org2' })] })
        expect(runVendorClaims('meraki', store, fakeTransport([{ status: 200, body: '{}' }]).transport, 1)).toBe(1)
        expect(settled.map((o) => o.stepId)).toEqual(['A'])
    })

    it('has nothing for Cisco (PnP has no public API)', () => {
        const { store, loads } = fakeStore({ oem_claim: [target('A')] })
        expect(CLAIM_VENDORS).not.toContain('cisco')
        expect(runVendorClaims('cisco', store, fakeTransport([succeed]).transport, 8)).toBe(0)
        expect(loads).toEqual([])
    })
})

describe('dueStepsQuery', () => {
    it('finds open pending steps, and failed ones to retry, of the vendor and action in each OR group', () => {
        const groups = dueStepsQuery('aruba', 'oem_licence')
            .split('^NQ')
            .map((group) => group.split('^'))
        expect(groups).toHaveLength(2)
        for (const group of groups) {
            expect(group).toEqual(
                expect.arrayContaining(['automation=oem_licence', 'done=false', 'staging_task.active=true', 'staging_task.asset.model.x_daas_ham_oem_source=aruba']),
            )
        }
        expect(groups[0]).toContain('automation_status=pending')
        expect(groups[1]).toEqual(expect.arrayContaining(['automation_status=failed', 'attempts<5', 'sys_updated_on<javascript:gs.minutesAgoStart(30)']))
    })
})
