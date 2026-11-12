import { describe, expect, it } from 'vitest'
import {
    billingCsvHeader,
    billingCsvRow,
    billingLineJson,
    billingMonthProblem,
    billsFromIntervals,
    currencyTotals,
    decideGenerationReset,
    IN_SERVICE_ON_ENDED_LINE,
    IN_SERVICE_UNBILLED,
    intervalEnd,
    PULL_PAGE,
    pullPageSize,
    resetGenerationError,
    sitePackageHoldersQuery,
    restartInterval,
    singleCurrencyTotal,
    subscriptionCharges,
    toCsv,
    totalsText,
    type BillingLineField,
    type ChargeSources,
    type ServiceInterval,
    type StoredBillingLine,
} from './billing'
import { monthBounds, previousMonth } from './money'
import { ALL_STAGES, IN_USE_STAGES, type Stage } from './lifecycle'
import { recordMatches as matches } from '../test-support/encoded-query'
import { assetIn, type SampleRecord } from '../test-support/stored-asset'

const nov = monthBounds('2026-11')

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

describe('intervalEnd', () => {
    it('ends a Service interval on the day it is closed', () => {
        expect(intervalEnd('2026-11-02', '2026-11-07')).toBe('2026-11-07')
        expect(intervalEnd('2026-11-07', '2026-11-07')).toBe('2026-11-07')
    })

    it('never ends one before it started', () => {
        expect(intervalEnd('2026-11-10', '2026-11-07')).toBe('2026-11-10')
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

    it('bills nothing for a per-device line without a start date, as for a site package, nor for an interval without one', () => {
        const { start: _start, ...unstarted } = perDevice
        expect(subscriptionCharges(unstarted, nov, sources([{ siteId: 'hq', start: '2026-11-01' }]))).toEqual([])
        expect(subscriptionCharges(perDevice, nov, sources([{ siteId: 'hq', start: '' }]))).toEqual([])
    })

    it('bills nothing for an unknown line type, whatever Service intervals it is given, and reads no Site name', () => {
        const read = sources([{ siteId: 'hq', start: '2026-11-01' }])
        expect(subscriptionCharges({ ...perDevice, lineType: 'per_seat', siteId: 'hq', start: '2026-11-01' }, nov, read)).toEqual([])
        expect(read.siteReads).toBe(0)
    })
})

describe('the amount of a charge', () => {
    const sitePackage = { lineType: 'site_package', currency: 'EUR', siteId: '', description: 'Site package' }
    const amounts = (monthlyRate: number, month: string, start: string) =>
        subscriptionCharges({ ...sitePackage, monthlyRate, start }, monthBounds(month), sources()).map((charge) => charge.amount)

    it('is the share of the month the line ran, to the cent', () => {
        expect(amounts(45, '2026-11', '2026-01-01')).toEqual([45])
        expect(amounts(45, '2026-11', '2026-11-21')).toEqual([15])
        expect(amounts(100, '2026-12', '2026-12-31')).toEqual([3.23])
    })

    it('rounds a charge of exactly half a cent up, which binary floats would round down', () => {
        // 0.29 x 14 / 28 = 0.145 and 0.7 x 3 / 28 = 0.075, yet (0.29 * 14 * 100) / 28 is 14.499999999999998 in floats.
        expect(amounts(0.29, '2026-02', '2026-02-15')).toEqual([0.15])
        expect(amounts(0.7, '2026-02', '2026-02-26')).toEqual([0.08])
        expect(amounts(-0.29, '2026-02', '2026-02-15')).toEqual([-0.15])
    })

    it('stays exact for large rates and many device-days', () => {
        const core = { lineType: 'device_class', monthlyRate: 123456.78, currency: 'EUR', siteId: '', description: 'Core', start: '2026-01-01' }
        const charges = subscriptionCharges(core, monthBounds('2026-12'), sources([{ siteId: 'hq', start: '2026-01-01', count: 400 }]))
        expect(charges.map((charge) => [charge.units, charge.amount])).toEqual([[31 * 400, 49382712]])
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
        const endsThatDay = { ...here, end: '2026-11-10' }
        const endsLater = { ...here, end: '2026-11-12' }
        expect(restartInterval(endsThatDay, here, '2026-11-10')).toEqual({ reopen: endsThatDay })
        expect(restartInterval(endsLater, here, '2026-11-10')).toEqual({ reopen: endsLater })
    })

    it('starts the day after an interval elsewhere that covers the restart day', () => {
        expect(restartInterval({ ...here, end: '2026-11-10' }, { ...here, lineId: 'L2' }, '2026-11-10')).toEqual({ start: '2026-11-11' })
        expect(restartInterval({ ...here, end: '2026-11-10' }, { ...here, siteId: 'S2' }, '2026-11-10')).toEqual({ start: '2026-11-11' })
    })
})

describe('IN_SERVICE_UNBILLED', () => {
    const flagged = (asset: SampleRecord) => matches(IN_SERVICE_UNBILLED, asset)
    const unbilled = (stage: Stage, fields: SampleRecord = {}) => assetIn(stage, { x_daas_ham_fleet: 'true', x_daas_ham_subscription_line: '', ...fields })

    it('flags fleet assets in service on no Subscription line', () => {
        expect(ALL_STAGES.filter((stage) => flagged(unbilled(stage)))).toEqual(['in_service'])
    })

    it("leaves out an asset on a line, and the Provider IT's (ADR 0016)", () => {
        expect(flagged(unbilled('in_service', { x_daas_ham_subscription_line: 'sl1' }))).toBe(false)
        expect(flagged(unbilled('in_service', { x_daas_ham_fleet: 'false' }))).toBe(false)
        expect(flagged(unbilled('in_service', { x_daas_ham_fleet: '' }))).toBe(false)
    })
})

describe('IN_SERVICE_ON_ENDED_LINE', () => {
    /** Today is 2026-11-09: the day the tile's query compares a line's end date with. */
    const flagged = (asset: SampleRecord) => matches(IN_SERVICE_ON_ENDED_LINE, asset, () => '2026-11-09')
    const LINE = 'x_daas_ham_subscription_line'
    const billed = (status: string, endDate: string) => assetIn('in_service', { x_daas_ham_fleet: 'true', [`${LINE}.status`]: status, [`${LINE}.end_date`]: endDate })

    it('flags billed fleet assets whose line was set ended or is past its end date', () => {
        expect(flagged(billed('ended', ''))).toBe(true)
        expect(flagged(billed('active', '2026-11-08'))).toBe(true)
        expect(flagged({ ...billed('ended', ''), ...assetIn('temporary_deployment') })).toBe(true)
        expect(flagged({ ...billed('active', '2026-11-08'), ...assetIn('temporary_deployment') })).toBe(true)
    })

    it('leaves an asset on a line still running: no end date, or one not yet past (the end date itself is billed)', () => {
        expect(flagged(billed('active', ''))).toBe(false)
        expect(flagged(billed('active', '2026-11-09'))).toBe(false)
        expect(flagged(billed('active', '2027-01-31'))).toBe(false)
    })

    it("leaves out an asset in no stage in use, which is not billed, and the Provider IT's (ADR 0016)", () => {
        expect(ALL_STAGES.filter((stage) => flagged({ ...billed('ended', ''), ...assetIn(stage) }))).toEqual([...IN_USE_STAGES])
        expect(flagged({ ...billed('ended', ''), x_daas_ham_fleet: 'false' })).toBe(false)
        expect(flagged({ ...billed('active', '2026-11-08'), ...assetIn('temporary_deployment'), x_daas_ham_fleet: '' })).toBe(false)
    })
})

describe('decideGenerationReset', () => {
    const now = Date.parse('2026-11-09T12:00:00Z')
    const minutesAgo = (minutes: number) => now - minutes * 60000

    it('resets a generating period once its latest activity is 30 minutes old', () => {
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
        expect(billingLineJson('l1', subscription)).toEqual({
            id: 'l1',
            kind: 'subscription',
            customerId: 'c1',
            customer: 'Acme, Inc.',
            agreement: 'AGR0001',
            subscriptionLine: 'sl1',
            siteId: 's1',
            site: 'Lyon',
            feeEvent: '',
            description: 'Switches - Lyon, HQ',
            units: 42,
            monthlyRate: 12.5,
            amount: 17.5,
            currency: 'EUR',
        })
        expect(billingLineJson('l2', fee)).toEqual({
            id: 'l2',
            kind: 'fee',
            customerId: 'c1',
            customer: 'Acme, Inc.',
            agreement: 'AGR0001',
            subscriptionLine: '',
            siteId: '',
            site: '',
            feeEvent: 'f1',
            description: 'Lost fee: SN1 (2026-10-12)',
            units: 1,
            monthlyRate: 0,
            amount: 350,
            currency: 'EUR',
        })
    })

    it('reads a number column that is empty or unreadable as 0', () => {
        expect(billingLineJson('l3', storedLine({ units: 'n/a' }, {}))).toMatchObject({ units: 0, monthlyRate: 0, amount: 0 })
    })
})

describe('pullPageSize', () => {
    it("gives the page size asked for, at least one and at most the page's most", () => {
        expect(pullPageSize(50, PULL_PAGE.lines)).toBe(50)
        expect(pullPageSize(0, PULL_PAGE.lines)).toBe(1)
        expect(pullPageSize(PULL_PAGE.lines.most + 1, PULL_PAGE.lines)).toBe(PULL_PAGE.lines.most)
        expect(pullPageSize(PULL_PAGE.periods.most + 1, PULL_PAGE.periods)).toBe(PULL_PAGE.periods.most)
    })
})

describe('sitePackageHoldersQuery', () => {
    const query = sitePackageHoldersQuery({ siteId: 'acme-hq', agreementId: 'acme-msa' })
    const unit = (stage: Stage, fields: SampleRecord = {}) => assetIn(stage, { x_daas_ham_fleet: 'true', x_daas_ham_site: 'acme-hq', x_daas_ham_agreement: 'acme-msa', ...fields })
    const holding = (fields: SampleRecord = {}) => ALL_STAGES.filter((stage) => matches(query, unit(stage, fields)))

    // A swap's new units before monitoring sees them, units serving there and units still to come back.
    it('is held open by a unit shipped, awaiting first sighting, in service, temporarily deployed or awaiting return, and by no other', () => {
        expect(holding()).toEqual(['shipped', 'pending_in_service', 'in_service', 'temporary_deployment', 'pending_return'])
    })

    it.each<Stage>(['pending_evaluation', 'missing', 'available'])('lets go of a unit %s', (stage) => {
        expect(matches(query, unit(stage))).toBe(false)
    })

    it('counts only Assets at the Site under the Agreement, whatever their stage', () => {
        expect(holding({ x_daas_ham_site: 'acme-branch' })).toEqual([])
        expect(holding({ x_daas_ham_agreement: 'acme-old' })).toEqual([])
        expect(holding({ x_daas_ham_site: '' })).toEqual([])
    })

    it('counts fleet assets only, whatever their stage (ADR 0016)', () => {
        expect(holding({ x_daas_ham_fleet: 'false' })).toEqual([])
        expect(holding({ x_daas_ham_fleet: '' })).toEqual([])
    })
})
