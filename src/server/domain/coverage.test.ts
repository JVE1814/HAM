import { describe, expect, it } from 'vitest'
import { annualSupportCost, answersByContract, contractKey, coverageBySerial, coverageDisposition, coverageSummary, mergeCoverage, staleCoverageQuery } from './coverage'
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
        })
    })

    it('takes the answered dates, and clears an end date the answer no longer gives', () => {
        expect(mergeCoverage({ startDate: '2024-01-01', endDate: '2027-06-30' }, { startDate: '2025-01-01' })).toEqual({
            startDate: '2025-01-01',
            endDate: undefined,
            resetExpiryNotified: true,
        })
    })

    it('sends the expiry warning afresh when the end date changes (a renewal), including on a new contract', () => {
        expect(mergeCoverage({ endDate: '2026-01-31' }, { endDate: '2029-01-31' }).resetExpiryNotified).toBe(true)
        expect(mergeCoverage({}, { endDate: '2029-01-31' }).resetExpiryNotified).toBe(true)
        expect(mergeCoverage({}, {}).resetExpiryNotified).toBe(false)
    })
})

describe('contractKey', () => {
    it('is the same for a serial and contract number differing only in case or surrounding spaces of the serial', () => {
        expect(contractKey(' foc1 ', 'Con-1')).toBe(contractKey('FOC1', 'CON-1'))
    })

    it('tells apart contracts of one serial, and one contract number on two serials', () => {
        expect(contractKey('FOC1', 'C1')).not.toBe(contractKey('FOC1', 'C2'))
        expect(contractKey('FOC1', 'C1')).not.toBe(contractKey('FOC2', 'C1'))
    })
})

describe('answersByContract', () => {
    const fact = (serial: string, contractNumber: string, endDate: string): CoverageFact => ({ serial, covered: true, contractNumber, serviceLevel: 'NBD', endDate })

    it('groups the answers for one serial and contract number, in answer order, apart from the others', () => {
        const first = { assetId: 'a1', fact: fact('foc1', 'c1', '2027-01-31') }
        const second = { assetId: 'a1', fact: fact('FOC1', 'C1', '2028-01-31') }
        const other = { assetId: 'a1', fact: fact('FOC1', 'C2', '2028-01-31') }
        const elsewhere = { assetId: 'a2', fact: fact('FOC2', 'C1', '2028-01-31'), annualCost: 120 }
        const grouped = answersByContract([first, other, second, elsewhere])
        expect([...grouped.values()]).toEqual([[first, second], [other], [elsewhere]])
        expect(grouped.get(contractKey('FOC1', 'C1'))).toEqual([first, second])
    })

    it('has no contracts without answers', () => {
        expect(answersByContract([]).size).toBe(0)
    })
})

describe('coverageBySerial', () => {
    const today = '2026-11-07'

    it('summarises each serial from the contracts with its serial after normalisation', () => {
        const coverage = coverageBySerial(
            ['FOC1', 'FOC2'],
            [
                { serial: 'foc1 ', covered: true, endDate: '2027-06-30', serviceLevel: '8x5xNBD', annualCost: 100 },
                { serial: 'FOC1', covered: true, endDate: '2028-01-31', serviceLevel: '24x7x4', annualCost: 50 },
                { serial: 'FOC2', covered: true, endDate: '2026-01-31', serviceLevel: 'NBD', annualCost: 500 },
            ],
            today,
        )
        expect(coverage.get('FOC1')).toEqual({ coveredToday: true, coverageEnd: '2028-01-31', serviceLevel: '24x7x4', supportCost: 150 })
        expect(coverage.get('FOC2')).toEqual({ coveredToday: false, coverageEnd: '2026-01-31', serviceLevel: 'NBD', supportCost: 0 })
    })

    it('gives an asked serial without contracts no coverage, so its Assets are cleared', () => {
        expect(coverageBySerial(['FOC3'], [{ serial: 'FOC1', covered: true, endDate: '2028-01-31', serviceLevel: 'NBD' }], today)).toEqual(
            new Map([['FOC3', { coveredToday: false, coverageEnd: '', serviceLevel: '', supportCost: 0 }]]),
        )
    })

    it('keys the coverage by normalised serial', () => {
        expect([...coverageBySerial([' foc1 '], [], today).keys()]).toEqual(['FOC1'])
    })
})

describe('staleCoverageQuery', () => {
    it("asks again for a vendor's fleet assets with a serial, not retired, never checked or checked before the cut-off", () => {
        expect(staleCoverageQuery('cisco', '2026-11-01 00:00:00').split('^')).toEqual([
            'x_daas_ham_fleet=true',
            'model.x_daas_ham_oem_source=cisco',
            'install_status!=7',
            'serial_numberISNOTEMPTY',
            'x_daas_ham_coverage_checkedISEMPTY',
            'ORx_daas_ham_coverage_checked<2026-11-01 00:00:00',
        ])
    })
})
