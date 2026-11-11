import { describe, expect, it } from 'vitest'
import { ALL_STAGES, type Stage } from './lifecycle'
import { reservedSparesQuery, sparePoolLead, sparePools, sparePoolShortfall } from './spare-pools'
import { recordMatches as matches } from '../test-support/encoded-query'
import { assetIn, type SampleRecord } from '../test-support/stored-asset'

const STOCKROOM_TYPE = 'stockroom.x_daas_ham_stockroom_type'
const LEASE_END = 'x_daas_ham_lease.end_action'
/** A fleet asset of Model m1 on no Order line, in a central depot unless `fields` say otherwise. */
const unit = (stage: Stage, fields: SampleRecord = {}) =>
    assetIn(stage, { x_daas_ham_fleet: 'true', model: 'm1', x_daas_ham_order_line: '', [STOCKROOM_TYPE]: 'central_depot', ...fields })
const PENDING_TRANSFER = { install_status: '6', substatus: 'pending_transfer' }
const IN_TRANSIT_RESERVED = { install_status: '9', substatus: 'reserved' }

describe('sparePools', () => {
    const share = (agreementId: string, modelId: string, deployed: number, ratio: number) => ({ agreementId, modelId, deployed, ratio })

    it('sizes one pool per Model at the ratio of deployed assets, rounded up', () => {
        expect(sparePools([share('a1', 'c9300', 41, 0.05)])).toEqual([{ modelId: 'c9300', size: 3, agreementId: 'a1' }])
        expect(sparePools([share('a1', 'c9300', 40, 0.05)])).toEqual([{ modelId: 'c9300', size: 2, agreementId: 'a1' }])
        expect(sparePools([share('a1', 'c9300', 0, 0.05)])).toEqual([{ modelId: 'c9300', size: 0, agreementId: 'a1' }])
    })

    it("sizes a Model's pool from the units of all the Customer's Agreements, each at its own ratio, rounded up once", () => {
        // 10 × 0.05 + 10 × 0.05 = 1 spare, not one rounded up for each Agreement.
        expect(sparePools([share('a1', 'c9300', 10, 0.05), share('a2', 'c9300', 10, 0.05)])).toEqual([{ modelId: 'c9300', size: 1, agreementId: 'a1' }])
        // 20 × 0.05 + 30 × 0.1 = 4.
        expect(sparePools([share('a1', 'c9300', 20, 0.05), share('a2', 'c9300', 30, 0.1)])).toEqual([{ modelId: 'c9300', size: 4, agreementId: 'a2' }])
        // 1 × 0.05 + 1 × 0.1 = 0.15: one spare.
        expect(sparePools([share('a1', 'mr46', 1, 0.05), share('a2', 'mr46', 1, 0.1)])[0].size).toBe(1)
    })

    it('keeps each Model in a pool of its own', () => {
        const pools = sparePools([share('a1', 'c9300', 20, 0.05), share('a1', 'mr46', 30, 0.05), share('a2', 'mr46', 10, 0.1)])
        expect(pools).toEqual([
            { modelId: 'c9300', size: 1, agreementId: 'a1' },
            { modelId: 'mr46', size: 3, agreementId: 'a1' },
        ])
    })

    it('files new spares under the Agreement with the largest share, the first by sys_id on a tie', () => {
        expect(sparePools([share('a1', 'c9300', 10, 0.05), share('a2', 'c9300', 30, 0.05)])[0].agreementId).toBe('a2')
        expect(sparePools([share('b', 'c9300', 10, 0.1), share('a', 'c9300', 20, 0.05)])[0].agreementId).toBe('a')
        expect(sparePools([share('a', 'c9300', 20, 0.05), share('b', 'c9300', 10, 0.1)])[0].agreementId).toBe('a')
    })
})

describe('sparePoolShortfall', () => {
    it('is the spares a pool still needs, never below none', () => {
        expect(sparePoolShortfall(3, 1)).toBe(2)
        expect(sparePoolShortfall(2, 5)).toBe(0)
        expect(sparePoolShortfall(0, 0)).toBe(0)
    })
})

describe('sparePoolLead', () => {
    it("is the first of the Customer's Agreements by sys_id, so one row of the pass tops up their pools", () => {
        expect(sparePoolLead(['b2', 'a9', 'c1'])).toBe('a9')
        expect(sparePoolLead(['a9'])).toBe('a9')
        expect(sparePoolLead([])).toBe('')
    })
})

describe('reservedSparesQuery', () => {
    const query = reservedSparesQuery('acme')
    const pooled = unit('spare_pool', { company: 'acme' })
    const inTransfer = [PENDING_TRANSFER, IN_TRANSIT_RESERVED].map((stored) => ({ ...pooled, ...stored }))

    it("counts the Customer's fleet assets in its Spare pool, whatever their Model, and no other Customer's or the Provider IT's", () => {
        expect(matches(query, pooled)).toBe(true)
        expect(matches(query, { ...pooled, model: 'm2' })).toBe(true)
        expect(matches(query, { ...pooled, company: 'globex' })).toBe(false)
        expect(matches(query, { ...pooled, company: '' })).toBe(false)
        expect(matches(query, { ...pooled, x_daas_ham_fleet: 'false' })).toBe(false)
        expect(matches(query, { ...pooled, x_daas_ham_fleet: '' })).toBe(false)
    })

    it("counts the Customer's units in transfer on no Order line, which go back to the pool, in both of Inventory's combinations", () => {
        for (const spare of inTransfer) {
            expect(matches(query, spare), spare.substatus).toBe(true)
            expect(matches(query, { ...spare, company: 'globex' }), spare.substatus).toBe(false)
            expect(matches(query, { ...spare, x_daas_ham_fleet: 'false' }), spare.substatus).toBe(false)
        }
    })

    it('counts no unit of the Customer in any other stage', () => {
        expect(ALL_STAGES.filter((stage) => matches(query, { ...pooled, ...assetIn(stage) }))).toEqual(['spare_pool', 'in_transfer'])
    })

    it('leaves out a unit in transfer on an Order line: sourcing moves it to staging for that line', () => {
        for (const spare of inTransfer) expect(matches(query, { ...spare, x_daas_ham_order_line: 'line1' }), spare.substatus).toBe(false)
        // A unit still in the pool on an Order line (a hot spare a replacement takes at Ship) is counted until it leaves.
        expect(matches(query, { ...pooled, x_daas_ham_order_line: 'line1' })).toBe(true)
    })

    it('leaves out the units bound for their Lessor, as sourcing does, and keeps those of any other lease', () => {
        for (const spare of [pooled, ...inTransfer]) {
            expect(matches(query, { ...spare, [LEASE_END]: 'return' }), spare.substatus).toBe(false)
            for (const endAction of ['undecided', 'extend', 'buyout']) expect(matches(query, { ...spare, [LEASE_END]: endAction }), spare.substatus).toBe(true)
        }
    })
})
