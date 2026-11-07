import { describe, expect, it } from 'vitest'
import { CostLedger, intervalCosts, leaseRunsIn, leaseShare, marginKey, marginRows } from './margin'

const base = { days: 30, monthFirst: '2026-11-01', daysInMonth: 30, purchaseCost: 0, amortisationMonths: 60, leaseMonthly: 0, supportAnnual: 0 }

describe('intervalCosts', () => {
    it('writes a provider-owned purchase off over the amortisation period', () => {
        expect(intervalCosts({ ...base, legalOwner: 'provider', purchaseCost: 6000 })).toEqual([{ type: 'purchase', amount: 100 }])
    })

    it('stops the write-off once the amortisation period has passed', () => {
        expect(intervalCosts({ ...base, legalOwner: 'provider', purchaseCost: 6000, purchasedOn: '2021-11-01' })).toEqual([])
        expect(intervalCosts({ ...base, legalOwner: 'provider', purchaseCost: 6000, purchasedOn: '2021-11-02' })).toEqual([{ type: 'purchase', amount: 100 }])
    })

    it('charges a leased asset its lease share instead, prorated by days', () => {
        expect(intervalCosts({ ...base, days: 15, legalOwner: 'lessor', purchaseCost: 6000, leaseMonthly: 90 })).toEqual([{ type: 'lease', amount: 45 }])
    })

    it('carries no capital cost for customer-owned equipment, but still its OEM support', () => {
        expect(intervalCosts({ ...base, legalOwner: 'customer', purchaseCost: 6000, supportAnnual: 360 })).toEqual([{ type: 'oem_support', amount: 30 }])
    })

    it('carries nothing for an asset that did not serve', () => {
        expect(intervalCosts({ ...base, days: 0, legalOwner: 'provider', purchaseCost: 6000 })).toEqual([{ type: 'purchase', amount: 0 }])
        expect(intervalCosts({ ...base, legalOwner: 'provider' })).toEqual([])
    })
})

describe('leaseShare', () => {
    it('splits the monthly payment over the covered assets', () => {
        expect(leaseShare(180, 2)).toBe(90)
        expect(leaseShare(180, 0)).toBe(0)
    })
})

describe('leaseRunsIn', () => {
    it('is payable in months that overlap the lease', () => {
        expect(leaseRunsIn('2024-02-01', '2027-01-31', '2026-11-01', '2026-11-30')).toBe(true)
        expect(leaseRunsIn('2024-02-01', '2026-10-31', '2026-11-01', '2026-11-30')).toBe(false)
        expect(leaseRunsIn('2026-12-01', '', '2026-11-01', '2026-11-30')).toBe(false)
        expect(leaseRunsIn('', '', '2026-11-01', '2026-11-30')).toBe(true)
    })
})

describe('CostLedger', () => {
    it('sums per customer, site and type and empties on drain', () => {
        const ledger = new CostLedger()
        ledger.add('acme', 'hq', 'purchase', 10)
        ledger.add('acme', 'hq', 'purchase', 5)
        ledger.add('acme', 'hq', 'lease', 7)
        ledger.add('acme', '', 'field_labour', 250)
        ledger.add('', 'hq', 'purchase', 99)
        expect(ledger.drain()).toEqual([
            { customerId: 'acme', siteId: 'hq', type: 'purchase', amount: 15 },
            { customerId: 'acme', siteId: 'hq', type: 'lease', amount: 7 },
            { customerId: 'acme', siteId: '', type: 'field_labour', amount: 250 },
        ])
        expect(ledger.drain()).toEqual([])
    })
})

describe('marginRows', () => {
    it('joins revenue and cost per customer and site', () => {
        const rows = marginRows(
            new Map([
                [marginKey('acme', 'hq'), 4500],
                [marginKey('acme', ''), 150],
            ]),
            new Map([
                [marginKey('acme', 'hq'), 1200.555],
                [marginKey('globex', 'dc'), 300],
            ]),
        )
        expect(rows).toEqual([
            { customerId: 'acme', siteId: '', revenue: 150, cost: 0, margin: 150, marginPct: 100 },
            { customerId: 'acme', siteId: 'hq', revenue: 4500, cost: 1200.56, margin: 3299.44, marginPct: 73.3 },
            { customerId: 'globex', siteId: 'dc', revenue: 0, cost: 300, margin: -300, marginPct: null },
        ])
    })
})
