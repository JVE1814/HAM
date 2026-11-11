import type { RESTAPIRequest, RESTAPIResponse } from '@servicenow/glide/sn_ws_int'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PROPERTY } from '../platform/properties.ts'
import { postTrackingUpdate } from './shipping.ts'
import { platform } from '../test-support/fake-glide.ts'

/*
 * The tracking webhook on the in-memory stand-in for the platform, called as the aggregator calls it: without signing
 * in, so as guest, who holds no role.
 */

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

const TOKEN = 'webhook-secret'

function post(token: string): { status: number; body: unknown } {
    const reply = { status: 0, body: null as unknown }
    const request = {
        body: { data: { data: { tracking_number: 'NOSUCH1', status_code: 'IT', events: [] } } },
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
})
