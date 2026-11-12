import type { RESTAPIRequest, RESTAPIResponse } from '@servicenow/glide/sn_ws_int'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PROPERTY } from '../domain/properties.ts'
import { MAX_TRACKING_EVENTS, WEBHOOK_TOKEN_MIN_LENGTH } from '../domain/shipping.ts'
import { postTrackingUpdate } from './shipping.ts'
import { platform } from '../test-support/fake-glide.ts'

/*
 * The tracking webhook on the in-memory stand-in for the platform, called as the aggregator calls it: without signing
 * in, so as guest, who holds no role.
 */

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

const TOKEN = 'webhook-secret-'.padEnd(WEBHOOK_TOKEN_MIN_LENGTH, 'x')

function post(token: string, events: object[] = []): { status: number; body: unknown } {
    const reply = { status: 0, body: null as unknown }
    const request = {
        body: { data: { data: { tracking_number: 'NOSUCH1', status_code: 'IT', events } } },
        pathParams: {},
        queryParams: {},
        getHeader: (name: string) => (name.toLowerCase() === 'x-naas-webhook-token' ? token : undefined),
    } as unknown as RESTAPIRequest
    const response = {
        setStatus: (status: number) => void (reply.status = status),
        setBody: (body: unknown) => void (reply.body = body),
    } as unknown as RESTAPIResponse
    postTrackingUpdate(request, response)
    return reply
}

beforeEach(() => {
    platform.reset()
    platform.user = { ...platform.user, id: 'guest', roles: [] }
    platform.properties = { [PROPERTY.shippingWebhookToken.name]: TOKEN }
})

describe('the tracking webhook, called as guest', () => {
    it('takes an update sent with its token', () => {
        expect(post(TOKEN)).toEqual({ status: 200, body: { matched: false } })
    })

    it('refuses one sent with another token', () => {
        expect(post('guessed')).toEqual({ status: 401, body: { error: 'bad token' } })
    })

    it('refuses every token while the configured one is shorter than the minimum, and warns without quoting it', () => {
        const short = TOKEN.slice(0, WEBHOOK_TOKEN_MIN_LENGTH - 1)
        platform.properties = { [PROPERTY.shippingWebhookToken.name]: short }
        expect(post(short)).toEqual({ status: 401, body: { error: 'bad token' } })
        expect(platform.warnings).toEqual([
            expect.stringContaining(`${PROPERTY.shippingWebhookToken.name} is shorter than ${WEBHOOK_TOKEN_MIN_LENGTH} characters`),
        ])
        expect(platform.logs.join('\n')).not.toContain(short)
    })

    it('logs nothing for a wrong token, or while no token is configured', () => {
        expect(post('guessed').status).toBe(401)
        platform.properties = {}
        expect(post('').status).toBe(401)
        expect(post(TOKEN).status).toBe(401)
        expect(platform.logs).toEqual([])
    })

    it('takes the newest events of an update that lists more than the cap, and warns of the rest', () => {
        const events = Array.from({ length: MAX_TRACKING_EVENTS + 5 }, (_unused, minute) => ({
            occurred_at: new Date(Date.UTC(2026, 10, 6, 8, minute)).toISOString(),
            status_code: 'IT',
            description: `Scan ${minute}`,
        }))
        expect(post(TOKEN, events)).toEqual({ status: 200, body: { matched: false } })
        expect(platform.warnings).toEqual([expect.stringContaining(`5 of its ${MAX_TRACKING_EVENTS + 5} events left out`)])
    })
})
