import { describe, expect, it } from 'vitest'
import { ALL_STAGES, type Stage } from './lifecycle'
import { allocationProblem, awaitsReceipt, pickProblem, putAwayProblem, receivingProblem } from './warehouse'
import type { StockroomType } from './vocabulary'

describe('awaitsReceipt', () => {
    it('accepts units bought but not yet in stock', () => {
        expect(awaitsReceipt('in_transit')).toBe(true)
        expect(awaitsReceipt('on_order')).toBe(true)
    })

    it('refuses every other stage, including stock already received and allocated or returning units', () => {
        const others = ALL_STAGES.filter((stage) => stage !== 'in_transit' && stage !== 'on_order')
        expect(others.filter(awaitsReceipt)).toEqual([])
        expect(awaitsReceipt(null)).toBe(false)
    })
})

describe('receivingProblem', () => {
    it('receives arriving units into central depots and staging centres', () => {
        expect(receivingProblem('central_depot')).toBeNull()
        expect(receivingProblem('staging_centre')).toBeNull()
    })

    it("refuses a customer-site stockroom, which holds that Customer's own stock, saying where units go", () => {
        expect(receivingProblem('customer_site')).toBe('Receive into a central depot or a staging centre')
    })
})

describe('allocationProblem', () => {
    const waiting = { stage: 'awaiting_stock', orderStage: 'preparing', quantity: 2, allocated: 1 } as const

    it('gives the unit to a line still awaiting stock with room for it', () => {
        expect(allocationProblem(waiting)).toBeNull()
        expect(allocationProblem({ ...waiting, allocated: 0 })).toBeNull()
    })

    it('gives it on any live Order', () => {
        for (const orderStage of ['sourcing', 'preparing', 'delivering', 'installing']) {
            expect(allocationProblem({ ...waiting, orderStage })).toBeNull()
        }
    })

    it('leaves the unit free on a line still awaiting stock whose Order is cancelled or rejected (saved before its lines; a refused line cancel)', () => {
        expect(allocationProblem({ ...waiting, orderStage: 'cancelled' })).toBe('its Order is cancelled')
        expect(allocationProblem({ ...waiting, orderStage: 'rejected', allocated: 0 })).toBe('its Order is rejected')
    })

    it('names the ended Order before the line', () => {
        expect(allocationProblem({ ...waiting, stage: 'cancelled', orderStage: 'cancelled' })).toBe('its Order is cancelled')
    })

    it('leaves the unit free once the line has all its units, as when two receipts raced for its last one', () => {
        expect(allocationProblem({ ...waiting, allocated: 2 })).toBe('it already has all 2 unit(s)')
        expect(allocationProblem({ ...waiting, quantity: 1, allocated: 3 })).toBe('it already has all 1 unit(s)')
    })

    it('leaves the unit free once the line has moved on, whatever room it shows', () => {
        expect(allocationProblem({ ...waiting, stage: 'sourced' })).toBe('it is no longer awaiting stock (sourced)')
        const cancelled = allocationProblem({ ...waiting, stage: 'cancelled', allocated: 0 })
        expect(cancelled).toBe('it is no longer awaiting stock (cancelled)')
        expect(allocationProblem({ ...waiting, stage: '' })).toBe('it is no longer awaiting stock (unknown stage)')
    })
})

describe('putAwayProblem', () => {
    const TYPES: readonly StockroomType[] = ['central_depot', 'staging_centre', 'customer_site']
    const movableInto = (into: StockroomType) => ALL_STAGES.filter((stage) => putAwayProblem(stage, into) === null)

    it.each([
        ['central_depot', ['available', 'pending_evaluation', 'pending_wipe', 'pending_disposal']],
        ['customer_site', ['available', 'pending_evaluation', 'pending_wipe', 'pending_disposal']],
        ['staging_centre', ['available', 'staging', 'pending_evaluation', 'pending_wipe', 'pending_disposal']],
    ] as Array<[StockroomType, Stage[]]>)('into a %s moves free stock and returned units, and units being staged only into a staging centre', (into, movable) => {
        expect(movableInto(into)).toEqual(movable)
    })

    it('keeps a unit being staged out of any other Stockroom, saying where it goes', () => {
        expect(putAwayProblem('staging', 'central_depot')).toBe('A unit being staged is put away in a staging centre')
    })

    it('never moves Assets allocated to an Order line or a Customer, or held for shipping', () => {
        for (const into of TYPES) {
            expect(putAwayProblem('reserved', into)).toBe('Cannot be put away (reserved)')
            expect(putAwayProblem('spare_pool', into)).toBe('Cannot be put away (spare_pool)')
            expect(putAwayProblem('staged', into)).toBe('Cannot be put away (staged)')
            expect(putAwayProblem(null, into)).toBe('Cannot be put away (unknown stage)')
        }
    })
})

describe('pickProblem', () => {
    it('picks a staged unit of the Order being picked', () => {
        expect(pickProblem('ORD1', 'ORD1', 'staged')).toBeNull()
    })

    it('refuses a unit on no Order, or on another Order, naming that Order', () => {
        expect(pickProblem('', 'ORD1', 'staged')).toBe('Not allocated to an order')
        expect(pickProblem('', '', 'staged')).toBe('Not allocated to an order')
        expect(pickProblem('ORD2', 'ORD1', 'staged')).toBe('Belongs to ORD2')
    })

    it('refuses a unit of the Order in any stage but staged, naming its stage', () => {
        const others = ALL_STAGES.filter((stage) => stage !== 'staged')
        expect(others.filter((stage) => pickProblem('ORD1', 'ORD1', stage) === null)).toEqual([])
        expect(pickProblem('ORD1', 'ORD1', 'staging')).toBe('Not ready to ship (staging)')
    })
})
