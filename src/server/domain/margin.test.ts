import { describe, expect, it } from 'vitest'
import { monthBounds } from './money'
import { addMonths } from './calendar'
import {
    CostLedger,
    costFactKey,
    labourCost,
    marginRows,
    serviceIntervalCosts,
    type AssetCostFacts,
    type CostEntry,
    type LeaseTerms,
} from './margin'
import type { CostType } from './vocabulary'

const november = monthBounds('2026-11')
const wholeMonth = { start: '2026-01-15' }
const provider: AssetCostFacts = { legalOwner: 'provider', purchaseCost: 6000, purchaseDate: '', inServiceDate: '', supportAnnual: 0, lease: null }
const lease: LeaseTerms = { starts: '2024-02-01 00:00:00', ends: '2027-01-31 23:59:59', monthlyPayment: 180, coveredAssets: 2, buyoutAssets: 0 }
const lessor: AssetCostFacts = { ...provider, legalOwner: 'lessor', lease }

/** The costs charged, leaving out amounts of 0, which add nothing to a Cost fact. */
function costs(asset: AssetCostFacts, interval: { start: string; end?: string } = wholeMonth, amortisationMonths = 60) {
    return serviceIntervalCosts(interval, asset, november, amortisationMonths).filter((cost) => cost.amount !== 0)
}

/** A purchase write-off of about `amount` (fractions of a month's days do not divide exactly). */
function purchaseOf(amount: number) {
    return [{ type: 'purchase', amount: expect.closeTo(amount, 10) }]
}

function lifetimePurchaseCost(purchaseDate: string, amortisationMonths: number): number {
    const asset = { ...provider, purchaseDate }
    let total = 0
    for (let i = 0; i <= amortisationMonths + 12; i++) {
        const month = monthBounds(addMonths(`${purchaseDate.slice(0, 7)}-01`, i).slice(0, 7))
        for (const cost of serviceIntervalCosts({ start: purchaseDate }, asset, month, amortisationMonths)) {
            total += cost.amount
        }
    }
    return total
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
        expect(costs({ ...provider, purchaseDate: '2021-12-01' })).toEqual([{ type: 'purchase', amount: 100 }])
    })

    it('charges the last month of a write-off only up to its last day', () => {
        // Bought 2 Nov 2021: the first month carried 29/30 of a monthly write-off, so 1 Nov 2026 carries the rest.
        expect(costs({ ...provider, purchaseDate: '2021-11-02' })).toEqual(purchaseOf(100 / 30))
        expect(costs({ ...provider, purchaseDate: '2021-11-16' })).toEqual(purchaseOf(50))
        expect(costs({ ...provider, purchaseDate: '2021-11-16' }, { start: '2026-11-10', end: '2026-11-20' })).toEqual(purchaseOf(20))
        expect(costs({ ...provider, purchaseDate: '2021-11-16' }, { start: '2026-11-16' })).toEqual([])
    })

    it('writes off exactly the cost over the life of an Asset in service throughout', () => {
        expect(lifetimePurchaseCost('2021-11-16', 60)).toBeCloseTo(6000, 6)
        expect(lifetimePurchaseCost('2026-01-01', 60)).toBeCloseTo(6000, 6)
        // First and last months of different lengths, and anniversaries past the end of a short month.
        expect(lifetimePurchaseCost('2026-01-16', 13)).toBeCloseTo(6000, 6)
        expect(lifetimePurchaseCost('2024-02-10', 60)).toBeCloseTo(6000, 6)
        expect(lifetimePurchaseCost('2026-01-31', 1)).toBeCloseTo(6000, 6)
        expect(lifetimePurchaseCost('2026-03-31', 7)).toBeCloseTo(6000, 6)
    })

    it('starts the write-off at the in-service date, cut to a date, when there is no purchase date', () => {
        expect(costs({ ...provider, inServiceDate: '2021-11-01 09:30:00' })).toEqual([])
        expect(costs({ ...provider, inServiceDate: '2021-11-02 00:00:00' })).toEqual(purchaseOf(100 / 30))
        expect(costs({ ...provider, purchaseDate: '2021-11-02', inServiceDate: '2021-11-01 09:30:00' })).toEqual(purchaseOf(100 / 30))
    })

    it('starts the write-off no earlier than the purchase, e.g. a lease buyout', () => {
        expect(costs({ ...provider, purchaseDate: '2026-11-16' })).toEqual([{ type: 'purchase', amount: 50 }])
        expect(costs({ ...provider, purchaseDate: '2026-12-01' })).toEqual([])
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
        expect(costs({ ...lessor, lease: { ...lease, coveredAssets: 4, buyoutAssets: 3 } })).toEqual([{ type: 'lease', amount: 45 }])
    })

    it('leaves a share of the payment unrounded, as costs are rounded only once summed', () => {
        const shares = costs({ ...lessor, lease: { ...lease, monthlyPayment: 100, coveredAssets: 3 } })
        expect(shares).toEqual([{ type: 'lease', amount: expect.closeTo(100 / 3, 10) }])
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

    it('charges nothing for an interval outside the month', () => {
        expect(costs({ ...provider, supportAnnual: 360 }, { start: '2026-12-01' })).toEqual([])
        expect(costs(lessor, { start: '2026-09-01', end: '2026-10-31' })).toEqual([])
    })
})

