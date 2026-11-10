import { describe, expect, it } from 'vitest'
import { attestationDue, closedLineResult, compareAudit, onTheShelfQuery } from './audit'
import { ALL_STAGES, type Stage } from './lifecycle'
import { recordMatches as matches } from '../test-support/encoded-query'
import { assetIn, type SampleRecord } from '../test-support/stored-asset'

describe('compareAudit', () => {
    const expected = [
        { assetId: 'a1', serial: 'FOC111', providerTag: 'NAAS-1', customerTag: '' },
        { assetId: 'a2', serial: 'FOC222', providerTag: 'NAAS-2', customerTag: 'ACME-9' },
        { assetId: 'a3', serial: 'FOC333', providerTag: '', customerTag: '' },
    ]

    it('matches scans by serial, provider tag or customer tag, case-insensitively', () => {
        const result = compareAudit(expected, ['foc111', 'ACME-9', 'XYZ', 'NAAS-1'])
        expect(result.matched).toEqual(['a1', 'a2'])
        expect(result.missing).toEqual(['a3'])
        expect(result.unexpected).toEqual(['XYZ'])
    })

    it('reports nothing missing when everything was scanned', () => {
        expect(compareAudit(expected, ['FOC111', 'FOC222', 'FOC333']).missing).toEqual([])
    })
})

describe('attestationDue', () => {
    it('is due when never attested or when the interval has passed', () => {
        expect(attestationDue({ lastAttestedOn: undefined, intervalMonths: 12, today: '2026-11-07' })).toBe(true)
        expect(attestationDue({ lastAttestedOn: '2025-11-07', intervalMonths: 12, today: '2026-11-07' })).toBe(true)
        expect(attestationDue({ lastAttestedOn: '2026-06-01', intervalMonths: 12, today: '2026-11-07' })).toBe(false)
    })

    it('is never due when the agreement asks for none', () => {
        expect(attestationDue({ lastAttestedOn: undefined, intervalMonths: 0, today: '2026-11-07' })).toBe(false)
    })
})

describe('closedLineResult', () => {
    const comparison = { matched: ['a1'], missing: ['a3'], unexpected: ['XYZ'] }

    it('marks a line of the expected list found or missing', () => {
        expect(closedLineResult({ assetId: 'a1', scannedCode: '' }, comparison)).toBe('found')
        expect(closedLineResult({ assetId: 'a3', scannedCode: '' }, comparison)).toBe('missing')
    })

    it('marks a scan that matched nothing unexpected, and leaves one that matched as it was recorded', () => {
        expect(closedLineResult({ assetId: '', scannedCode: 'XYZ' }, comparison)).toBe('unexpected')
        expect(closedLineResult({ assetId: '', scannedCode: 'FOC111' }, comparison)).toBeNull()
    })
})

describe('onTheShelfQuery', () => {
    const query = onTheShelfQuery('sr1')
    /** A fleet asset in stockroom sr1, in `stage`. */
    const unit = (stage: Stage, fields: SampleRecord = {}) => assetIn(stage, { x_daas_ham_fleet: 'true', stockroom: 'sr1', ...fields })
    const expected = (fields: SampleRecord = {}) => ALL_STAGES.filter((stage) => matches(query, unit(stage, fields)))

    it('expects the fleet assets In stock in the stockroom, whatever they wait for there, and no unit in another stage', () => {
        expect(expected()).toEqual(['available', 'reserved', 'spare_pool', 'staging', 'staged', 'in_transfer', 'pending_evaluation', 'pending_wipe', 'pending_disposal'])
    })

    it("expects no unit of another stockroom, and none of the Provider IT's (ADR 0016)", () => {
        expect(expected({ stockroom: 'sr2' })).toEqual([])
        expect(expected({ stockroom: '' })).toEqual([])
        expect(expected({ x_daas_ham_fleet: 'false' })).toEqual([])
        expect(expected({ x_daas_ham_fleet: '' })).toEqual([])
    })

    it('counts a unit pending transfer, still on the shelf it is sent from, and not one In transit, on no shelf', () => {
        expect(matches(query, { ...unit('in_transfer'), install_status: '6', substatus: 'pending_transfer' })).toBe(true)
        expect(matches(query, { ...unit('in_transfer'), install_status: '9', substatus: 'reserved' })).toBe(false)
    })
})
