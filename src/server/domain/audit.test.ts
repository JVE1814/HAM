import { describe, expect, it } from 'vitest'
import { attestationDue, closedLineResult, compareAudit, onTheShelfQuery } from './audit'
import { fleetCondition } from './fleet'

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
    const clauses = onTheShelfQuery('sr1').split('^NQ')

    it('keeps every stage to fleet assets In stock in the stockroom', () => {
        expect(clauses.length).toBeGreaterThan(1)
        for (const clause of clauses) {
            expect(clause).toContain('stockroom=sr1')
            expect(clause).toContain('install_status=6')
            expect(clause).toContain(fleetCondition())
        }
    })

    it('counts a unit pending transfer, still on the shelf it is sent from', () => {
        expect(clauses.some((clause) => clause.includes('substatus=pending_transfer'))).toBe(true)
    })
})
