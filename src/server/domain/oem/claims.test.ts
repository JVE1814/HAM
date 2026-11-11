import { describe, expect, it } from 'vitest'
import type { HttpRequest, HttpResponse } from '../http'
import { claimRoutes, CLAIM_VENDORS } from './adapters'
import {
    FORTICLOUD_REGISTER,
    FORTIZTP_PROVISION,
    GREENLAKE_ADD,
    GREENLAKE_SUBSCRIBE,
    MERAKI_CLAIM,
    MIST_CLAIM,
    ZERO_TOUCH_CLAIM,
} from './claim-adapters'
import {
    dependentActions,
    dueStepsQuery,
    settledStatus,
    initialAutomationStatus,
    runVendorClaims,
    type ClaimOutcome,
    type ClaimStore,
    type ClaimTarget,
} from './claims'
import type { ClaimAction } from '../vocabulary'
import { recordMatches } from '../../test-support/encoded-query'

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

const many = (prefix: string, count: number, accounts = 1): ClaimTarget[] =>
    Array.from({ length: count }, (_, i) => target(`${prefix}${i}`, { account: `acct${i % accounts}` }))

describe('Meraki claim', () => {
    const run = MERAKI_CLAIM.run

    it('claims serials per org and ticks the ones returned', () => {
        // claimIntoOrganizationInventory 200: { orders, serials (the serials claimed), licenses }
        const { http, calls } = fake([{ status: 200, body: JSON.stringify({ orders: [], serials: ['q2xx-a'], licenses: [] }) }])
        const result = run([target('A'), target('B')], http, 10)
        expect(calls).toHaveLength(1)
        expect(calls[0]).toMatchObject({ fn: 'claim_inventory', params: { org_id: 'org1' } })
        expect(JSON.parse(calls[0].body ?? '')).toEqual({ serials: ['Q2XX-A', 'Q2XX-B'] })
        expect(result.outcomes).toEqual([
            { stepId: 'A', ok: true, message: 'claimed into Meraki org org1' },
            { stepId: 'B', ok: false, message: 'not in the claimed serials' },
        ])
    })

    it('matches returned serials ignoring case and surrounding spaces', () => {
        const { http } = fake([{ status: 200, body: JSON.stringify({ serials: [' q2xx-a '] }) }])
        expect(run([target('A', { serial: 'Q2XX-A ' })], http, 10).outcomes).toEqual([{ stepId: 'A', ok: true, message: 'claimed into Meraki org org1' }])
    })

    it('reads an explicit empty serials list as nothing claimed', () => {
        const { http } = fake([{ status: 200, body: JSON.stringify({ orders: [], serials: [], licenses: [] }) }])
        expect(run([target('A')], http, 10).outcomes).toEqual([{ stepId: 'A', ok: false, message: 'not in the claimed serials' }])
    })

    it('counts the batch as claimed only when the response is a JSON object with no serials field', () => {
        const { http } = fake([{ status: 200, body: JSON.stringify({ orders: [], licenses: [] }) }])
        expect(run([target('A'), target('B')], http, 10).outcomes.map((o) => o.ok)).toEqual([true, true])
    })

    it('fails the batch on a 2xx whose body is not a JSON object, so no step waiting on the claim is released', () => {
        for (const body of ['', '<html>Bad gateway</html>', 'null', '[]', '"ok"']) {
            const { http } = fake([{ status: 200, body }])
            expect(run([target('A'), target('B')], http, 10).outcomes, body).toEqual([
                { stepId: 'A', ok: false, message: 'HTTP 200: the response is not a JSON object' },
                { stepId: 'B', ok: false, message: 'HTTP 200: the response is not a JSON object' },
            ])
        }
    })

    it('stops at the call budget and leaves the rest for the next run', () => {
        const { http } = fake([{ status: 200, body: '{}' }])
        const result = run([target('A'), target('B', { account: 'org2' })], http, 1)
        expect(result.calls).toBe(1)
        expect(result.outcomes.map((o) => o.stepId)).toEqual(['A'])
    })

    it("fails a batch that got no answer with the transport's reason", () => {
        const { http } = fake([{ status: 0, body: '', error: 'java.net.UnknownHostException: api.meraki.com' }])
        expect(run([target('A')], http, 10).outcomes).toEqual([{ stepId: 'A', ok: false, message: 'no response: java.net.UnknownHostException: api.meraki.com' }])
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
    const run = MIST_CLAIM.run

    /** A response_inventory body (addOrgInventory, 200 and 400). */
    const inventory = (result: { added?: string[]; duplicated?: string[]; error?: string[]; reason?: string[] }) =>
        JSON.stringify({ added: [], duplicated: [], error: [], reason: [], inventory_added: [], inventory_duplicated: [], ...result })

    it('counts added and duplicated codes as done and reports the reason for errors', () => {
        const { http, calls } = fake([
            { status: 200, body: inventory({ added: ['CODEA'], duplicated: ['CODEB'], error: ['CODEC'], reason: ['invalid claim code'] }) },
        ])
        const result = run([target('A'), target('B'), target('C')], http, 5)
        expect(calls[0]).toMatchObject({ fn: 'claim_inventory', params: { org_id: 'org1' } })
        expect(JSON.parse(calls[0].body ?? '')).toEqual(['CODEA', 'CODEB', 'CODEC'])
        expect(result.outcomes.map((o) => [o.stepId, o.ok, o.message])).toEqual([
            ['A', true, 'claimed into Mist org org1'],
            ['B', true, 'claimed into Mist org org1'],
            ['C', false, 'invalid claim code'],
        ])
    })

    it('reads the per-code result of a 400 (no code valid) instead of failing the batch', () => {
        const { http } = fake([{ status: 400, body: inventory({ duplicated: ['CODEA'], error: ['CODEB'], reason: ['claim code already used'] }) }])
        expect(run([target('A'), target('B')], http, 5).outcomes).toEqual([
            { stepId: 'A', ok: true, message: 'claimed into Mist org org1' },
            { stepId: 'B', ok: false, message: 'claim code already used' },
        ])
    })

    it('fails the batch on an error without a per-code result', () => {
        const { http } = fake([{ status: 400, body: JSON.stringify({ detail: 'invalid org' }) }])
        expect(run([target('A'), target('B')], http, 5).outcomes.map((o) => o.message)).toEqual(['HTTP 400: invalid org', 'HTTP 400: invalid org'])
    })

    it('joins the reasons when they are not one per rejected code', () => {
        const { http } = fake([{ status: 400, body: inventory({ error: ['CODEA', 'CODEB', 'CODEC'], reason: ['invalid claim code', 'claim code already used'] }) }])
        const result = run([target('A'), target('B'), target('C')], http, 5)
        expect(result.outcomes.map((o) => o.message)).toEqual(Array(3).fill('invalid claim code; claim code already used'))
    })

    it('matches claim codes without separators and case', () => {
        const { http, calls } = fake([{ status: 200, body: inventory({ added: ['6JG8EPTFV2A9Z2N'], error: ['DVH4VSNMSZPDXBR'], reason: ['invalid claim code'] }) }])
        const result = run([target('A', { claimCode: '6jg8e-ptfv2-a9z2n' }), target('B', { claimCode: 'DVH4V-SNMSZ-PDXBR' })], http, 5)
        expect(JSON.parse(calls[0].body ?? '')).toEqual(['6jg8e-ptfv2-a9z2n', 'DVH4V-SNMSZ-PDXBR'])
        expect(result.outcomes.map((o) => [o.stepId, o.ok, o.message])).toEqual([
            ['A', true, 'claimed into Mist org org1'],
            ['B', false, 'invalid claim code'],
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
        const result = GREENLAKE_ADD.run([target('A', { account: '' }), target('B', { account: '' })], http, 5)
        expect(result.outcomes).toEqual([
            { stepId: 'A', ok: false, message: 'HTTP 403: Forbidden' },
            { stepId: 'B', ok: false, message: 'HTTP 403: Forbidden' },
        ])
    })

    /** postDevicesV1 202: progress at the Location URL; body { code, status, transactionId }. */
    const accepted = { status: 202, body: JSON.stringify({ code: 202, status: 'Accepted', transactionId: 'tx-1' }) }
    const SUB = '6b1a3b8e-0c1d-4c3e-9f7a-2d5e8b9c0a11'
    /** getDevicesV1 200: { items: [{ id, serialNumber, partNumber, type, subscription: [{ id, key, tier }] }], count, offset, total }. */
    const devices = (subscription: Array<{ id: string; key: string; tier?: string }> = []) => ({
        status: 200,
        body: JSON.stringify({
            items: [{ id: 'f3c1b2a0-1111-4222-8333-444455556666', serialNumber: 'Q2XX-A', partNumber: 'R4W02A', type: 'devices/device', subscription }],
            count: 1,
            offset: 0,
            total: 1,
        }),
    })

    it('adds network devices with serial and MAC, with the required compute and storage lists empty', () => {
        const { http, calls } = fake([accepted])
        const result = GREENLAKE_ADD.run([target('A', { account: '' })], http, 5)
        expect(calls[0]).toMatchObject({ fn: 'add_devices', params: {} })
        expect(JSON.parse(calls[0].body ?? '')).toEqual({ network: [{ serialNumber: 'Q2XX-A', macAddress: '00:11:22:33:44:55' }], compute: [], storage: [] })
        expect(result.outcomes[0]).toEqual({ stepId: 'A', ok: true, message: 'added to the GreenLake workspace' })
    })

    it('adds at most five devices per call', () => {
        const { http, calls } = fake([accepted])
        const result = GREENLAKE_ADD.run(many('A', 6), http, 5)
        expect(calls.map((c) => JSON.parse(c.body ?? '').network.length)).toEqual([5, 1])
        expect(result.calls).toBe(2)
    })

    it('assigns the subscription after finding the device, two calls each', () => {
        const { http, calls } = fake([devices(), accepted])
        const result = GREENLAKE_SUBSCRIBE.run([target('A', { account: SUB }), target('B', { account: SUB })], http, 3)
        expect(calls.map((c) => c.fn)).toEqual(['find_device', 'assign_subscription'])
        expect(calls[0]).toMatchObject({ params: { serial: 'Q2XX-A' } })
        expect(calls[1]).toMatchObject({ params: { device_id: 'f3c1b2a0-1111-4222-8333-444455556666' } })
        expect(JSON.parse(calls[1].body ?? '')).toEqual({ subscription: [{ id: SUB }] })
        expect(result).toEqual({ outcomes: [{ stepId: 'A', ok: true, message: `subscription ${SUB} assigned` }], calls: 2 })
    })

    it('ticks a device that already carries the subscription id without a PATCH', () => {
        const { http, calls } = fake([devices([{ id: SUB.toUpperCase(), key: 'SIEIAASTEST018ID', tier: 'FOUNDATION_AP' }])])
        const result = GREENLAKE_SUBSCRIBE.run([target('A', { account: SUB })], http, 5)
        expect(calls.map((c) => c.fn)).toEqual(['find_device'])
        expect(result).toEqual({ outcomes: [{ stepId: 'A', ok: true, message: `subscription ${SUB} assigned` }], calls: 1 })
    })

    it('still assigns when the device only carries another subscription (the key is not the id)', () => {
        const { http, calls } = fake([devices([{ id: 'aaaaaaaa-0000-4000-8000-000000000000', key: SUB }]), accepted])
        GREENLAKE_SUBSCRIBE.run([target('A', { account: SUB })], http, 5)
        expect(calls.map((c) => c.fn)).toEqual(['find_device', 'assign_subscription'])
    })

    it('waits while the device is not in the workspace yet', () => {
        const { http } = fake([{ status: 200, body: JSON.stringify({ items: [] }) }])
        expect(GREENLAKE_SUBSCRIBE.run([target('A')], http, 5).outcomes).toEqual([
            { stepId: 'A', ok: false, message: 'device not in the GreenLake workspace yet' },
        ])
    })
})

describe('Fortinet', () => {
    it('registers serials without a customer account (status 0 = registered)', () => {
        const { http, calls } = fake([{ status: 200, body: JSON.stringify({ status: 0, message: 'Success' }) }])
        const result = FORTICLOUD_REGISTER.run([target('A', { account: '' })], http, 5)
        expect(JSON.parse(calls[0].body ?? '').registrationUnits[0]).toMatchObject({ serialNumber: 'Q2XX-A' })
        expect(result.outcomes[0]).toEqual({ stepId: 'A', ok: true, message: 'registered in FortiCloud' })
    })

    it('reports a refused registration', () => {
        const { http } = fake([{ status: 200, body: JSON.stringify({ status: 1, message: 'Serial number already registered' }) }])
        expect(FORTICLOUD_REGISTER.run([target('A')], http, 5).outcomes[0]).toEqual({ stepId: 'A', ok: false, message: 'Serial number already registered' })
    })

    it('provisions through FortiZTP to the customer FortiManager', () => {
        const { http, calls } = fake([{ status: 200, body: '{}' }])
        const result = FORTIZTP_PROVISION.run([target('A', { account: 'FMG-1' })], http, 5)
        expect(calls[0]).toMatchObject({ fn: 'provision_device', params: { serial: 'Q2XX-A' } })
        expect(JSON.parse(calls[0].body ?? '')).toMatchObject({ provisionStatus: 'provisioned', fortiManagerOid: 'FMG-1' })
        expect(result.outcomes[0]).toEqual({ stepId: 'A', ok: true, message: 'provisioned to FortiManager FMG-1' })
    })

    it('makes one FortiZTP call per device within the budget, and needs the FortiManager', () => {
        const { http, calls } = fake([{ status: 200, body: '{}' }])
        const result = FORTIZTP_PROVISION.run([target('A', { account: '' }), target('B'), target('C'), target('D')], http, 2)
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
    const run = ZERO_TOUCH_CLAIM.run
    /** web_api/v2 login 200: { sid, user, url, last-login-was-at }. */
    const loggedIn = { status: 200, body: JSON.stringify({ sid: 'aB3+x/9=', user: 'api-user', url: 'https://zerotouch.checkpoint.com', 'last-login-was-at': '2026-11-07T08:00:00' }) }
    /** claim-gateway 200: an array with the gateway configuration and status. */
    const claimed = {
        status: 200,
        body: JSON.stringify([{ 'gateway-configuration': { 'template-name': 'Branch' }, 'gateway-status': { 'status-value': 'set', 'display-status': 'Ready to deploy' } }]),
    }
    const loggedOut = { status: 200, body: JSON.stringify({ code: '17999', message: 'Logout succeeded' }) }
    const reply = (claim: HttpResponse) => (request: HttpRequest): HttpResponse => (request.fn === 'login' ? loggedIn : request.fn === 'logout' ? loggedOut : claim)

    it('logs in, claims each gateway with the account and template ids, then logs out', () => {
        const { http, calls } = fake([reply(claimed)])
        const result = run([target('A', { account: '1234567/42' }), target('B', { account: ' 1234567 / 43 ' })], http, 5)
        expect(calls.map((c) => c.fn)).toEqual(['login', 'claim_gateway', 'claim_gateway', 'logout'])
        expect(calls[0]).toEqual({ fn: 'login', params: {} })
        expect(calls[1].params).toEqual({})
        expect(calls[1].headers).toEqual({ 'X-chkp-sid': 'aB3+x/9=' })
        expect(JSON.parse(calls[1].body ?? '')).toEqual({ 'object-name': 'Q2XX-A', 'account-id': 1234567, 'template-id': 42, mac: '00:11:22:33:44:55' })
        expect(JSON.parse(calls[2].body ?? '')).toMatchObject({ 'account-id': 1234567, 'template-id': 43 })
        expect(calls[3]).toEqual({ fn: 'logout', params: {}, headers: { 'X-chkp-sid': 'aB3+x/9=' } })
        expect(result).toEqual({
            outcomes: [
                { stepId: 'A', ok: true, message: 'claimed with Zero Touch template 42' },
                { stepId: 'B', ok: true, message: 'claimed with Zero Touch template 43' },
            ],
            calls: 4,
        })
    })

    it('reports a refused claim with the API message', () => {
        const { http } = fake([reply({ status: 400, body: JSON.stringify({ message: 'Template does not exist', messages: [], code: '400' }) })])
        expect(run([target('A', { account: '1234567/42' })], http, 5).outcomes).toEqual([{ stepId: 'A', ok: false, message: 'HTTP 400: Template does not exist' }])
    })

    it('counts login and logout against the budget and needs three calls', () => {
        const { http, calls } = fake([reply(claimed)])
        expect(run(many('Z', 5).map((t) => ({ ...t, account: '1/2' })), http, 4)).toMatchObject({ calls: 4 })
        expect(calls.map((c) => c.fn)).toEqual(['login', 'claim_gateway', 'claim_gateway', 'logout'])
        const three = fake([succeed])
        expect(run([target('A', { account: '1/2' }), target('B', { account: '1/2' })], three.http, 3).calls).toBe(3)
        expect(three.calls.map((c) => c.fn)).toEqual(['login', 'claim_gateway', 'logout'])
        const idle = fake([reply(claimed)])
        expect(run([target('A', { account: '1/2' })], idle.http, 2)).toEqual({ outcomes: [], calls: 0 })
        expect(idle.calls).toHaveLength(0)
    })

    it('fails the gateways it would claim when the login fails, and does not log out', () => {
        const { http, calls } = fake([{ status: 401, body: JSON.stringify({ message: 'Invalid api-key', messages: [], code: '401' }) }])
        const result = run([target('A', { account: '1/2' }), target('B', { account: '1/2' })], http, 3)
        expect(calls.map((c) => c.fn)).toEqual(['login'])
        expect(result).toEqual({ outcomes: [{ stepId: 'A', ok: false, message: 'Zero Touch login failed: HTTP 401: Invalid api-key' }], calls: 1 })
    })

    it('fails the gateways when the login succeeds without a session id', () => {
        const { http, calls } = fake([{ status: 200, body: JSON.stringify({ message: 'ok' }) }])
        const result = run([target('A', { account: '1/2' })], http, 3)
        expect(calls.map((c) => c.fn)).toEqual(['login'])
        expect(result).toEqual({ outcomes: [{ stepId: 'A', ok: false, message: 'Zero Touch login failed: no session id returned' }], calls: 1 })
    })

    it('refuses an account that is not "<account id>/<template id>" and a missing MAC without logging in', () => {
        const { http, calls } = fake([reply(claimed)])
        const result = run([target('A', { account: 'branch-tpl' }), target('B', { account: '1/2', mac: '' }), target('C', { account: '' })], http, 5)
        expect(calls).toHaveLength(0)
        expect(result.outcomes).toEqual([
            { stepId: 'B', ok: false, message: 'missing mac' },
            { stepId: 'C', ok: false, message: 'no cloud account configured for this customer' },
            { stepId: 'A', ok: false, message: 'cloud account must be "<User Center account id>/<template id>"' },
        ])
    })
})

/** A ClaimStore over fixed due steps per action (cut to `limit`), recording the actions loaded and what is settled (each settle call's step ids in `settles`). */
function fakeStore(due: Partial<Record<ClaimAction, ClaimTarget[]>> = {}) {
    const loads: ClaimAction[] = []
    const vendors: string[] = []
    const settled: ClaimOutcome[] = []
    const settles: string[][] = []
    const store: ClaimStore = {
        due: (vendor, action, limit) => {
            vendors.push(vendor)
            loads.push(action)
            return (due[action] ?? []).slice(0, limit)
        },
        settle: (outcomes) => {
            settles.push(outcomes.map((o) => o.stepId))
            settled.push(...outcomes)
        },
    }
    return { store, loads, vendors, settled, settles }
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

/** Answers every vendor function with success (GreenLake finds the device, Zero Touch logs in, FortiCloud status 0). */
const succeed = (request: HttpRequest): HttpResponse =>
    request.fn === 'find_device'
        ? { status: 200, body: JSON.stringify({ items: [{ id: 'dev-1' }] }) }
        : request.fn === 'login'
          ? { status: 200, body: JSON.stringify({ sid: 'sid-1' }) }
          : { status: 200, body: JSON.stringify({ status: 0 }) }

describe('runVendorClaims', () => {
    it('loads the steps of the vendor it runs, for the actions that vendor has', () => {
        const { store, loads, vendors } = fakeStore()
        runVendorClaims('mist', claimRoutes('mist'), store, fakeTransport([succeed]).transport, 1, () => true)
        runVendorClaims('checkpoint', claimRoutes('checkpoint'), store, fakeTransport([succeed]).transport, 8, () => true)
        expect(vendors).toEqual(['mist', 'checkpoint'])
        expect(loads).toEqual(['oem_claim', 'oem_ztp'])
    })

    it.each([
        ['meraki', 'oem_claim', 3],
        ['mist', 'oem_claim', 2],
        ['aruba', 'oem_claim', 8],
        ['aruba', 'oem_licence', 8],
        ['fortinet', 'oem_claim', 8],
        ['fortinet', 'oem_ztp', 8],
        ['checkpoint', 'oem_ztp', 8],
    ] as const)('loads enough of the due steps to make every call it is allowed (%s %s, %i calls)', (vendor, action, maxCalls) => {
        const { store } = fakeStore({ [action]: many('S', 300).map((t) => ({ ...t, account: '1/2' })) })
        const { transport, calls } = fakeTransport([succeed])
        expect(runVendorClaims(vendor, claimRoutes(vendor), store, transport, maxCalls, () => true).calls).toBe(maxCalls)
        expect(calls).toHaveLength(maxCalls)
    })

    it('adds Aruba devices before assigning subscriptions, from one shared budget', () => {
        const { store, loads, settled, settles } = fakeStore({
            oem_claim: [target('A', { account: '' }), target('B', { account: '' })],
            oem_licence: many('L', 5),
        })
        const { transport, messages, calls } = fakeTransport([succeed])
        expect(runVendorClaims('aruba', claimRoutes('aruba'), store, transport, 8, () => true).calls).toBe(7)
        expect(loads).toEqual(['oem_claim', 'oem_licence'])
        expect(messages).toEqual(['NaaS HPE GreenLake', 'NaaS HPE GreenLake'])
        expect(calls.map((c) => c.fn)).toEqual(['add_devices', ...Array(3).fill(['find_device', 'assign_subscription']).flat()])
        expect(settled.map((o) => o.stepId)).toEqual(['A', 'B', 'L0', 'L1', 'L2'])
        expect(settles).toEqual([
            ['A', 'B'],
            ['L0', 'L1', 'L2'],
        ])
    })

    it('registers FortiGates in FortiCloud before provisioning them through FortiZTP', () => {
        const { store, loads } = fakeStore({ oem_claim: [target('A', { account: '' })], oem_ztp: [target('B', { account: 'FMG-1' })] })
        const { transport, messages } = fakeTransport([succeed])
        expect(runVendorClaims('fortinet', claimRoutes('fortinet'), store, transport, 8, () => true).calls).toBe(2)
        expect(loads).toEqual(['oem_claim', 'oem_ztp'])
        expect(messages).toEqual(['NaaS FortiCare', 'NaaS FortiZTP'])
    })

    it('sends nothing once the run loses its lock, settling only the calls already made', () => {
        const { store, loads, settled } = fakeStore({
            oem_claim: [target('A', { account: '' }), target('B', { account: '' })],
            oem_licence: many('L', 5),
        })
        const { transport, calls } = fakeTransport([succeed])
        let checks = 0
        // Held for the first load and its call only: GreenLake's add sends both devices in one call, then the licence steps wait.
        const run = runVendorClaims('aruba', claimRoutes('aruba'), store, transport, 8, () => ++checks <= 2)
        expect(calls.map((c) => c.fn)).toEqual(['add_devices'])
        expect(settled.map((o) => o.stepId)).toEqual(['A', 'B'])
        expect(loads).toEqual(['oem_claim'])
        expect(run).toEqual({ calls: 1, lockLost: true })
    })

    it('settles nothing of a call it did not send, and spends no call on it', () => {
        const { store, settled } = fakeStore({ oem_claim: [target('A'), target('B', { account: '' }), target('C', { account: 'org2' })] })
        const { transport, calls } = fakeTransport([succeed])
        let checks = 0
        // Held for the load and Meraki's first batch (org1) only: the org2 batch is not sent.
        const run = runVendorClaims('meraki', claimRoutes('meraki'), store, transport, 8, () => ++checks <= 2)
        expect(calls).toHaveLength(1)
        expect(settled.map((o) => o.stepId)).toEqual(['B', 'A'])
        expect(run).toEqual({ calls: 1, lockLost: true })
    })

    it('loads nothing once the lock is lost', () => {
        const { store, loads, settled } = fakeStore({ oem_claim: [target('A', { account: '' })], oem_ztp: [target('B', { account: 'FMG-1' })] })
        const { transport, calls } = fakeTransport([succeed])
        expect(runVendorClaims('fortinet', claimRoutes('fortinet'), store, transport, 8, () => false)).toEqual({ calls: 0, lockLost: true })
        expect(calls).toEqual([])
        expect(settled).toEqual([])
        expect(loads).toEqual([])
    })

    it('spends no calls on an action with no due steps', () => {
        const { store, loads } = fakeStore()
        const { transport, messages } = fakeTransport([succeed])
        expect(runVendorClaims('aruba', claimRoutes('aruba'), store, transport, 8, () => true).calls).toBe(0)
        expect(loads).toEqual(['oem_claim', 'oem_licence'])
        expect(messages).toEqual([])
    })

    it('does not load later actions once the budget is spent', () => {
        const { store, loads } = fakeStore({ oem_claim: [target('A')], oem_ztp: [target('B')] })
        expect(runVendorClaims('fortinet', claimRoutes('fortinet'), store, fakeTransport([succeed]).transport, 1, () => true).calls).toBe(1)
        expect(loads).toEqual(['oem_claim'])
    })

    it('loads nothing when no calls are allowed', () => {
        const { store, loads } = fakeStore({ oem_claim: [target('A')] })
        expect(runVendorClaims('meraki', claimRoutes('meraki'), store, fakeTransport([succeed]).transport, 0, () => true).calls).toBe(0)
        expect(loads).toEqual([])
    })

    it('never makes more calls than maxCalls', () => {
        for (const vendor of CLAIM_VENDORS) {
            for (let maxCalls = 0; maxCalls <= 12; maxCalls++) {
                // Zero Touch accounts are "<account id>/<template id>", so the Check Point session path runs too.
                const zeroTouch = many('Z', 300).map((t, i) => ({ ...t, account: `${(i % 7) + 1}/1` }))
                const { store } = fakeStore({ oem_claim: many('C', 300, 7), oem_licence: many('L', 300, 7), oem_ztp: zeroTouch })
                const { transport, calls } = fakeTransport([succeed])
                const made = runVendorClaims(vendor, claimRoutes(vendor), store, transport, maxCalls, () => true).calls
                expect(calls.length, `${vendor} with ${maxCalls} calls`).toBeLessThanOrEqual(maxCalls)
                expect(made, `${vendor} with ${maxCalls} calls`).toBe(calls.length)
            }
        }
    })

    it('settles every attempted or refused step once, in one call, with the message cut to 255 characters', () => {
        const error = 'x'.repeat(300)
        const { store, settled, settles } = fakeStore({ oem_claim: [target('A'), target('B', { account: '' })] })
        runVendorClaims('meraki', claimRoutes('meraki'), store, fakeTransport([{ status: 400, body: JSON.stringify({ errors: [error] }) }]).transport, 8, () => true)
        expect(settles).toEqual([['B', 'A']])
        expect(settled).toEqual([
            { stepId: 'B', ok: false, message: 'no cloud account configured for this customer' },
            { stepId: 'A', ok: false, message: `HTTP 400: ${error}`.slice(0, 255) },
        ])
        expect(settled[1].message).toHaveLength(255)
    })

    it('leaves loaded steps the budget did not reach for the next run', () => {
        const { store, settled } = fakeStore({ oem_claim: [target('A'), target('B', { account: 'org2' })] })
        expect(runVendorClaims('meraki', claimRoutes('meraki'), store, fakeTransport([{ status: 200, body: '{}' }]).transport, 1, () => true).calls).toBe(1)
        expect(settled.map((o) => o.stepId)).toEqual(['A'])
    })

    it('has nothing for Cisco (PnP has no public API)', () => {
        const { store, loads } = fakeStore({ oem_claim: [target('A')] })
        expect(CLAIM_VENDORS).not.toContain('cisco')
        expect(runVendorClaims('cisco', claimRoutes('cisco'), store, fakeTransport([succeed]).transport, 8, () => true).calls).toBe(0)
        expect(loads).toEqual([])
    })
})

/** `gs.minutesAgoStart(n)` as a stored date/time: n minutes before 2026-11-09 12:00:00. */
function minutesAgo(expression: string): string {
    const minutes = /^gs\.minutesAgoStart\((\d+)\)$/.exec(expression)?.[1]
    if (minutes === undefined) throw new Error(`no value for ${expression}`)
    return new Date(Date.parse('2026-11-09T12:00:00Z') - Number(minutes) * 60000).toISOString().slice(0, 19).replace('T', ' ')
}

/** An open licence step of an active staging task on an Aruba fleet asset: pending, never sent. */
const pendingStep = (fields: Record<string, string> = {}) => ({
    automation: 'oem_licence',
    done: 'false',
    automation_status: 'pending',
    attempts: '0',
    sys_updated_on: '2026-11-09 11:59:00',
    'staging_task.active': 'true',
    'staging_task.asset.model.x_daas_ham_oem_source': 'aruba',
    'staging_task.asset.x_daas_ham_fleet': 'true',
    ...fields,
})
/** The same step failed once, a day ago. */
const failedStep = (fields: Record<string, string> = {}) => pendingStep({ automation_status: 'failed', attempts: '1', sys_updated_on: '2026-11-08 12:00:00', ...fields })
const due = (step: Record<string, string>) => recordMatches(dueStepsQuery('aruba', 'oem_licence'), step, minutesAgo)

describe('dueStepsQuery', () => {
    it('finds a pending step at once, and a failed one once it has waited, while it has attempts left', () => {
        expect(due(pendingStep())).toBe(true)
        expect(due(failedStep())).toBe(true)
        expect(due(failedStep({ sys_updated_on: '2026-11-09 11:59:00' }))).toBe(false)
        expect(due(failedStep({ attempts: '1000' }))).toBe(false)
    })

    it("finds, pending or failed, only the open steps of the action on the vendor's fleet assets whose staging task is active", () => {
        for (const step of [pendingStep, failedStep]) {
            expect(due(step({ automation: 'oem_claim' }))).toBe(false)
            expect(due(step({ done: 'true' }))).toBe(false)
            expect(due(step({ 'staging_task.active': 'false' }))).toBe(false)
            expect(due(step({ 'staging_task.asset.model.x_daas_ham_oem_source': 'meraki' }))).toBe(false)
            expect(due(step({ 'staging_task.asset.x_daas_ham_fleet': 'false' }))).toBe(false)
            expect(due(step({ 'staging_task.asset.x_daas_ham_fleet': '' }))).toBe(false)
        }
    })

    it('never finds steps waiting for their prerequisite step', () => {
        expect(due(pendingStep({ automation_status: 'waiting' }))).toBe(false)
        expect(due(failedStep({ automation_status: 'waiting' }))).toBe(false)
    })
})

describe('dependentActions', () => {
    it('lists the actions that wait on each action', () => {
        expect(dependentActions('oem_claim')).toEqual(['oem_licence', 'oem_ztp'])
        expect(dependentActions('oem_licence')).toEqual([])
        expect(dependentActions('')).toEqual([])
    })
})

describe('initialAutomationStatus', () => {
    it('makes licensing and zero-touch steps wait when the staging task also gets a claim step', () => {
        expect(initialAutomationStatus('oem_licence', ['', 'oem_claim', 'oem_licence'])).toBe('waiting')
        expect(initialAutomationStatus('oem_ztp', ['oem_ztp', 'oem_claim'])).toBe('waiting')
    })

    it('makes them pending when the staging task has no claim step', () => {
        expect(initialAutomationStatus('oem_licence', ['', 'oem_licence'])).toBe('pending')
        expect(initialAutomationStatus('oem_ztp', ['oem_licence', 'oem_ztp'])).toBe('pending')
    })

    it('makes the claim step, which waits for nothing, pending', () => {
        expect(initialAutomationStatus('oem_claim', ['oem_claim', 'oem_licence', 'oem_ztp'])).toBe('pending')
    })
})

describe('settledStatus', () => {
    it('ticks a step whose call succeeded and fails the others, which are due again later', () => {
        expect(settledStatus({ stepId: 's1', ok: true, message: '' })).toBe('done')
        expect(settledStatus({ stepId: 's1', ok: false, message: 'no' })).toBe('failed')
        expect(due(failedStep({ automation_status: settledStatus({ stepId: 's1', ok: false, message: 'no' }) }))).toBe(true)
        expect(due(failedStep({ automation_status: settledStatus({ stepId: 's1', ok: true, message: '' }) }))).toBe(false)
    })
})
