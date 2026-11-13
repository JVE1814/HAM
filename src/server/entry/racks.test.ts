import type { RESTAPIRequest, RESTAPIResponse } from '@servicenow/glide/sn_ws_int'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ROLE } from '../domain/roles.ts'
import { getRack, listRacks, listSites } from './racks.ts'
import { platform } from '../test-support/fake-glide.ts'

/*
 * The rack routes on the in-memory stand-in for the platform, as a Customer admin calls them. Who may see which Site
 * and rack is tested in platform/racks.test.ts: these tests cover what the routes add, the role guard and the 404 that
 * hides another Customer's Site or rack.
 */

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

type Handler = (request: RESTAPIRequest, response: RESTAPIResponse) => void

/** The platform passes each query parameter as an array. */
function get(handler: Handler, params: { query?: Record<string, string[]>; path?: Record<string, string> } = {}): { status: number; body: unknown } {
    const reply = { status: 0, body: null as unknown }
    const request = { pathParams: params.path ?? {}, queryParams: params.query ?? {} } as unknown as RESTAPIRequest
    const response = {
        setStatus: (status: number) => void (reply.status = status),
        setBody: (body: unknown) => void (reply.body = body),
    } as unknown as RESTAPIResponse
    handler(request, response)
    return reply
}

let users = 0

/** Each is a new user: the session module keeps a user's scope and Customer for as long as it is loaded. */
function signIn(roles: string[]): void {
    platform.user = { id: `caller${++users}.`, name: '', company: 'acme', roles, interactive: true }
}

beforeEach(() => {
    platform.reset()
    platform.references = {
        'cmn_location.company': 'core_company',
        'cmn_location.parent': 'cmn_location',
        'cmdb_ci_rack.location': 'cmn_location',
    }
    platform.tables.core_company = [
        { sys_id: 'acme', name: 'Acme' },
        { sys_id: 'globex', name: 'Globex' },
    ]
    platform.tables.cmn_location = [
        { sys_id: 'acme-hq', name: 'Acme HQ', company: 'acme', x_daas_ham_is_site: 'true' },
        { sys_id: 'globex-hq', name: 'Globex HQ', company: 'globex', x_daas_ham_is_site: 'true' },
    ]
    platform.tables.cmdb_ci_rack = [
        { sys_id: 'rack-hq', name: 'HQ-1', location: 'acme-hq' },
        { sys_id: 'rack-globex', name: 'GX-1', location: 'globex-hq' },
    ]
    platform.tables.alm_hardware = []
    signIn([ROLE.customerAdmin])
})

describe('GET /sites', () => {
    it("answers a Customer admin their Customer's Sites", () => {
        expect(get(listSites)).toEqual({ status: 200, body: { sites: [{ id: 'acme-hq', name: 'Acme HQ', customer: 'Acme' }] } })
    })
})

describe('GET /racks?site=', () => {
    const racksAt = (siteId: string) => get(listRacks, { query: { site: [siteId] } })

    it("answers the racks at a Site of the caller's Customer", () => {
        expect(racksAt('acme-hq')).toEqual({ status: 200, body: { racks: [{ id: 'rack-hq', name: 'HQ-1', room: 'Acme HQ' }] } })
    })

    it("answers 404 for another Customer's Site, as for a Site that does not exist", () => {
        expect(racksAt('globex-hq')).toEqual({ status: 404, body: { error: 'No such site' } })
        expect(racksAt('nowhere')).toEqual({ status: 404, body: { error: 'No such site' } })
    })

    it('answers 404 when no Site is named', () => {
        expect(get(listRacks)).toEqual({ status: 404, body: { error: 'No such site' } })
    })
})

describe('GET /racks/{id}', () => {
    const rack = (rackId: string) => get(getRack, { path: { id: rackId } })

    it("answers the elevation of a rack at a Site of the caller's Customer", () => {
        expect(rack('rack-hq')).toEqual({
            status: 200,
            body: { rack: { id: 'rack-hq', name: 'HQ-1', units: 42, power: { capacityW: 0, usedW: 0, utilisation: null } }, devices: [] },
        })
    })

    it("answers 404 for another Customer's rack, as for a rack that does not exist", () => {
        expect(rack('rack-globex')).toEqual({ status: 404, body: { error: 'No such rack' } })
        expect(rack('no-such-rack')).toEqual({ status: 404, body: { error: 'No such rack' } })
    })
})

describe('a caller who holds no role of the app', () => {
    it.each([
        ['GET /sites', () => get(listSites)],
        ['GET /racks?site=', () => get(listRacks, { query: { site: ['acme-hq'] } })],
        ['GET /racks/{id}', () => get(getRack, { path: { id: 'rack-hq' } })],
    ])('is answered 403 by %s', (_route, call) => {
        signIn(['itil'])

        expect(call()).toEqual({ status: 403, body: { error: 'Requires a NaaS role' } })
    })
})
