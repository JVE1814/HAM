import { describe, expect, it } from 'vitest'
import { activeDays, monthBounds, previousMonth, prorate, subscriptionCharges, toCsv } from './billing'

const nov = monthBounds('2026-11')
const feb = monthBounds('2028-02')

describe('monthBounds', () => {
    it('knows the first and last day and the length of a month', () => {
        expect(nov).toEqual({ month: '2026-11', first: '2026-11-01', last: '2026-11-30', days: 30 })
        expect(feb.days).toBe(29)
        expect(monthBounds('2026-12').last).toBe('2026-12-31')
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

describe('prorate', () => {
    it('charges the share of the month, to the cent', () => {
        expect(prorate(45, 30, 30)).toBe(45)
        expect(prorate(45, 10, 30)).toBe(15)
        expect(prorate(100, 1, 31)).toBe(3.23)
    })
})

describe('subscriptionCharges', () => {
    it('charges a site package for the days it was active', () => {
        expect(
            subscriptionCharges({ lineType: 'site_package', monthlyRate: 4500, siteId: 'hq', start: '2026-11-16' }, [], nov),
        ).toEqual([{ siteId: 'hq', units: 15, amount: 2250 }])
        expect(subscriptionCharges({ lineType: 'site_package', monthlyRate: 4500, siteId: 'hq', start: '2026-12-01' }, [], nov)).toEqual([])
    })

    it('ends a site package on its end date', () => {
        expect(
            subscriptionCharges({ lineType: 'site_package', monthlyRate: 3000, siteId: 'hq', start: '2026-01-01', end: '2026-11-10' }, [], nov),
        ).toEqual([{ siteId: 'hq', units: 10, amount: 1000 }])
    })

    it('charges a per-device line by device-days, per site', () => {
        const charges = subscriptionCharges(
            { lineType: 'device_class', monthlyRate: 45, siteId: '' },
            [
                { siteId: 'hq', start: '2026-02-01' },
                { siteId: 'hq', start: '2026-11-21' },
                { siteId: 'store', start: '2026-06-01', end: '2026-11-15' },
                { siteId: 'store', start: '2026-01-01', end: '2026-10-31' },
            ],
            nov,
        )
        expect(charges).toEqual([
            { siteId: 'hq', units: 40, amount: 60 },
            { siteId: 'store', units: 15, amount: 22.5 },
        ])
    })
})

describe('toCsv', () => {
    it('quotes fields that need it and ends rows with CRLF', () => {
        expect(toCsv([['customer', 'amount'], ['Acme, Inc.', 12.5], ['say "hi"', 0]])).toBe('customer,amount\r\n"Acme, Inc.",12.5\r\n"say ""hi""",0\r\n')
    })
})
