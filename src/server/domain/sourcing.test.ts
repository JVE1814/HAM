import { describe, expect, it } from 'vitest'
import { planSourcing, sparePoolShortfall, type StockCandidate } from './sourcing'

const stock: StockCandidate[] = [
    { assetId: 'central-1', modelId: 'c9300', stage: 'available', stockroomId: 'depot', stockroomType: 'central_depot', reservedFor: '' },
    { assetId: 'central-2', modelId: 'c9300', stage: 'available', stockroomId: 'depot', stockroomType: 'central_depot', reservedFor: '' },
    { assetId: 'pool-1', modelId: 'c9300', stage: 'spare_pool', stockroomId: 'depot', stockroomType: 'central_depot', reservedFor: 'acme' },
    { assetId: 'site-1', modelId: 'c9300', stage: 'spare_pool', stockroomId: 'acme-hq', stockroomType: 'customer_site', reservedFor: 'acme' },
    { assetId: 'other-pool', modelId: 'c9300', stage: 'spare_pool', stockroomId: 'depot', stockroomType: 'central_depot', reservedFor: 'globex' },
    { assetId: 'staging-1', modelId: 'c9300', stage: 'available', stockroomId: 'lab', stockroomType: 'staging_centre', reservedFor: '' },
    { assetId: 'ap-1', modelId: 'mr46', stage: 'available', stockroomId: 'depot', stockroomType: 'central_depot', reservedFor: '' },
]

describe('planSourcing', () => {
    it('serves new installs from the customer spare pool, then central stock, then purchase', () => {
        const plan = planSourcing({ modelId: 'c9300', quantity: 5, customerId: 'acme', purpose: 'new' }, stock)
        expect(plan.picks).toEqual([
            { assetId: 'pool-1', source: 'spare_pool' },
            { assetId: 'central-1', source: 'central_stock' },
            { assetId: 'central-2', source: 'central_stock' },
            { assetId: 'staging-1', source: 'central_stock' },
        ])
        expect(plan.toPurchase).toBe(1)
    })

    it('serves replacements from the hot spare at the customer site first', () => {
        const plan = planSourcing({ modelId: 'c9300', quantity: 2, customerId: 'acme', purpose: 'replace' }, stock)
        expect(plan.picks).toEqual([
            { assetId: 'site-1', source: 'customer_site_stock' },
            { assetId: 'pool-1', source: 'spare_pool' },
        ])
        expect(plan.toPurchase).toBe(0)
    })

    it("never takes another customer's spares or another model", () => {
        const plan = planSourcing({ modelId: 'mr46', quantity: 2, customerId: 'acme', purpose: 'new' }, stock)
        expect(plan.picks.map((p) => p.assetId)).toEqual(['ap-1'])
        expect(plan.toPurchase).toBe(1)
    })

    it('summarises where the line will come from', () => {
        const plan = planSourcing({ modelId: 'c9300', quantity: 5, customerId: 'acme', purpose: 'new' }, stock)
        expect(plan.summary).toBe('1 from spare pool, 3 from central stock, 1 to purchase')
    })
})

describe('sparePoolShortfall', () => {
    it('is the spares needed to reach the ratio of deployed assets, rounded up', () => {
        expect(sparePoolShortfall({ deployed: 41, reserved: 1, ratio: 0.05 })).toBe(2)
        expect(sparePoolShortfall({ deployed: 40, reserved: 5, ratio: 0.05 })).toBe(0)
        expect(sparePoolShortfall({ deployed: 0, reserved: 0, ratio: 0.05 })).toBe(0)
    })
})
