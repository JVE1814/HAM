import { describe, expect, it } from 'vitest'
import { activeDays, monthBounds, overlapsMonth, previousMonth, prorate, subscriptionCharges, toCsv, type ChargeSources, type ServiceInterval } from './billing'

const nov = monthBounds('2026-11')
const feb = monthBounds('2028-02')

describe('monthBounds', () => {
    it('knows the first and last day and the length of a month', () => {
        expect(nov).toEqual({ month: '2026-11', first: '2026-11-01', last: '2026-11-30', days: 30 })
        expect(feb.days).toBe(29)
        expect(monthBounds('2026-12').last).toBe('2026-12-31')
    })
})

describe('overlapsMonth', () => {
    it('selects ranges starting by the month end and not ended before it began', () => {
        expect(overlapsMonth(nov)).toBe('start_date<=2026-11-30^end_dateISEMPTY^ORend_date>=2026-11-01')
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

const SITE_NAMES: { [siteId: string]: string } = { hq: 'Head office', store: 'Store 12' }

/** Sources with these Service intervals and the Site names above, counting the intervals reads. */
function sources(intervals: readonly ServiceInterval[] = []): ChargeSources & { intervalReads: number; siteReads: number } {
    return {
        intervalReads: 0,
        siteReads: 0,
        intervals() {
            this.intervalReads++
            return intervals
        },
        siteName(siteId) {
            this.siteReads++
            return SITE_NAMES[siteId] ?? ''
        },
    }
}

describe('subscriptionCharges', () => {
    const sitePackage = { lineType: 'site_package', monthlyRate: 4500, siteId: 'hq', description: 'Site package' }
    const perDevice = { lineType: 'device_class', monthlyRate: 45, siteId: '', description: 'Laptop' }

    it('charges a site package for the days it was active', () => {
        expect(subscriptionCharges({ ...sitePackage, start: '2026-11-16' }, nov, sources())).toEqual([
            { siteId: 'hq', description: 'Site package - Head office', units: 15, amount: 2250 },
        ])
        expect(subscriptionCharges({ ...sitePackage, start: '2026-12-01' }, nov, sources())).toEqual([])
        expect(subscriptionCharges({ ...sitePackage }, nov, sources())).toEqual([])
    })

    it('ends a site package on its end date', () => {
        expect(subscriptionCharges({ ...sitePackage, monthlyRate: 3000, start: '2026-01-01', end: '2026-11-10' }, nov, sources())).toEqual([
            { siteId: 'hq', description: 'Site package - Head office', units: 10, amount: 1000 },
        ])
    })

    it('never reads Service intervals for a site package', () => {
        const read = sources([{ siteId: 'store', start: '2026-11-01' }])
        subscriptionCharges({ ...sitePackage, start: '2026-11-16' }, nov, read)
        subscriptionCharges({ ...sitePackage, start: '2026-12-01' }, nov, read)
        expect(read.intervalReads).toBe(0)
    })

    it('charges a per-device line by device-days, per site', () => {
        const read = sources([
            { siteId: 'hq', start: '2026-02-01' },
            { siteId: 'hq', start: '2026-11-21' },
            { siteId: 'store', start: '2026-06-01', end: '2026-11-15' },
            { siteId: 'store', start: '2026-01-01', end: '2026-10-31' },
        ])
        expect(subscriptionCharges(perDevice, nov, read)).toEqual([
            { siteId: 'hq', description: 'Laptop - Head office', units: 40, amount: 60 },
            { siteId: 'store', description: 'Laptop - Store 12', units: 15, amount: 22.5 },
        ])
        expect(read.intervalReads).toBe(1)
    })

    it('lists Sites in order of first appearance and leaves out Sites without device-days', () => {
        const charges = subscriptionCharges(
            perDevice,
            nov,
            sources([
                { siteId: 'store', start: '2026-11-21' },
                { siteId: 'warehouse', start: '2026-01-01', end: '2026-10-31' },
                { siteId: 'hq', start: '2026-11-30' },
                { siteId: 'store', start: '2026-11-30' },
            ]),
        )
        expect(charges.map((charge) => [charge.siteId, charge.units])).toEqual([
            ['store', 11],
            ['hq', 1],
        ])
    })

    it('counts an interval shared by several assets once per asset', () => {
        const grouped = subscriptionCharges(
            perDevice,
            nov,
            sources([
                { siteId: 'hq', start: '2026-11-21', count: 3 },
                { siteId: 'store', start: '2026-06-01', end: '2026-11-15', count: 1 },
            ]),
        )
        expect(grouped).toEqual([
            { siteId: 'hq', description: 'Laptop - Head office', units: 30, amount: 45 },
            { siteId: 'store', description: 'Laptop - Store 12', units: 15, amount: 22.5 },
        ])
        const perAsset = subscriptionCharges(
            perDevice,
            nov,
            sources([
                { siteId: 'hq', start: '2026-11-21' },
                { siteId: 'hq', start: '2026-11-21' },
                { siteId: 'hq', start: '2026-11-21' },
                { siteId: 'store', start: '2026-06-01', end: '2026-11-15' },
            ]),
        )
        expect(grouped).toEqual(perAsset)
    })

    it('describes a charge by the line alone when its Site has no name', () => {
        expect(subscriptionCharges({ ...sitePackage, siteId: '', start: '2026-11-16' }, nov, sources())).toEqual([
            { siteId: '', description: 'Site package', units: 15, amount: 2250 },
        ])
        expect(subscriptionCharges(perDevice, nov, sources([{ siteId: 'unknown', start: '2026-11-21' }]))).toEqual([
            { siteId: 'unknown', description: 'Laptop', units: 10, amount: 15 },
        ])
    })

    it('bills nothing for an unknown line type, reading neither source', () => {
        const read = sources([{ siteId: 'hq', start: '2026-11-01' }])
        expect(subscriptionCharges({ ...perDevice, lineType: 'per_seat', siteId: 'hq', start: '2026-11-01' }, nov, read)).toEqual([])
        expect(read.intervalReads).toBe(0)
        expect(read.siteReads).toBe(0)
    })
})

describe('toCsv', () => {
    it('quotes fields that need it and ends rows with CRLF', () => {
        expect(toCsv([['customer', 'amount'], ['Acme, Inc.', 12.5], ['say "hi"', 0]])).toBe('customer,amount\r\n"Acme, Inc.",12.5\r\n"say ""hi""",0\r\n')
    })
})