describe('CostLedger', () => {
    const cost = (customerId: string, siteId: string, type: CostType, amount: number, currency = 'EUR'): CostEntry => ({ customerId, siteId, type, currency, amount })

    it('sums per customer, site, type and currency, by cost fact key, and empties on drain', () => {
        const ledger = new CostLedger()
        ledger.add(cost('acme', 'hq', 'purchase', 10))
        ledger.add(cost('acme', 'hq', 'purchase', 5))
        ledger.add(cost('acme', 'hq', 'purchase', 8, 'USD'))
        ledger.add(cost('acme', 'hq', 'lease', 7))
        ledger.add(cost('acme', '', 'purchase', 250))
        ledger.add(cost('globex', 'hq', 'purchase', 3))
        ledger.add(cost('', 'hq', 'purchase', 99))
        ledger.add(cost('acme', 'hq', 'shipping', 0, ''))
        expect(ledger.drain()).toEqual(
            new Map([
                [costFactKey('acme', 'hq', 'purchase', 'EUR'), cost('acme', 'hq', 'purchase', 15)],
                [costFactKey('acme', 'hq', 'purchase', 'USD'), cost('acme', 'hq', 'purchase', 8, 'USD')],
                [costFactKey('acme', 'hq', 'lease', 'EUR'), cost('acme', 'hq', 'lease', 7)],
                [costFactKey('acme', '', 'purchase', 'EUR'), cost('acme', '', 'purchase', 250)],
                [costFactKey('globex', 'hq', 'purchase', 'EUR'), cost('globex', 'hq', 'purchase', 3)],
            ]),
        )
        expect(ledger.drain().size).toBe(0)
    })

    it('refuses a cost without a currency, which no Cost fact may hold', () => {
        expect(() => new CostLedger().add(cost('acme', 'hq', 'shipping', 12.5, ''))).toThrow('a shipping cost has no currency')
    })

    it('leaves drained totals as they are when more is added', () => {
        const ledger = new CostLedger()
        ledger.add(cost('acme', 'hq', 'purchase', 10))
        const drained = ledger.drain()
        ledger.add(cost('acme', 'hq', 'purchase', 5))
        expect(drained.get(costFactKey('acme', 'hq', 'purchase', 'EUR'))?.amount).toBe(10)
        expect(ledger.drain().get(costFactKey('acme', 'hq', 'purchase', 'EUR'))?.amount).toBe(5)
    })
})

