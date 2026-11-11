import { describe, expect, it } from 'vitest'
import { activeDays, chooseCurrency, currencyCode, currencyKey, divideRounded, fromCents, isMonth, monthBounds, overlapsMonth, previousMonth, roundToCent, toCents } from './money'
import { recordMatches as matches } from '../test-support/encoded-query'

const nov = monthBounds('2026-11')
const feb = monthBounds('2028-02')

describe('monthBounds', () => {
    it('knows the first and last day and the length of a month', () => {
        expect(nov).toEqual({ month: '2026-11', first: '2026-11-01', last: '2026-11-30', days: 30 })
        expect(feb.days).toBe(29)
        expect(monthBounds('2026-12').last).toBe('2026-12-31')
    })

    it('refuses a value that is not a YYYY-MM month', () => {
        expect(() => monthBounds('')).toThrow("'' is not a YYYY-MM month")
        expect(() => monthBounds('2026-13')).toThrow("'2026-13' is not a YYYY-MM month")
        for (const bad of ['abc', '2026-00', '2026-3', '2026-11-01']) expect(() => monthBounds(bad)).toThrow('is not a YYYY-MM month')
    })
})

describe('isMonth', () => {
    it('accepts YYYY-MM months only', () => {
        expect(isMonth('2026-11')).toBe(true)
        expect(isMonth('2026-12')).toBe(true)
        for (const bad of ['', 'abc', '2026-13', '2026-00', '2026-3', '2026-11-01', ' 2026-11']) expect(isMonth(bad)).toBe(false)
    })
})

describe('overlapsMonth', () => {
    const overlaps = (start_date: string, end_date: string) => matches(overlapsMonth(nov), { start_date, end_date })

    it('selects ranges starting by the month end and not ended before it began', () => {
        expect(overlaps('2026-10-01', '')).toBe(true)
        expect(overlaps('2026-11-30', '')).toBe(true)
        expect(overlaps('2026-10-01', '2026-11-01')).toBe(true)
        expect(overlaps('2026-11-10', '2026-11-20')).toBe(true)
        expect(overlaps('2026-11-30', '2026-12-31')).toBe(true)
    })

    it('leaves out ranges that start after the month or ended before it', () => {
        expect(overlaps('2026-12-01', '')).toBe(false)
        expect(overlaps('2026-12-01', '2026-12-31')).toBe(false)
        expect(overlaps('2026-10-01', '2026-10-31')).toBe(false)
    })
})

describe('previousMonth', () => {
    it('steps back one calendar month, across years', () => {
        expect(previousMonth('2026-11-07')).toBe('2026-10')
        expect(previousMonth('2027-01-01')).toBe('2026-12')
    })
})

describe('activeDays', () => {
    it('counts inclusive days inside the month', () => {
        expect(activeDays(nov, '2026-11-10', '2026-11-19')).toBe(10)
        expect(activeDays(nov, '2026-11-30', '2026-11-30')).toBe(1)
    })

    it('clips to the month and runs open-ended intervals to its end', () => {
        expect(activeDays(nov, '2026-10-15')).toBe(30)
        expect(activeDays(nov, '2026-11-21')).toBe(10)
        expect(activeDays(nov, '2026-10-01', '2026-11-05')).toBe(5)
    })

    it('is zero outside the month or without a start', () => {
        expect(activeDays(nov, '2026-12-01')).toBe(0)
        expect(activeDays(nov, '2026-09-01', '2026-10-31')).toBe(0)
        expect(activeDays(nov, '')).toBe(0)
    })
})

describe('toCents', () => {
    it('rounds half a cent away from zero, ignoring the binary noise of a decimal amount', () => {
        expect(toCents(1.005)).toBe(101)
        expect(toCents(2.675)).toBe(268)
        expect(toCents(1200.555)).toBe(120056)
        expect(toCents(-1.005)).toBe(-101)
        expect(toCents(0.004)).toBe(0)
        expect(toCents(-0.004)).toBe(0)
        expect(toCents(Number.NaN)).toBe(0)
    })

    it('reads back as the amount to the cent', () => {
        expect(fromCents(toCents(0.1 + 0.2))).toBe(0.3)
        expect(roundToCent(1.005)).toBe(1.01)
    })
})

describe('divideRounded', () => {
    it('divides whole numbers rounding half away from zero, exactly', () => {
        expect(divideRounded(7, 2)).toBe(4)
        expect(divideRounded(5, 3)).toBe(2)
        expect(divideRounded(-7, 2)).toBe(-4)
        expect(divideRounded(7, -2)).toBe(-4)
        expect(divideRounded(0, 5)).toBe(0)
        // At a half, and one part in 2^53 under it.
        expect(divideRounded(2 ** 52, 2 ** 53)).toBe(1)
        expect(divideRounded(2 ** 52 - 1, 2 ** 53)).toBe(0)
    })
})

describe('currencyCode', () => {
    it('reads a three-letter code in any case, and nothing else', () => {
        expect(currencyCode(' eur ')).toBe('EUR')
        expect(currencyCode('USD')).toBe('USD')
        expect(currencyCode('')).toBe('')
        expect(currencyCode('EURO')).toBe('')
        expect(currencyCode('E1R')).toBe('')
    })
})

describe('currencyKey', () => {
    it('groups a stored currency by its code, and keeps a value that is no code apart, trimmed', () => {
        expect(currencyKey(' eur')).toBe('EUR')
        expect(currencyKey('USD')).toBe('USD')
        expect(currencyKey(' EU1 ')).toBe('EU1')
        expect(currencyKey('')).toBe('')
    })
})

describe('chooseCurrency', () => {
    const unread = (): string[] => {
        throw new Error('the Customer is not read for an amount naming an Agreement')
    }

    it("takes the Agreement's currency, never a default", () => {
        expect(chooseCurrency({ name: 'NAG0001001', currency: 'usd' }, unread)).toEqual({ currency: 'USD' })
        expect(chooseCurrency({ name: 'NAG0001001', currency: '' }, unread)).toEqual({
            problem: "its Agreement NAG0001001 has no currency: set the Agreement's currency",
        })
        expect(chooseCurrency({ name: 'NAG0001001', currency: 'Euro' }, unread)).toEqual({
            problem: "its Agreement NAG0001001 has 'Euro' as its currency, not a three-letter code: set the Agreement's currency",
        })
    })

    it('takes the currency every Agreement of the Customer has, for an amount naming none', () => {
        expect(chooseCurrency(null, () => ['EUR'])).toEqual({ currency: 'EUR' })
        expect(chooseCurrency(null, () => ['eur', 'EUR'])).toEqual({ currency: 'EUR' })
        expect(chooseCurrency(null, () => ['USD', 'EUR'])).toEqual({
            problem: "it names no Agreement, and its Customer's Agreements are in EUR, USD: set its Agreement",
        })
        expect(chooseCurrency(null, () => ['EUR', ''])).toEqual({
            problem: "it names no Agreement, and its Customer's Agreements are in no currency, EUR: set its Agreement",
        })
        expect(chooseCurrency(null, () => [''])).toEqual({
            problem: "it names no Agreement, and its Customer's Agreements are in no currency: set its Agreement",
        })
        expect(chooseCurrency(null, () => [])).toEqual({ problem: "it names no Agreement, and its Customer's Agreements are in none: set its Agreement" })
    })
})
