import { describe, expect, it } from 'vitest'
import { monthBounds } from './billing'
import { CostLedger, costFactKey, leaseShare, marginRows, serviceIntervalCosts, type AssetCostFacts, type LeaseTerms } from './margin'

const november = monthBounds('2026-11')
const wholeMonth = { start: '2026-01-15' }
const provider: AssetCostFacts = { legalOwner: 'provider', purchaseCost: 6000, purchaseDate: '', inServiceDate: '', supportAnnual: 0, lease: null }
const lease: LeaseTerms = { starts: '2024-02-01 00:00:00', ends: '2027-01-31 23:59:59', monthlyPayment: 180, coveredAssets: 2, buyoutAssets: 0 }
const lessor: AssetCostFacts = { ...provider, legalOwner: 'lessor', lease }

function costs(asset: AssetCostFacts, interval: { start: string; end?: string } = wholeMonth, amortisationMonths = 60) {
    return serviceIntervalCosts(interval, asset, november, amortisationMonths)
}

describe('serviceIntervalCosts', () => {
    it('writes a provider-owned purchase off evenly over the amortisation period', () => {
        expect(costs(provider)).toEqual([{ type: 'purchase', amount: 100 }])
        expect(costs(provider, wholeMonth, 24)).toEqual([{ type: 'purchase', amount: 250 }])
        expect(costs(provider, wholeMonth, 0)).toEqual([])
        expect(costs({ ...provider, purchaseCost: 0 })).toEqual([])
    })

    it('ends the write-off the amortisation period after the purchase date', () => {
        expect(costs({ ...provider, purchaseDate: '2021-11-01' })).toEqual([])
        expect(costs({ ...provider, purchaseDate: '2021-11-02' })).toEqual([{ type: 'purchase', amount: 100 }])
    })

    it('starts the write-off at the in-service date, cut to a date, when there is no purchase date', () => {
        expect(costs({ ...provider, inServiceDate: '2021-11-01 09:30:00' })).toEqual([])
        expect(costs({ ...provider, inServiceDate: '2021-11-02 00:00:00' })).toEqual([{ type: 'purchase', amount: 100 }])
        expect(costs({ ...provider, purchaseDate: '2021-11-02', inServiceDate: '2021-11-01 09:30:00' })).toEqual([{ type: 'purchase', amount: 100 }])
    })

    it('starts the write-off no earlier than the purchase, e.g. a lease buyout', () => {
        expect(costs({ ...provider, purchaseDate: '2026-11-16' })).toEqual([{ type: 'purchase', amount: 50 }])
        expect(costs({ ...provider, purchaseDate: '2026-12-01' })).toEqual([{ type: 'purchase', amount: 0 }])
        expect(costs({ ...provider, purchaseDate: '2026-11-16' }, { start: '2026-11-21', end: '2026-11-25' })).toEqual([{ type: 'purchase', amount: 100 * (5 / 30) }])
    })

    it('keeps the write-off running when neither date is known', () => {
        expect(costs({ ...provider, purchaseDate: '', inServiceDate: '' })).toEqual([{ type: 'purchase', amount: 100 }])
    })

    it('treats a blank owner as the provider', () => {
        expect(costs({ ...provider, legalOwner: '' })).toEqual([{ type: 'purchase', amount: 100 }])
    })

    it('charges a leased Asset its share of the payment, only in a month the lease runs', () => {
        expect(costs(lessor)).toEqual([{ type: 'lease', amount: 90 }])
        expect(costs({ ...lessor, lease: { ...lease, starts: '2026-11-30 12:00:00' } })).toEqual([{ type: 'lease', amount: 90 }])
        expect(costs({ ...lessor, lease: { ...lease, ends: '2026-11-01 00:00:00' } })).toEqual([{ type: 'lease', amount: 90 }])
        expect(costs({ ...lessor, lease: { ...lease, starts: '', ends: '' } })).toEqual([{ type: 'lease', amount: 90 }])
        expect(costs({ ...lessor, lease: { ...lease, ends: '2026-10-31 23:59:59' } })).toEqual([])
        expect(costs({ ...lessor, lease: { ...lease, starts: '2026-12-01 00:00:00', ends: '' } })).toEqual([])
    })

    it('keeps splitting the payment over the Assets covered at buyout while the transfer runs', () => {
        expect(costs({ ...lessor, lease: { ...lease, coveredAssets: 1, buyoutAssets: 3 } })).toEqual([{ type: 'lease', amount: 60 }])
    })

    it('charges no lease without covered Assets, a Lease schedule, or the Lessor as owner', () => {
        expect(costs({ ...lessor, lease: { ...lease, coveredAssets: 0 } })).toEqual([])
        expect(costs({ ...lessor, lease: null })).toEqual([])
        expect(costs({ ...provider, lease, purchaseCost: 0 })).toEqual([])
    })

    it('carries no capital cost for customer-owned equipment, but still its OEM support', () => {
        expect(costs({ ...lessor, legalOwner: 'customer', supportAnnual: 360 })).toEqual([{ type: 'oem_support', amount: 30 }])
    })

    it('prorates a partial-month interval by its days in the month', () => {
        expect(costs({ ...provider, supportAnnual: 360 }, { start: '2026-11-16', end: '2026-12-10' })).toEqual([
            { type: 'purchase', amount: 50 },
            { type: 'oem_support', amount: 15 },
        ])
        expect(costs({ ...lessor, supportAnnual: 360 }, { start: '2026-10-01', end: '2026-11-15' })).toEqual([
            { type: 'lease', amount: 45 },
            { type: 'oem_support', amount: 15 },
        ])
    })

    it('gives zero amounts for an interval outside the month', () => {
        expect(costs({ ...provider, supportAnnual: 360 }, { start: '2026-12-01' })).toEqual([
            { type: 'purchase', amount: 0 },
            { type: 'oem_support', amount: 0 },
        ])
        expect(costs(lessor, { start: '2026-09-01', end: '2026-10-31' })).toEqual([{ type: 'lease', amount: 0 }])
    })
})

