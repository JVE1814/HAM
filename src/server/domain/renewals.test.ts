import { describe, expect, it } from 'vitest'
import { recoversAgainAt, renewedEnd } from './renewals'

describe('recoversAgainAt', () => {
    it('recovers the equipment again when the Agreement now ends today or later', () => {
        expect(recoversAgainAt('2026-11-09', '2026-11-09')).toBe(true)
        expect(recoversAgainAt('2027-01-31', '2026-11-09')).toBe(true)
    })

    it('does not when the end only moved to another past day, or was cleared', () => {
        expect(recoversAgainAt('2026-11-08', '2026-11-09')).toBe(false)
        expect(recoversAgainAt('', '2026-11-09')).toBe(false)
    })
})

describe('renewedEnd', () => {
    it('adds the renewal term (at least one month)', () => {
        expect(renewedEnd('2026-12-31', 12)).toBe('2027-12-31')
        expect(renewedEnd('2026-12-31', 0)).toBe('2027-01-31')
        expect(renewedEnd('2026-11-15', 3)).toBe('2027-02-15')
    })

    it('keeps a month-end end at month end, so a day clamped in a short month is not lost', () => {
        expect(renewedEnd('2026-11-30', 3)).toBe('2027-02-28')
        expect(renewedEnd('2027-02-28', 3)).toBe('2027-05-31')
        expect(renewedEnd('2027-02-28', 12)).toBe('2028-02-29')
        expect(renewedEnd('2026-09-30', 3)).toBe('2026-12-31')
        expect(renewedEnd('2027-04-30', 1)).toBe('2027-05-31')
    })

    it('clamps an end past the last day of a shorter month, as before', () => {
        expect(renewedEnd('2027-01-30', 1)).toBe('2027-02-28')
    })
})
