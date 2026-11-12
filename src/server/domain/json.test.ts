import { describe, expect, it } from 'vitest'
import { isoDate } from './json'

describe('isoDate', () => {
    it('reads calendar dates, timestamps and epoch seconds or milliseconds', () => {
        expect(isoDate('2026-11-07')).toBe('2026-11-07')
        expect(isoDate(' 2026-11-07T14:30:00Z ')).toBe('2026-11-07')
        expect(isoDate(Date.UTC(2026, 10, 7) / 1000)).toBe('2026-11-07')
        expect(isoDate(Date.UTC(2026, 10, 7, 12))).toBe('2026-11-07')
    })

    it('refuses days that do not exist, also as the date of a timestamp', () => {
        expect(isoDate('2024-02-29')).toBe('2024-02-29')
        expect(isoDate('2026-02-29')).toBeUndefined()
        expect(isoDate('2026-02-31')).toBeUndefined()
        expect(isoDate('2026-13-01')).toBeUndefined()
        expect(isoDate('2026-00-10T00:00:00Z')).toBeUndefined()
        expect(isoDate('2026-04-31T08:00:00+02:00')).toBeUndefined()
    })

    it('gives nothing for blanks, other formats and epochs past year 9999 instead of a mangled date or a throw', () => {
        expect(isoDate('')).toBeUndefined()
        expect(isoDate(null)).toBeUndefined()
        expect(isoDate('07/11/2026')).toBeUndefined()
        expect(isoDate(0)).toBeUndefined()
        expect(isoDate(253402300799)).toBe('9999-12-31')
        expect(isoDate(1e15)).toBeUndefined()
        expect(isoDate(1e17)).toBeUndefined()
    })
})
