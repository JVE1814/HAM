import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RESTAPIRequest, RESTAPIResponse } from '@servicenow/glide/sn_ws_int'
import { ROLE } from '../domain/roles.ts'
import { platform } from '../test-support/fake-glide.ts'
import { sessionRoles } from './session.ts'

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

function get(): { status: number; body: unknown } {
    const reply = { status: 0, body: null as unknown }
    const response = {
        setStatus: (status: number) => void (reply.status = status),
        setBody: (body: unknown) => void (reply.body = body),
    } as unknown as RESTAPIResponse
    sessionRoles({} as RESTAPIRequest, response)
    return reply
}

beforeEach(() => platform.reset())

describe('GET /me', () => {
    it("answers the app's roles the caller holds and no other role", () => {
        platform.user = { ...platform.user, roles: [ROLE.finance, ROLE.noc, 'itil'] }
        expect(get()).toEqual({ status: 200, body: { roles: [ROLE.noc, ROLE.finance] } })
    })

    it('answers no roles for a user who holds none of the app', () => {
        platform.user = { ...platform.user, roles: ['itil'] }
        expect(get()).toEqual({ status: 200, body: { roles: [] } })
    })
})
