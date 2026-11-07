import { describe, expect, it } from 'vitest'
import { annualSupportCost, coverageDisposition, coverageSummary, mergeCoverage } from './coverage'
import type { CoverageFact } from './oem/types'

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

describe('coverageDisposition', () => {
    const fact = (serial: string, contractNumber: string): CoverageFact => ({ serial, covered: true, contractNumber, serviceLevel: 'NBD', endDate: '2028-01-31' })

    it('applies the facts of each answered serial, matched after normalisation', () => {
        const dispositionOf = coverageDisposition({ facts: [fact(' foc1 ', 'C1'), fact('FOC1', 'C2'), fact('FOC2', 'C3')], errors: [], failed: [], rejected: [] })
        expect(dispositionOf('FOC1')).toEqual({ kind: 'apply', facts: [fact(' foc1 ', 'C1'), fact('FOC1', 'C2')] })
        expect(dispositionOf('foc2')).toEqual({ kind: 'apply', facts: [fact('FOC2', 'C3')] })
    })

    it('applies no facts to a serial the vendor answered without coverage', () => {
        expect(coverageDisposition({ facts: [], errors: [], failed: [], rejected: [] })('FOC3')).toEqual({ kind: 'apply', facts: [] })
    })

    it('only stamps a serial the vendor rejected, and skips one whose call failed', () => {
        const dispositionOf = coverageDisposition({ facts: [fact('FOC1', 'C1')], errors: ['some error'], failed: ['foc1'], rejected: ['foc2'] })
        // A failed call says nothing, even if the vendor gave a fact for the serial elsewhere.
        expect(dispositionOf('FOC1')).toEqual({ kind: 'skip' })
        expect(dispositionOf('FOC2')).toEqual({ kind: 'stamp' })
        // Errors on other serials do not hold back an answered one.
        expect(dispositionOf('FOC3')).toEqual({ kind: 'apply', facts: [] })
    })
})

describe('mergeCoverage', () => {
    it('keeps the stored start date when the answer has none (SN2INFO v2)', () => {
        expect(mergeCoverage({ startDate: '2024-01-01', endDate: '2027-06-30' }, { endDate: '2027-06-30' })).toEqual({
            startDate: '2024-01-01',
            endDate: '2027-06-30',
            resetExpiryNotified: false,
            annualCost: undefined,
        })
    })

    it('takes the answered dates, and clears an end date the answer no longer gives', () => {
        expect(mergeCoverage({ startDate: '2024-01-01', endDate: '2027-06-30' }, { startDate: '2025-01-01' })).toEqual({
            startDate: '2025-01-01',
            endDate: undefined,
            resetExpiryNotified: true,
            annualCost: undefined,
        })
    })

    it('sends the expiry warning afresh when the end date changes (a renewal), including on a new contract', () => {
        expect(mergeCoverage({ endDate: '2026-01-31' }, { endDate: '2029-01-31' }).resetExpiryNotified).toBe(true)
        expect(mergeCoverage({}, { endDate: '2029-01-31' }).resetExpiryNotified).toBe(true)
        expect(mergeCoverage({}, {}).resetExpiryNotified).toBe(false)
    })

    it('takes the annual cost only when the source gives one', () => {
        expect(mergeCoverage({}, { annualCost: 120 }).annualCost).toBe(120)
        expect(mergeCoverage({}, { annualCost: 0 }).annualCost).toBe(0)
        expect(mergeCoverage({}, {}).annualCost).toBeUndefined()
    })
})
