import { describe, expect, it } from 'vitest'
import type { HttpRequest, HttpResponse } from '../http'
import { claimRoutes } from './adapters'
import { FORTICLOUD_REGISTER, FORTIZTP_PROVISION, GREENLAKE_ADD, GREENLAKE_SUBSCRIBE, MERAKI_CLAIM, MIST_CLAIM, ZERO_TOUCH_CLAIM } from './claim-adapters'
import { runVendorClaims, type ClaimOutcome, type ClaimStore, type ClaimTarget } from './claims'

/*
 * The claim adapters' HTTP-failure branches: a call that gets no answer (status 0, the transport's reason) or a non-2xx
 * answer fails the steps it carried with that reason, and never ticks one. The happy paths and the API errors in a 2xx
 * envelope are in claims.test.ts.
 */

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

const timedOut: HttpResponse = { status: 0, body: '', error: 'Read timed out' }
const unavailable: HttpResponse = { status: 503, body: '<html>Service Unavailable</html>' }
const failedAll = (stepIds: string[], message: string): ClaimOutcome[] => stepIds.map((stepId) => ({ stepId, ok: false, message }))

describe('Mist claim', () => {
    const run = MIST_CLAIM.run

    it("fails a batch that got no answer with the transport's reason", () => {
        const { http, calls } = fake([timedOut])
        expect(run([target('A'), target('B')], http, 5)).toEqual({ outcomes: failedAll(['A', 'B'], 'no response: Read timed out'), calls: 1 })
        expect(calls).toHaveLength(1)
    })

    it('fails a batch on a server error whose body is not JSON', () => {
        const { http } = fake([unavailable])
        expect(run([target('A')], http, 5).outcomes).toEqual(failedAll(['A'], 'HTTP 503'))
    })
})

describe('Meraki claim', () => {
    it('fails a batch on a server error whose body is not JSON', () => {
        const { http } = fake([unavailable])
        expect(MERAKI_CLAIM.run([target('A'), target('B')], http, 5).outcomes).toEqual(failedAll(['A', 'B'], 'HTTP 503'))
    })
})

describe('GreenLake', () => {
    const add = GREENLAKE_ADD.run
    const subscribe = GREENLAKE_SUBSCRIBE.run
    const device = { status: 200, body: JSON.stringify({ items: [{ id: 'dev-1', serialNumber: 'Q2XX-A', subscription: [] }] }) }

    it("fails every device of an add that got no answer with the transport's reason", () => {
        const { http } = fake([timedOut])
        expect(add([target('A', { account: '' }), target('B', { account: '' })], http, 5).outcomes).toEqual(failedAll(['A', 'B'], 'no response: Read timed out'))
    })

    it('fails a subscription whose device look-up was refused with the API error, and assigns nothing', () => {
        const { http, calls } = fake([{ status: 401, body: JSON.stringify({ message: 'Unauthorized' }) }])
        const result = subscribe([target('A', { account: 'sub-1' })], http, 5)
        expect(result).toEqual({ outcomes: failedAll(['A'], 'HTTP 401: Unauthorized'), calls: 1 })
        expect(calls.map((c) => c.fn)).toEqual(['find_device'])
    })

    it("fails a subscription whose device look-up got no answer with the transport's reason", () => {
        const { http } = fake([timedOut])
        expect(subscribe([target('A', { account: 'sub-1' })], http, 5).outcomes).toEqual(failedAll(['A'], 'no response: Read timed out'))
    })

    it('fails a device found but whose assignment was refused, after both calls', () => {
        const { http, calls } = fake([device, { status: 422, body: JSON.stringify({ message: 'Subscription has no free seats' }) }])
        const result = subscribe([target('A', { account: 'sub-1' })], http, 5)
        expect(result).toEqual({ outcomes: failedAll(['A'], 'HTTP 422: Subscription has no free seats'), calls: 2 })
        expect(calls.map((c) => c.fn)).toEqual(['find_device', 'assign_subscription'])
    })

    it("fails a device found but whose assignment got no answer with the transport's reason", () => {
        const { http } = fake([device, timedOut])
        expect(subscribe([target('A', { account: 'sub-1' })], http, 5).outcomes).toEqual(failedAll(['A'], 'no response: Read timed out'))
    })

    it('reads a look-up answer that is not JSON as a device not in the workspace yet', () => {
        const { http, calls } = fake([{ status: 200, body: 'not json' }])
        expect(subscribe([target('A', { account: 'sub-1' })], http, 5).outcomes).toEqual(failedAll(['A'], 'device not in the GreenLake workspace yet'))
        expect(calls).toHaveLength(1)
    })
})

