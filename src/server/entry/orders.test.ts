import type { GlideRecord } from '@servicenow/glide'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ROLE } from '../domain/roles.ts'
import { afterOrderProduced, beforeOrderProduced } from './orders.ts'
import { submitProducedOrder, type Submission } from '../platform/orders.ts'
import { platform, recordOf } from '../test-support/fake-glide.ts'

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)
vi.mock('../platform/orders.ts', async (original) => ({ ...(await original<typeof import('../platform/orders.ts')>()), submitProducedOrder: vi.fn() }))

function produce(submission: Submission): string[] {
    vi.mocked(submitProducedOrder).mockReturnValue(submission)
    platform.tables.x_daas_ham_order = [{ sys_id: 'order1', number: 'ORD0001' }]
    afterOrderProduced({ devices: '' }, recordOf<GlideRecord>('x_daas_ham_order', { sys_id: 'order1', number: 'ORD0001' }, { produced: true }))
    return platform.messages
}

beforeEach(() => platform.reset())

describe('afterOrderProduced', () => {
    it('tells a raiser whose Order is queued to be submitted again, who may have no Submit, that it is saved and not to raise it again', () => {
        expect(produce({ submitted: false, message: 'Order not submitted yet: busy', queued: true })).toEqual([
            'info Order ORD0001 is saved and is submitted within a few minutes: another order of the same agreement was being submitted at that moment. There is no need to raise it again',
        ])
    })

    it('tells the raiser why an Order not submitted stays a draft', () => {
        expect(produce({ submitted: false, message: 'Order not submitted. Set its Site.' })).toEqual(['error Order not submitted. Set its Site.'])
    })

    it('says nothing of an Order that went ahead', () => {
        expect(produce({ submitted: true })).toEqual([])
    })

})

describe('beforeOrderProduced', () => {
    const produce = () => {
        const current = recordOf<GlideRecord>('x_daas_ham_order', { customer: 'other' }, { fresh: true, produced: true })
        beforeOrderProduced({ devices: '' }, current)
        return current.insert()
    }

    it("refuses a Customer contact's request before its Order is inserted, as the insert rule would", () => {
        platform.user = { id: 'producing-admin', name: 'Ada', company: 'acme', roles: [ROLE.customerAdmin], interactive: true }
        expect(produce()).toBeNull()
        expect(platform.messages).toEqual(['error Order not raised. You can only order for your own customer.'])
        expect(platform.tables.x_daas_ham_order ?? []).toEqual([])
    })

    it('lets provider staff save a draft for any Customer, to correct', () => {
        platform.user = { id: 'producing-staff', name: 'Max', company: 'provider', roles: [ROLE.assetManager], interactive: true }
        expect(produce()).not.toBeNull()
        expect(platform.messages).toEqual([])
    })
})
