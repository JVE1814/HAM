import { describe, expect, it } from 'vitest'
import { coverageSummary } from './coverage'

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
