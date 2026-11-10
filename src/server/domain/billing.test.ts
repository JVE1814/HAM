import { describe, expect, it } from 'vitest'
import {
    activeDays,
    billingCsvHeader,
    billingCsvRow,
    billingLineJson,
    billingMonthProblem,
    billsFromIntervals,
    chooseCurrency,
    currencyCode,
    currencyTotals,
    decideGenerationReset,
    divideRounded,
    fromCents,
    IN_SERVICE_ON_ENDED_LINE,
    IN_SERVICE_UNBILLED,
    NO_LINE,
    ON_ENDED_LINE,
    intervalEnd,
    isMonth,
    monthBounds,
    overlapsMonth,
    previousMonth,
    prorate,
    RESET_AFTER_IDLE_MINUTES,
    resetGenerationError,
    restartInterval,
    roundToCent,
    singleCurrencyTotal,
    subscriptionCharges,
    toCents,
    toCsv,
    totalsText,
    withinLine,
    type BillingLineField,
    type ChargeSources,
    type ServiceInterval,
    type StoredBillingLine,
} from './billing'
import { fleetStagesQuery } from './fleet'
import { ALL_STAGES, IN_USE_STAGES, isBillable } from './lifecycle'

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

describe('billingMonthProblem', () => {
    it('accepts a YYYY-MM month that has ended', () => {
        expect(billingMonthProblem('2026-10', '2026-11-07')).toBeNull()
        expect(billingMonthProblem('2025-12', '2026-01-01')).toBeNull()
        expect(billingMonthProblem(previousMonth('2026-11-01'), '2026-11-01')).toBeNull()
    })

    it('refuses a month that is not YYYY-MM, giving the last month as the example', () => {
        expect(billingMonthProblem('2026-13', '2026-11-07')).toBe("'2026-13' is not a month: enter it as YYYY-MM (e.g. 2026-10)")
        for (const bad of ['', 'Nov 2026', '2026-11-01']) expect(billingMonthProblem(bad, '2026-11-07')).toContain('enter it as YYYY-MM')
    })

    it('refuses the current month, even on its last day, so it is not generated from part of the month', () => {
        expect(billingMonthProblem('2026-11', '2026-11-30')).toBe(
            '2026-11 has not ended yet: a period is generated as soon as it is created, so it can be created from 2026-12-01 (the monthly job opens it then)',
        )
        expect(billingMonthProblem('2026-12', '2026-12-01')).toContain('can be created from 2027-01-01')
    })

    it('refuses a month still to come', () => {
        expect(billingMonthProblem('2027-03', '2026-11-07')).toContain('2027-03 has not ended yet')
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

describe('intervalEnd', () => {
    it('ends a Service interval on the day it is closed', () => {
        expect(intervalEnd('2026-11-02', '2026-11-07')).toBe('2026-11-07')
        expect(intervalEnd('2026-11-07', '2026-11-07')).toBe('2026-11-07')
    })

    it('never ends one before it started', () => {
        expect(intervalEnd('2026-11-10', '2026-11-07')).toBe('2026-11-10')
    })
})

describe('prorate', () => {
    it('charges the share of the month, to the cent', () => {
        expect(prorate(45, 30, 30)).toBe(45)
        expect(prorate(45, 10, 30)).toBe(15)
        expect(prorate(100, 1, 31)).toBe(3.23)
    })

    it('rounds a charge of exactly half a cent up, which binary floats would round down', () => {
        // 0.29 x 14 / 28 = 0.145 and 0.7 x 3 / 28 = 0.075, yet (0.29 * 14 * 100) / 28 is 14.499999999999998 in floats.
        expect(prorate(0.29, 14, 28)).toBe(0.15)
        expect(prorate(0.7, 3, 28)).toBe(0.08)
        expect(prorate(10.05, 1, 2)).toBe(5.03)
        expect(prorate(-0.29, 14, 28)).toBe(-0.15)
    })

    it('stays exact for large rates and many device-days', () => {
        expect(prorate(123456.78, 31 * 400, 31)).toBe(49382712)
        expect(prorate(45, 0, 30)).toBe(0)
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

describe('currencyTotals', () => {
    it('totals lines per currency, in currency order, never adding two currencies', () => {
        expect(
            currencyTotals([
                { currency: 'USD', lines: 2, amount: 99 },
                { currency: 'EUR', lines: 3, amount: 1234.56 },
                { currency: 'eur', lines: 1, amount: 0.1 },
                { currency: 'EUR', lines: 1, amount: 0.2 },
            ]),
        ).toEqual([
            { currency: 'EUR', lines: 5, amount: 1234.86 },
            { currency: 'USD', lines: 2, amount: 99 },
        ])
        expect(currencyTotals([])).toEqual([])
    })

    it('keeps lines without a currency apart', () => {
        expect(currencyTotals([{ currency: '', lines: 1, amount: 100 }, { currency: 'EUR', lines: 1, amount: 5 }])).toEqual([
            { currency: '', lines: 1, amount: 100 },
            { currency: 'EUR', lines: 1, amount: 5 },
        ])
    })
})

describe('totalsText and singleCurrencyTotal', () => {
    const eur = { currency: 'EUR', lines: 3, amount: 1234.5 }
    const usd = { currency: 'USD', lines: 1, amount: -99 }

    it('shows each currency with its total to the cent', () => {
        expect(totalsText([eur, usd])).toBe('EUR 1234.50; USD -99.00')
        expect(totalsText([{ currency: '', lines: 1, amount: 100 }])).toBe('no currency 100.00')
        expect(totalsText([])).toBe('')
    })

    it('fits the Totals field', () => {
        const many = Array.from({ length: 30 }, (_, i) => ({ currency: `X${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`, lines: 1, amount: 1234567.89 }))
        const text = totalsText(many)
        expect(text).toHaveLength(255)
        expect(text.endsWith(' ...')).toBe(true)
    })

    it('gives a single Total only while the lines are in one currency', () => {
        expect(singleCurrencyTotal([eur])).toBe(1234.5)
        expect(singleCurrencyTotal([])).toBe(0)
        expect(singleCurrencyTotal([eur, usd])).toBeNull()
    })
})

const SITE_NAMES: { [siteId: string]: string } = { hq: 'Head office', store: 'Store 12' }

/** Sources with these Service intervals and the Site names above, counting the Site name reads. */
function sources(intervals: readonly ServiceInterval[] = []): ChargeSources & { siteReads: number } {
    return {
        intervals,
        siteReads: 0,
        siteName(siteId) {
            this.siteReads++
            return SITE_NAMES[siteId] ?? ''
        },
    }
}

describe('billsFromIntervals', () => {
    const terms = { monthlyRate: 45, siteId: '', description: 'Laptop' }

    it('bills only a per-device line from its Service intervals', () => {
        expect(billsFromIntervals({ ...terms, lineType: 'device_class' })).toBe(true)
        expect(billsFromIntervals({ ...terms, lineType: 'site_package' })).toBe(false)
        expect(billsFromIntervals({ ...terms, lineType: 'per_seat' })).toBe(false)
        expect(billsFromIntervals({ ...terms, lineType: '' })).toBe(false)
    })
})

describe('subscriptionCharges', () => {
    const sitePackage = { lineType: 'site_package', monthlyRate: 4500, currency: 'EUR', siteId: 'hq', description: 'Site package' }
    const perDevice = { lineType: 'device_class', monthlyRate: 45, currency: 'EUR', siteId: '', description: 'Laptop', start: '2026-01-01' }

    it('charges a site package for the days it was active', () => {
        expect(subscriptionCharges({ ...sitePackage, start: '2026-11-16' }, nov, sources())).toEqual([
            { siteId: 'hq', description: 'Site package - Head office', units: 15, amount: 2250, currency: 'EUR' },
        ])
        expect(subscriptionCharges({ ...sitePackage, start: '2026-12-01' }, nov, sources())).toEqual([])
        expect(subscriptionCharges({ ...sitePackage }, nov, sources())).toEqual([])
    })

    it('ends a site package on its end date', () => {
        expect(subscriptionCharges({ ...sitePackage, monthlyRate: 3000, start: '2026-01-01', end: '2026-11-10' }, nov, sources())).toEqual([
            { siteId: 'hq', description: 'Site package - Head office', units: 10, amount: 1000, currency: 'EUR' },
        ])
    })

    it('bills a site package by its own dates, whatever Service intervals it is given', () => {
        const read = sources([{ siteId: 'store', start: '2026-11-01' }])
        expect(subscriptionCharges({ ...sitePackage, start: '2026-11-16' }, nov, read)).toEqual([
            { siteId: 'hq', description: 'Site package - Head office', units: 15, amount: 2250, currency: 'EUR' },
        ])
        expect(subscriptionCharges({ ...sitePackage, start: '2026-12-01' }, nov, read)).toEqual([])
    })

    it('charges a per-device line by device-days, per site', () => {
        const read = sources([
            { siteId: 'hq', start: '2026-02-01' },
            { siteId: 'hq', start: '2026-11-21' },
            { siteId: 'store', start: '2026-06-01', end: '2026-11-15' },
            { siteId: 'store', start: '2026-01-01', end: '2026-10-31' },
        ])
        expect(subscriptionCharges(perDevice, nov, read)).toEqual([
            { siteId: 'hq', description: 'Laptop - Head office', units: 40, amount: 60, currency: 'EUR' },
            { siteId: 'store', description: 'Laptop - Store 12', units: 15, amount: 22.5, currency: 'EUR' },
        ])
    })

    it('bills nothing for a per-device line without Service intervals', () => {
        expect(subscriptionCharges(perDevice, nov, sources())).toEqual([])
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
            { siteId: 'hq', description: 'Laptop - Head office', units: 30, amount: 45, currency: 'EUR' },
            { siteId: 'store', description: 'Laptop - Store 12', units: 15, amount: 22.5, currency: 'EUR' },
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

    it("charges in the line's currency", () => {
        expect(subscriptionCharges({ ...sitePackage, currency: 'USD', start: '2026-11-16' }, nov, sources())).toEqual([
            { siteId: 'hq', description: 'Site package - Head office', units: 15, amount: 2250, currency: 'USD' },
        ])
    })

    it('describes a charge by the line alone when its Site has no name', () => {
        expect(subscriptionCharges({ ...sitePackage, siteId: '', start: '2026-11-16' }, nov, sources())).toEqual([
            { siteId: '', description: 'Site package', units: 15, amount: 2250, currency: 'EUR' },
        ])
        expect(subscriptionCharges(perDevice, nov, sources([{ siteId: 'unknown', start: '2026-11-21' }]))).toEqual([
            { siteId: 'unknown', description: 'Laptop', units: 10, amount: 15, currency: 'EUR' },
        ])
    })

    it('bills a per-device line only from its own start date', () => {
        const read = sources([
            { siteId: 'hq', start: '2026-02-01' },
            { siteId: 'store', start: '2026-11-20', end: '2026-11-25' },
        ])
        expect(subscriptionCharges({ ...perDevice, start: '2026-11-21' }, nov, read)).toEqual([
            { siteId: 'hq', description: 'Laptop - Head office', units: 10, amount: 15, currency: 'EUR' },
            { siteId: 'store', description: 'Laptop - Store 12', units: 5, amount: 7.5, currency: 'EUR' },
        ])
    })

    it('stops billing a per-device line on its end date, for units still in service too', () => {
        const read = sources([
            { siteId: 'hq', start: '2026-02-01', count: 2 },
            { siteId: 'hq', start: '2026-11-10', end: '2026-11-12' },
            { siteId: 'store', start: '2026-11-16' },
        ])
        expect(subscriptionCharges({ ...perDevice, end: '2026-11-15' }, nov, read)).toEqual([
            { siteId: 'hq', description: 'Laptop - Head office', units: 33, amount: 49.5, currency: 'EUR' },
        ])
    })

    it('bills nothing for a per-device line without a start date, as for a site package', () => {
        const { start: _start, ...unstarted } = perDevice
        expect(subscriptionCharges(unstarted, nov, sources([{ siteId: 'hq', start: '2026-11-01' }]))).toEqual([])
    })

    it('bills nothing for an unknown line type, whatever Service intervals it is given, and reads no Site name', () => {
        const read = sources([{ siteId: 'hq', start: '2026-11-01' }])
        expect(subscriptionCharges({ ...perDevice, lineType: 'per_seat', siteId: 'hq', start: '2026-11-01' }, nov, read)).toEqual([])
        expect(read.siteReads).toBe(0)
    })
})

describe('toCsv', () => {
    it('quotes fields that need it and ends rows with CRLF', () => {
        expect(toCsv([['customer', 'amount'], ['Acme, Inc.', 12.5], ['say "hi"', 0]])).toBe('customer,amount\r\n"Acme, Inc.",12.5\r\n"say ""hi""",0\r\n')
    })

    it('writes text a spreadsheet would run as a formula with a leading apostrophe', () => {
        expect(toCsv([['=HYPERLINK("http://x","y")', '+1', '-2', '@SUM(A1)', '\tx', 'a=b']])).toBe(
            `"'=HYPERLINK(""http://x"",""y"")",'+1,'-2,'@SUM(A1),'\tx,a=b\r\n`,
        )
        expect(toCsv([['\r=1']])).toBe(`"'\r=1"\r\n`)
    })

    it('writes numbers as they are, negative ones too', () => {
        expect(toCsv([[-12.5, 0, 3]])).toBe('-12.5,0,3\r\n')
    })
})

describe('restartInterval', () => {
    const here = { lineId: 'L1', siteId: 'S1' }

    it('starts a new interval when there is none, or the latest ended before the restart', () => {
        expect(restartInterval(null, here, '2026-11-10')).toEqual({ start: '2026-11-10' })
        expect(restartInterval({ ...here, end: '2026-11-09' }, here, '2026-11-10')).toEqual({ start: '2026-11-10' })
    })

    it('reopens an interval at the same line and Site that ends on or after the restart day', () => {
        expect(restartInterval({ ...here, end: '2026-11-10' }, here, '2026-11-10')).toEqual({ reopen: true })
        expect(restartInterval({ ...here, end: '2026-11-12' }, here, '2026-11-10')).toEqual({ reopen: true })
    })

    it('starts the day after an interval elsewhere that covers the restart day', () => {
        expect(restartInterval({ ...here, end: '2026-11-10' }, { ...here, lineId: 'L2' }, '2026-11-10')).toEqual({ start: '2026-11-11' })
        expect(restartInterval({ ...here, end: '2026-11-10' }, { ...here, siteId: 'S2' }, '2026-11-10')).toEqual({ start: '2026-11-11' })
    })
})

describe('withinLine', () => {
    const line = { start: '2026-11-10', end: '2026-11-20' }

    it('cuts a Service interval to its line start and end date, both billed', () => {
        expect(withinLine({ start: '2026-02-01' }, line)).toEqual({ start: '2026-11-10', end: '2026-11-20' })
        expect(withinLine({ start: '2026-11-12', end: '2026-11-14' }, line)).toEqual({ start: '2026-11-12', end: '2026-11-14' })
        expect(withinLine({ start: '2026-11-20', end: '2026-12-31' }, line)).toEqual({ start: '2026-11-20', end: '2026-11-20' })
    })

    it('leaves an interval open on a line without an end date', () => {
        expect(withinLine({ start: '2026-11-12' }, { start: '2026-11-10' })).toEqual({ start: '2026-11-12', end: undefined })
        expect(withinLine({ start: '2026-11-01', end: '2026-11-05' }, { start: '2026-10-01' })).toEqual({ start: '2026-11-01', end: '2026-11-05' })
    })

    it('bills nothing outside the line, or on a line not started', () => {
        expect(withinLine({ start: '2026-11-21' }, line)).toBeNull()
        expect(withinLine({ start: '2026-10-01', end: '2026-11-09' }, line)).toBeNull()
        expect(withinLine({ start: '2026-11-12' }, {})).toBeNull()
        expect(withinLine({ start: '' }, line)).toBeNull()
    })
})

describe('IN_SERVICE_ON_ENDED_LINE', () => {
    it('flags billed fleet assets whose line was set ended or is past its end date', () => {
        expect(IN_USE_STAGES).toEqual(ALL_STAGES.filter((stage) => isBillable(stage)))
        expect(IN_USE_STAGES.length).toBeGreaterThan(0)
        const ended = 'x_daas_ham_subscription_line.status=ended^ORx_daas_ham_subscription_line.end_date<javascript:gs.beginningOfToday()'
        const fleet = 'x_daas_ham_fleet=true'
        expect(IN_SERVICE_ON_ENDED_LINE).toBe(
            `install_status=1^substatusISEMPTY^${ended}^${fleet}^NQinstall_status=1^substatus=temporary_deployment^${ended}^${fleet}`,
        )
    })

    it('is, like the unbilled tile, the query the server would build: the dashboard imports the constant', () => {
        expect(IN_SERVICE_ON_ENDED_LINE).toBe(fleetStagesQuery(IN_USE_STAGES, ON_ENDED_LINE))
        expect(IN_SERVICE_UNBILLED).toBe(fleetStagesQuery(['in_service'], NO_LINE))
    })
})

describe('decideGenerationReset', () => {
    const now = Date.parse('2026-11-09T12:00:00Z')
    const minutesAgo = (minutes: number) => now - minutes * 60000

    it('resets a generating period once its latest activity is 30 minutes old', () => {
        expect(RESET_AFTER_IDLE_MINUTES).toBe(30)
        expect(decideGenerationReset('generating', [minutesAgo(30)], now)).toEqual({ reset: true, idleMinutes: 30 })
        expect(decideGenerationReset('generating', [minutesAgo(240), minutesAgo(45)], now)).toEqual({ reset: true, idleMinutes: 45 })
        expect(decideGenerationReset('generating', [undefined, minutesAgo(31)], now)).toEqual({ reset: true, idleMinutes: 31 })
    })

    it('refuses while any activity is more recent, since the generation may still be running', () => {
        const decision = decideGenerationReset('generating', [minutesAgo(240), minutesAgo(29.5)], now)
        expect(decision).toEqual({
            reset: false,
            why: 'its generation was active 29 minute(s) ago and may still be running; it can be reset once it has shown no activity for 30 minutes',
        })
        expect(decideGenerationReset('generating', [now + 60000], now)).toMatchObject({ reset: false, why: expect.stringContaining('active 0 minute(s) ago') })
    })

    it('refuses when no activity can be read', () => {
        expect(decideGenerationReset('generating', [undefined], now)).toEqual({
            reset: false,
            why: 'when its generation was last active cannot be read, so it may still be running',
        })
        expect(decideGenerationReset('generating', [], now)).toMatchObject({ reset: false })
    })

    it('resets only a period still generating', () => {
        for (const status of ['ready', 'closed', '']) {
            expect(decideGenerationReset(status, [minutesAgo(600)], now)).toEqual({ reset: false, why: 'only a period still generating can be reset' })
        }
    })
})

describe('resetGenerationError', () => {
    it('says the period was reset by hand and must be regenerated', () => {
        expect(resetGenerationError('Fran Admin', 42)).toBe(
            'Generation reset by hand by Fran Admin after 42 minutes without activity; its lines may be incomplete: Regenerate before closing',
        )
    })

    it('fits the 255 characters of the period error', () => {
        expect(resetGenerationError('x'.repeat(300), 30)).toHaveLength(255)
    })
})

describe('a Billing line as exported', () => {
    function storedLine(values: Partial<Record<BillingLineField, string>>, names: Partial<Record<BillingLineField, string>>): StoredBillingLine {
        return { value: (field) => values[field] ?? '', display: (field) => names[field] ?? '' }
    }

    const subscription = storedLine(
        {
            kind: 'subscription',
            customer: 'c1',
            agreement: 'a1',
            subscription_line: 'sl1',
            site: 's1',
            description: 'Switches - Lyon, HQ',
            units: '42',
            monthly_rate: '12.5',
            amount: '17.5',
            currency: 'EUR',
        },
        { customer: 'Acme, Inc.', agreement: 'AGR0001', subscription_line: 'Switches', site: 'Lyon' },
    )
    const fee = storedLine(
        { kind: 'fee', customer: 'c1', agreement: 'a1', fee_event: 'f1', description: 'Lost fee: SN1 (2026-10-12)', units: '1', amount: '350', currency: 'EUR' },
        { customer: 'Acme, Inc.', agreement: 'AGR0001', fee_event: 'FEE0001' },
    )

    it('is a CSV row of its period and columns, a reference by its display value', () => {
        expect(toCsv([billingCsvHeader(), billingCsvRow('2026-10', subscription), billingCsvRow('2026-10', fee)])).toBe(
            'period,kind,customer,agreement,subscription_line,site,description,units,monthly_rate,amount,currency\r\n' +
                '2026-10,subscription,"Acme, Inc.",AGR0001,Switches,Lyon,"Switches - Lyon, HQ",42,12.5,17.5,EUR\r\n' +
                '2026-10,fee,"Acme, Inc.",AGR0001,,,Lost fee: SN1 (2026-10-12),1,0,350,EUR\r\n',
        )
    })

    it('is a pull API line of its stored values, with the display values the API names', () => {
        expect(JSON.stringify(billingLineJson('l1', subscription))).toBe(
            '{"id":"l1","kind":"subscription","customerId":"c1","customer":"Acme, Inc.","agreement":"AGR0001","subscriptionLine":"sl1",' +
                '"siteId":"s1","site":"Lyon","feeEvent":"","description":"Switches - Lyon, HQ","units":42,"monthlyRate":12.5,"amount":17.5,"currency":"EUR"}',
        )
        expect(JSON.stringify(billingLineJson('l2', fee))).toBe(
            '{"id":"l2","kind":"fee","customerId":"c1","customer":"Acme, Inc.","agreement":"AGR0001","subscriptionLine":"",' +
                '"siteId":"","site":"","feeEvent":"f1","description":"Lost fee: SN1 (2026-10-12)","units":1,"monthlyRate":0,"amount":350,"currency":"EUR"}',
        )
    })

    it('reads a number column that is empty or unreadable as 0', () => {
        expect(billingLineJson('l3', storedLine({ units: 'n/a' }, {}))).toMatchObject({ units: 0, monthlyRate: 0, amount: 0 })
    })
})
