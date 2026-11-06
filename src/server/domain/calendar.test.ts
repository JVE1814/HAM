import { describe, expect, it } from 'vitest'
import { addDays, addMonths, daysBetween, earliest, isIsoDate, toIsoDate } from './calendar'

describe('calendar', () => {
    it('adds months and clamps to the end of shorter months', () => {
        expect(addMonths('2024-01-31', 1)).toBe('2024-02-29')
        expect(addMonths('2023-01-31', 1)).toBe('2023-02-28')
        expect(addMonths('2024-11-15', 60)).toBe('2029-11-15')
    })

    it('counts days between dates (end exclusive) and adds days', () => {
        expect(daysBetween('2026-01-01', '2026-02-01')).toBe(31)
        expect(addDays('2026-02-27', 2)).toBe('2026-03-01')
    })

    it('picks the earliest of optional dates', () => {
        expect(earliest(['2030-01-01', undefined, '2029-06-30'])).toBe('2029-06-30')
        expect(earliest([undefined, ''])).toBeUndefined()
    })

    it('recognises ISO calendar dates and converts instants', () => {
        expect(isIsoDate('2026-11-06')).toBe(true)
        expect(isIsoDate('06/11/2026')).toBe(false)
        expect(toIsoDate(Date.UTC(2026, 10, 6, 23, 59))).toBe('2026-11-06')
    })
})
