import type { GlideRecord } from '@servicenow/glide'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ROLE } from '../domain/roles.ts'
import { beforeReturnProduced } from './returns.ts'
import { platform, recordOf } from '../test-support/fake-glide.ts'

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

const RETURNS = 'x_daas_ham_return_order'

beforeEach(() => {
    platform.reset()
    platform.tables.cmn_location = [{ sys_id: 'site9', company: 'other', x_daas_ham_is_site: 'true' }]
})

describe('beforeReturnProduced', () => {
    const produce = () => {
        const current = recordOf<GlideRecord>(RETURNS, { customer: 'acme', site: 'site9' }, { fresh: true, produced: true })
        beforeReturnProduced({ assets: '' }, current)
        return current.insert()
    }

    it("refuses a Customer contact's request before its Return order is inserted, as the insert rule would", () => {
        platform.user = { id: 'producing-admin', name: 'Ada', company: 'acme', roles: [ROLE.customerAdmin], interactive: true }
        expect(produce()).toBeNull()
        expect(platform.messages).toEqual(["error Return not raised. The site is not one of the customer's sites."])
        expect(platform.tables[RETURNS] ?? []).toEqual([])
    })

    it('lets provider staff raise a Return for any Customer', () => {
        platform.user = { id: 'producing-staff', name: 'Max', company: 'provider', roles: [ROLE.assetManager], interactive: true }
        expect(produce()).not.toBeNull()
        expect(platform.messages).toEqual([])
    })
})
