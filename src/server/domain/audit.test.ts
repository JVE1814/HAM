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

    it('matches a scan by serial before another unit\'s Provider or Customer tag', () => {
        const units = [
            { assetId: 'a1', serial: 'FOC111', providerTag: 'NAAS-1', customerTag: '' },
            { assetId: 'a2', serial: 'FOC222', providerTag: 'NAAS-2', customerTag: 'FOC111' },
        ]
        const result = compareAudit(units, ['FOC111', 'FOC222'])
        expect(result.matched).toEqual(['a1', 'a2'])
        expect(result.missing).toEqual([])
        expect(result.unexpected).toEqual([])
    })

    it('falls back to the Customer tag only when no serial or Provider tag carries the code', () => {
        const units = [
            { assetId: 'a1', serial: 'FOC111', providerTag: 'NAAS-1', customerTag: 'SW-01' },
            { assetId: 'a2', serial: 'FOC222', providerTag: 'SW-01', customerTag: '' },
        ]
        expect(compareAudit(units, ['sw-01']).matched).toEqual(['a2'])
    })

    it('leaves a code two units carry in the same field unresolved, as unexpected', () => {
        const units = [
            { assetId: 'a1', serial: 'FOC111', providerTag: 'NAAS-1', customerTag: 'SW-01' },
            { assetId: 'a2', serial: 'FOC222', providerTag: 'NAAS-2', customerTag: 'SW-01' },
        ]
        const result = compareAudit(units, ['SW-01', 'FOC222'])
        expect(result.matched).toEqual(['a2'])
        expect(result.missing).toEqual(['a1'])
        expect(result.unexpected).toEqual(['SW-01'])
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
