import { describe, expect, it } from 'vitest'
import { lifecyclePhaseOn, refreshDueDate } from './model-lifecycle'

const cisco = {
    endOfSale: '2024-04-30',
    endOfSupport: '2029-04-30',
    endOfExtendedSupport: undefined,
    endOfLife: '2029-04-30',
}

describe('lifecyclePhaseOn', () => {
    it('is available before any milestone', () => {
        expect(lifecyclePhaseOn(cisco, '2024-01-01')).toBe('available')
    })

    it('is the latest milestone reached on the given day', () => {
        expect(lifecyclePhaseOn(cisco, '2024-04-30')).toBe('end_of_sale')
        expect(lifecyclePhaseOn(cisco, '2030-01-01')).toBe('end_of_life')
    })

    it('treats a model without milestones as available', () => {
        expect(lifecyclePhaseOn({}, '2030-01-01')).toBe('available')
    })
})

describe('refreshDueDate', () => {
    it('adds the refresh cycle to the in-service date', () => {
        expect(refreshDueDate({ basis: 'cycle', inServiceDate: '2026-03-31', refreshCycleMonths: 36 })).toBe('2029-03-31')
    })

    it('uses end of support when the agreement refreshes on support', () => {
        expect(refreshDueDate({ basis: 'end_of_support', inServiceDate: '2026-03-31', refreshCycleMonths: 36, endOfSupport: '2028-01-31' })).toBe('2028-01-31')
    })

    it('takes whichever comes first', () => {
        expect(refreshDueDate({ basis: 'earliest', inServiceDate: '2026-03-31', refreshCycleMonths: 36, endOfSupport: '2030-01-31' })).toBe('2029-03-31')
        expect(refreshDueDate({ basis: 'earliest', inServiceDate: '2026-03-31', refreshCycleMonths: 36, endOfSupport: '2028-01-31' })).toBe('2028-01-31')
    })

    it('has no due date for an asset not yet in service or without the needed data', () => {
        expect(refreshDueDate({ basis: 'cycle', refreshCycleMonths: 36 })).toBeNull()
        expect(refreshDueDate({ basis: 'end_of_support', inServiceDate: '2026-03-31', refreshCycleMonths: 36 })).toBeNull()
        expect(refreshDueDate({ basis: 'cycle', inServiceDate: '2026-03-31', refreshCycleMonths: 0 })).toBeNull()
    })
})