describe('leaseShare', () => {
    it('splits the monthly payment over the covered assets', () => {
        expect(leaseShare({ monthlyPayment: 180, coveredAssets: 2, buyoutAssets: 0 })).toBe(90)
        expect(leaseShare({ monthlyPayment: 180, coveredAssets: 0, buyoutAssets: 0 })).toBe(0)
    })

    it('splits over the Assets covered at buyout while fewer are left on the lease', () => {
        expect(leaseShare({ monthlyPayment: 180, coveredAssets: 1, buyoutAssets: 3 })).toBe(60)
        expect(leaseShare({ monthlyPayment: 180, coveredAssets: 0, buyoutAssets: 3 })).toBe(60)
    })

    it('splits over the Assets on the lease when there are more than at buyout', () => {
        expect(leaseShare({ monthlyPayment: 180, coveredAssets: 4, buyoutAssets: 3 })).toBe(45)
    })
})

describe('costFactKey', () => {
    it('tells Cost facts apart by customer, site and type', () => {
        const keys = [costFactKey('acme', 'hq', 'lease'), costFactKey('acme', 'hq', 'purchase'), costFactKey('acme', '', 'lease'), costFactKey('globex', 'hq', 'lease')]
        expect(new Set(keys).size).toBe(4)
        expect(costFactKey('acme', 'hq', 'lease')).toBe(costFactKey('acme', 'hq', 'lease'))
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

    it('drains one entry per cost fact key', () => {
        const ledger = new CostLedger()
        ledger.add('acme', 'hq', 'purchase', 10)
        ledger.add('acme', 'hq', 'purchase', 5)
        ledger.add('acme', '', 'purchase', 1)
        const keys = ledger.drain().map((entry) => costFactKey(entry.customerId, entry.siteId, entry.type))
        expect(keys).toEqual([costFactKey('acme', 'hq', 'purchase'), costFactKey('acme', '', 'purchase')])
    })
})

describe('marginRows', () => {
    it('joins revenue and cost per customer and site, sorted by customer then site', () => {
        const rows = marginRows(
            [
                { customerId: 'acme', siteId: 'hq', amount: 4500 },
                { customerId: 'acme', siteId: '', amount: 150 },
            ],
            [
                { customerId: 'globex', siteId: 'dc', amount: 300 },
                { customerId: 'acme', siteId: 'hq', amount: 1200.555 },
            ],
        )
        expect(rows).toEqual([
            { customerId: 'acme', siteId: '', revenue: 150, cost: 0, margin: 150, marginPct: 100 },
            { customerId: 'acme', siteId: 'hq', revenue: 4500, cost: 1200.56, margin: 3299.44, marginPct: 73.3 },
            { customerId: 'globex', siteId: 'dc', revenue: 0, cost: 300, margin: -300, marginPct: null },
        ])
    })

    it('sums amounts for the same customer and site before rounding', () => {
        const rows = marginRows(
            [
                { customerId: 'acme', siteId: 'hq', amount: 100.004 },
                { customerId: 'acme', siteId: 'hq', amount: 50.004 },
            ],
            [
                { customerId: 'acme', siteId: 'hq', amount: 30 },
                { customerId: 'acme', siteId: 'hq', amount: 15 },
            ],
        )
        expect(rows).toEqual([{ customerId: 'acme', siteId: 'hq', revenue: 150.01, cost: 45, margin: 105.01, marginPct: 70 }])
    })
})
