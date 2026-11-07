import { describe, expect, it } from 'vitest'
import { attestationDue, compareAudit } from './audit'

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