describe('Fortinet', () => {
    it('fails a registration batch refused over HTTP with the API error', () => {
        const { http } = fake([{ status: 401, body: JSON.stringify({ error: 'invalid_token', error_description: 'Token expired' }) }])
        expect(FORTICLOUD_REGISTER.run([target('A'), target('B')], http, 5).outcomes).toEqual(failedAll(['A', 'B'], 'HTTP 401: Token expired'))
    })

    it("fails a registration batch that got no answer with the transport's reason", () => {
        const { http } = fake([timedOut])
        expect(FORTICLOUD_REGISTER.run([target('A')], http, 5).outcomes).toEqual(failedAll(['A'], 'no response: Read timed out'))
    })

    it('fails a registration whose 2xx body is not a JSON object, rather than tick it', () => {
        const { http } = fake([{ status: 200, body: '' }])
        expect(FORTICLOUD_REGISTER.run([target('A')], http, 5).outcomes).toEqual(failedAll(['A'], 'response is not a JSON object'))
    })

    it('fails each FortiZTP device refused or unanswered on its own, and provisions the others', () => {
        const { http, calls } = fake([{ status: 404, body: JSON.stringify({ error: 'device not found' }) }, timedOut, { status: 200, body: '{}' }])
        const result = FORTIZTP_PROVISION.run([target('A', { account: 'FMG-1' }), target('B', { account: 'FMG-1' }), target('C', { account: 'FMG-1' })], http, 5)
        expect(calls).toHaveLength(3)
        expect(result.outcomes).toEqual([
            { stepId: 'A', ok: false, message: 'HTTP 404: device not found' },
            { stepId: 'B', ok: false, message: 'no response: Read timed out' },
            { stepId: 'C', ok: true, message: 'provisioned to FortiManager FMG-1' },
        ])
    })
})

describe('Check Point Zero Touch', () => {
    const run = ZERO_TOUCH_CLAIM.run
    const loggedIn = { status: 200, body: JSON.stringify({ sid: 'sid-1' }) }

    it("fails the gateways when the login got no answer, with the transport's reason, and does not log out", () => {
        const { http, calls } = fake([timedOut])
        const result = run([target('A', { account: '1234567/42' }), target('B', { account: '1234567/42' })], http, 5)
        expect(result).toEqual({ outcomes: failedAll(['A', 'B'], 'Zero Touch login failed: no response: Read timed out'), calls: 1 })
        expect(calls.map((c) => c.fn)).toEqual(['login'])
    })

    it('fails the gateways when the login answer is not JSON (no session id)', () => {
        const { http } = fake([{ status: 200, body: '<html></html>' }])
        expect(run([target('A', { account: '1234567/42' })], http, 5).outcomes).toEqual(failedAll(['A'], 'Zero Touch login failed: no session id returned'))
    })

    it('fails a gateway whose claim got no answer, claims the next, and still logs out', () => {
        const claimed = { status: 200, body: '[]' }
        const { http, calls } = fake([loggedIn, timedOut, claimed, { status: 200, body: '{}' }])
        const result = run([target('A', { account: '1234567/42' }), target('B', { account: '1234567/42' })], http, 5)
        expect(calls.map((c) => c.fn)).toEqual(['login', 'claim_gateway', 'claim_gateway', 'logout'])
        expect(result).toEqual({
            outcomes: [
                { stepId: 'A', ok: false, message: 'no response: Read timed out' },
                { stepId: 'B', ok: true, message: 'claimed with Zero Touch template 42' },
            ],
            calls: 4,
        })
    })
})

describe('a vendor run whose calls fail', () => {
    /** A store with `due` steps per action, recording what the run settles. */
    function store(due: Record<string, ClaimTarget[]>) {
        const settled: ClaimOutcome[][] = []
        const claimStore: ClaimStore = { due: (_vendor, action) => due[action] ?? [], settle: (outcomes) => void settled.push([...outcomes]) }
        return { claimStore, settled }
    }

    it('settles the failed steps with the reason and spends the calls it made', () => {
        const { claimStore, settled } = store({ oem_claim: [target('A'), target('B')] })
        const calls = runVendorClaims('meraki', claimRoutes('meraki'), claimStore, () => fake([timedOut]).http, 10)
        expect(calls).toBe(1)
        expect(settled).toEqual([failedAll(['A', 'B'], 'no response: Read timed out')])
    })

    it('still runs the later actions of the budget after a failed one', () => {
        const { claimStore, settled } = store({ oem_claim: [target('A', { account: '' })], oem_ztp: [target('Z', { account: 'FMG-1' })] })
        const transport = (message: string) => fake([message === 'NaaS FortiCare' ? unavailable : { status: 200, body: '{}' }]).http
        expect(runVendorClaims('fortinet', claimRoutes('fortinet'), claimStore, transport, 10)).toBe(2)
        expect(settled).toEqual([failedAll(['A'], 'HTTP 503'), [{ stepId: 'Z', ok: true, message: 'provisioned to FortiManager FMG-1' }]])
    })
})
