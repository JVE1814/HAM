import { describe, expect, it } from 'vitest'
import type { Stage } from './lifecycle'
import { cancelledUnit, freeStockQuery, isClaimable, isFree, putBackUnit, type StockUnit } from './stock'
import { recordMatches as matches } from '../test-support/encoded-query'
import { assetIn, type SampleRecord } from '../test-support/stored-asset'

describe('isFree and isClaimable', () => {
    const unit: StockUnit = { stage: 'available', orderLineId: '', leaseEndAction: '' }
    const inStock = ['available', 'spare_pool'] as const

    it('takes stock still in one of the stages and on no Order line', () => {
        expect(isClaimable(unit, inStock)).toBe(true)
        expect(isClaimable({ ...unit, stage: 'spare_pool', leaseEndAction: 'undecided' }, inStock)).toBe(true)
        expect(isFree({ ...unit, stage: 'reserved' }, inStock)).toBe(false)
        expect(isFree({ ...unit, stage: null }, inStock)).toBe(false)
        expect(isFree({ ...unit, orderLineId: 'line-1' }, inStock)).toBe(false)
    })

    it('never claims stock of a lease being returned to its Lessor, though it is free', () => {
        const returning: StockUnit = { ...unit, leaseEndAction: 'return' }
        expect(isFree(returning, inStock)).toBe(true)
        expect(isClaimable(returning, inStock)).toBe(false)
        for (const leaseEndAction of ['undecided', 'extend', 'buyout'] as const) {
            expect(isClaimable({ ...unit, leaseEndAction }, inStock)).toBe(true)
        }
    })
})

const STOCKROOM_TYPE = 'stockroom.x_daas_ham_stockroom_type'
const LEASE_END = 'x_daas_ham_lease.end_action'
const unit = (stage: Stage, fields: SampleRecord = {}) =>
    assetIn(stage, { x_daas_ham_fleet: 'true', model: 'm1', x_daas_ham_order_line: '', [STOCKROOM_TYPE]: 'central_depot', ...fields })

describe('freeStockQuery', () => {
    const free = unit('available')
    const acmeSpare = unit('spare_pool', { company: 'acme', [STOCKROOM_TYPE]: 'staging_centre' })

    it("finds the Provider's free stock of the Model only, as the spare-pool top-up takes it", () => {
        expect(matches(freeStockQuery('m1'), free)).toBe(true)
        expect(matches(freeStockQuery('m1'), { ...free, model: 'm2' })).toBe(false)
        expect(matches(freeStockQuery('m1'), acmeSpare)).toBe(false)
        expect(matches(freeStockQuery('m1'), { ...acmeSpare, company: '' })).toBe(false)
        expect(matches(freeStockQuery('m1'), { ...free, [LEASE_END]: 'return' })).toBe(false)
    })
})

describe('cancelledUnit', () => {
    it('leaves a hot spare in its Spare pool, still its Customer\'s', () => {
        expect(cancelledUnit('spare_pool')).toEqual({ keeps: 'customer', to: null })
    })

    it('gives a unit in transfer back to the Provider where it is, to be free stock once Inventory lets it go', () => {
        expect(cancelledUnit('in_transfer')).toEqual({ keeps: 'provider', to: null })
    })

    it('makes any other unit free stock', () => {
        for (const stage of ['reserved', 'staging', 'staged', 'available', null] as const) expect(cancelledUnit(stage)).toEqual({ keeps: 'provider', to: 'available' })
    })
})

describe('putBackUnit', () => {
    it('puts a spare back in its Spare pool and any other stock back as free stock', () => {
        expect(putBackUnit('spare_pool')).toEqual({ keeps: 'customer', to: 'spare_pool' })
        for (const source of ['central_stock', 'customer_site_stock'] as const) expect(putBackUnit(source)).toEqual({ keeps: 'provider', to: 'available' })
    })
})