describe('marginRows', () => {
    it('joins revenue and cost per customer, site and currency, sorted by customer, site then currency', () => {
        const rows = marginRows(
            [
                { customerId: 'acme', siteId: 'hq', currency: 'EUR', amount: 4500 },
                { customerId: 'acme', siteId: '', currency: 'EUR', amount: 150 },
            ],
            [
                { customerId: 'globex', siteId: 'dc', currency: 'EUR', amount: 300 },
                { customerId: 'acme', siteId: 'hq', currency: 'EUR', amount: 1200.555 },
            ],
        )
        expect(rows).toEqual([
            { customerId: 'acme', siteId: '', currency: 'EUR', revenue: 150, cost: 0, margin: 150, marginPct: 100 },
            { customerId: 'acme', siteId: 'hq', currency: 'EUR', revenue: 4500, cost: 1200.56, margin: 3299.44, marginPct: 73.3 },
            { customerId: 'globex', siteId: 'dc', currency: 'EUR', revenue: 0, cost: 300, margin: -300, marginPct: null },
        ])
    })

    it('keeps a stored currency whole, whatever it holds', () => {
        const [row] = marginRows([{ customerId: 'acme', siteId: 'hq', currency: 'E|R', amount: 10 }], [])
        expect(row).toMatchObject({ customerId: 'acme', siteId: 'hq', currency: 'E|R', revenue: 10 })
    })

    it('never sets revenue in one currency against cost in another', () => {
        const rows = marginRows(
            [{ customerId: 'acme', siteId: 'hq', currency: 'EUR', amount: 1000 }],
            [
                { customerId: 'acme', siteId: 'hq', currency: 'EUR', amount: 400 },
                { customerId: 'acme', siteId: 'hq', currency: 'USD', amount: 21.4 },
            ],
        )
        expect(rows).toEqual([
            { customerId: 'acme', siteId: 'hq', currency: 'EUR', revenue: 1000, cost: 400, margin: 600, marginPct: 60 },
            { customerId: 'acme', siteId: 'hq', currency: 'USD', revenue: 0, cost: 21.4, margin: -21.4, marginPct: null },
        ])
    })

    it('sums amounts for the same customer, site and currency before rounding', () => {
        const rows = marginRows(
            [
                { customerId: 'acme', siteId: 'hq', currency: 'EUR', amount: 100.004 },
                { customerId: 'acme', siteId: 'hq', currency: 'EUR', amount: 50.004 },
            ],
            [
                { customerId: 'acme', siteId: 'hq', currency: 'EUR', amount: 30 },
                { customerId: 'acme', siteId: 'hq', currency: 'EUR', amount: 15 },
            ],
        )
        expect(rows).toEqual([{ customerId: 'acme', siteId: 'hq', currency: 'EUR', revenue: 150.01, cost: 45, margin: 105.01, marginPct: 70 }])
    })

    it('rounds half-cents and the margin % half away from zero, in whole cents', () => {
        const rows = marginRows([{ customerId: 'acme', siteId: 'hq', currency: 'EUR', amount: 1.005 }], [{ customerId: 'acme', siteId: 'hq', currency: 'EUR', amount: 0.1 + 0.2 }])
        expect(rows).toEqual([{ customerId: 'acme', siteId: 'hq', currency: 'EUR', revenue: 1.01, cost: 0.3, margin: 0.71, marginPct: 70.3 }])
        // A margin of 0.99 on 200.00 is 0.495%, which rounds to 0.5% (and -0.5% for a loss of 0.99).
        expect(marginRows([{ customerId: 'a', siteId: '', currency: 'EUR', amount: 200 }], [{ customerId: 'a', siteId: '', currency: 'EUR', amount: 199.01 }])[0].marginPct).toBe(0.5)
        expect(marginRows([{ customerId: 'a', siteId: '', currency: 'EUR', amount: 200 }], [{ customerId: 'a', siteId: '', currency: 'EUR', amount: 200.99 }])[0].marginPct).toBe(-0.5)
    })
})

describe('labourCost', () => {
    it("takes a work order's own labour cost, an explicit 0 included, and the visit cost only when it is blank", () => {
        expect(labourCost('180', 250)).toBe(180)
        expect(labourCost('0', 250)).toBe(0)
        expect(labourCost('0.00', 250)).toBe(0)
        expect(labourCost('', 250)).toBe(250)
        expect(labourCost('  ', 250)).toBe(250)
    })
})
