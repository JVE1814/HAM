import { describe, expect, it } from 'vitest'
import { planSourcing, type SourcingRequest, type StockCandidate } from './sourcing'

/*
 * planSourcing on a quantity that is no positive whole number of units (kept apart from sourcing.test.ts, whose
 * spare-pool tests change separately).
 */

const stock: StockCandidate[] = [
    { assetId: 'central-1', modelId: 'c9300', stockroomId: 'depot', source: 'central_stock' },
    { assetId: 'central-2', modelId: 'c9300', stockroomId: 'depot', source: 'central_stock' },
    { assetId: 'pool-1', modelId: 'c9300', stockroomId: 'depot', source: 'spare_pool' },
]

const request = (quantity: number): SourcingRequest => ({ modelId: 'c9300', quantity, customerId: 'acme', siteId: 'hq', purpose: 'new' })

describe('planSourcing with a quantity of no units', () => {
    it.each([0, -1, -5, Number.NaN, Number.NEGATIVE_INFINITY])('takes no stock and buys nothing for a quantity of %s', (quantity) => {
        expect(planSourcing(request(quantity), stock)).toEqual({ picks: [], toPurchase: 0, summary: '' })
    })

    it('takes no more than the whole units of a fractional quantity', () => {
        const plan = planSourcing(request(2.5), stock)
        expect(plan.picks.map((pick) => pick.assetId)).toEqual(['pool-1', 'central-1'])
        expect(plan.toPurchase).toBe(0)
    })

    it('still takes every unit there is and buys the rest for a positive quantity', () => {
        const plan = planSourcing(request(4), stock)
        expect(plan.picks).toHaveLength(3)
        expect(plan.toPurchase).toBe(1)
        expect(plan.summary).toBe('1 from spare pool, 2 from central stock, 1 to purchase')
    })
})
