import { describe, expect, it } from 'vitest'
import { annualSupportCost, coverageSummary } from './coverage'

describe('coverageSummary', () => {
    it('is covered until the latest end date among covering contracts', () => {
        expect(
            coverageSummary(
                [
                    { covered: true, endDate: '2027-06-30', serviceLevel: '8x5xNBD' },
                    { covered: true, endDate: '2028-01-31', serviceLevel: '24x7x4' },
                    { covered: false, endDate: '2030-01-01', serviceLevel: 'expired' },
                ],
                '2026-11-07',
            ),
        ).toEqual({ coveredToday: true, coverageEnd: '2028-01-31', serviceLevel: '24x7x4' })
    })

    it('is not covered once the latest contract has ended, but keeps its end date', () => {
        expect(coverageSummary([{ covered: true, endDate: '2026-01-31', serviceLevel: 'NBD' }], '2026-11-07')).toEqual({
            coveredToday: false,
            coverageEnd: '2026-01-31',
            serviceLevel: 'NBD',
        })
    })

    it('has no end without contracts', () => {
        expect(coverageSummary([], '2026-11-07')).toEqual({ coveredToday: false, coverageEnd: '', serviceLevel: '' })
    })
})

describe('annualSupportCost', () => {
    it('sums the contracts covering the asset today', () => {
        expect(
            annualSupportCost(
                [
                    { covered: true, endDate: '2027-06-30', serviceLevel: '8x5xNBD', annualCost: 120 },
                    { covered: true, serviceLevel: 'open-ended', annualCost: 30 },
                    { covered: true, endDate: '2026-01-31', serviceLevel: 'ended', annualCost: 500 },
                    { covered: false, endDate: '2030-01-01', serviceLevel: 'not covering', annualCost: 900 },
                    { covered: true, endDate: '2028-01-31', serviceLevel: 'no cost known' },
                ],
                '2026-11-07',
            ),
        ).toBe(150)
    })
})
