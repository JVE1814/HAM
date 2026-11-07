import { describe, expect, it } from 'vitest'
import { ALL_STAGES, type Stage } from './lifecycle'
import type { StockroomType } from './sourcing'
import { awaitsReceipt, putAwayProblem, RECEIVING_STOCKROOM_TYPES, receivingProblem } from './warehouse'

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

    it('lists exactly the types it receives into, for the stockroom picker', () => {
        const TYPES: readonly StockroomType[] = ['central_depot', 'staging_centre', 'customer_site']
        expect(TYPES.filter((type) => receivingProblem(type) === null)).toEqual([...RECEIVING_STOCKROOM_TYPES])
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
