import { describe, expect, it, vi } from 'vitest'
import { stagesQuery } from './lifecycle'
import {
    freeStockOf,
    pickForSparePool,
    planSourcing,
    shortfallOutcome,
    sparePoolShortfall,
    stockQueries,
    type PurchaseResult,
    type SourcingRequest,
    type StockCandidate,
} from './sourcing'

const depot = { stockroomId: 'depot', stockroomType: 'central_depot', siteId: '' } as const
const lab = { stockroomId: 'lab', stockroomType: 'staging_centre', siteId: '' } as const
const hqSpares = { stockroomId: 'acme-hq', stockroomType: 'customer_site', siteId: 'hq' } as const
const stock: StockCandidate[] = [
    { assetId: 'central-1', modelId: 'c9300', stage: 'available', ...depot, reservedFor: '' },
    { assetId: 'central-2', modelId: 'c9300', stage: 'available', ...depot, reservedFor: '' },
    { assetId: 'pool-1', modelId: 'c9300', stage: 'spare_pool', ...depot, reservedFor: 'acme' },
    { assetId: 'site-1', modelId: 'c9300', stage: 'spare_pool', ...hqSpares, reservedFor: 'acme' },
    { assetId: 'other-pool', modelId: 'c9300', stage: 'spare_pool', ...depot, reservedFor: 'globex' },
    { assetId: 'staging-1', modelId: 'c9300', stage: 'available', ...lab, reservedFor: '' },
    { assetId: 'ap-1', modelId: 'mr46', stage: 'available', ...depot, reservedFor: '' },
]

/** A request for Acme at its HQ Site. */
const acme = (request: Pick<SourcingRequest, 'modelId' | 'quantity' | 'purpose'>): SourcingRequest => ({
    ...request,
    customerId: 'acme',
    siteId: 'hq',
})

describe('planSourcing', () => {
    it('serves new installs from the customer spare pool, then central stock, then purchase', () => {
        const plan = planSourcing(acme({ modelId: 'c9300', quantity: 5, purpose: 'new' }), stock)
        expect(plan.picks).toEqual([
            { assetId: 'pool-1', source: 'spare_pool' },
            { assetId: 'central-1', source: 'central_stock' },
            { assetId: 'central-2', source: 'central_stock' },
            { assetId: 'staging-1', source: 'central_stock' },
        ])
        expect(plan.toPurchase).toBe(1)
    })

    it('serves replacements from the hot spare at the customer site first', () => {
        const plan = planSourcing(acme({ modelId: 'c9300', quantity: 2, purpose: 'replace' }), stock)
        expect(plan.picks).toEqual([
            { assetId: 'site-1', source: 'customer_site_stock' },
            { assetId: 'pool-1', source: 'spare_pool' },
        ])
        expect(plan.toPurchase).toBe(0)
    })

    it("does not install a hot spare at another of the Customer's Sites in place", () => {
        const atStore = { ...acme({ modelId: 'c9300', quantity: 2, purpose: 'replace' }), siteId: 'store-42' }
        const plan = planSourcing(atStore, stock)
        expect(plan.picks).toEqual([
            { assetId: 'pool-1', source: 'spare_pool' },
            { assetId: 'central-1', source: 'central_stock' },
        ])
    })

    it("never takes another customer's spares or another model", () => {
        const plan = planSourcing(acme({ modelId: 'mr46', quantity: 2, purpose: 'new' }), stock)
        expect(plan.picks.map((p) => p.assetId)).toEqual(['ap-1'])
        expect(plan.toPurchase).toBe(1)
    })

    it('summarises where the line will come from', () => {
        const plan = planSourcing(acme({ modelId: 'c9300', quantity: 5, purpose: 'new' }), stock)
        expect(plan.summary).toBe('1 from spare pool, 3 from central stock, 1 to purchase')
    })
})

describe('stockQueries', () => {
    const base = 'model=m1^x_daas_ham_order_lineISEMPTY'
    const type = 'stockroom.x_daas_ham_stockroom_type'
    const provider = `${base}^${type}!=customer_site^OR${type}ISEMPTY`
    const free = stagesQuery(['available'], provider)
    const pool = stagesQuery(['spare_pool'], `${provider}^company=acme`)

    it("asks for the Customer's own stock and free stock only, one query per source in priority order", () => {
        expect(stockQueries({ modelId: 'm1', customerId: 'acme', siteId: 'hq', purpose: 'new' })).toEqual([pool, free])
    })

    it("adds the Customer's site stockroom stock at the Site or one of its Rooms for a replacement, first", () => {
        const [site, ...rest] = stockQueries({ modelId: 'm1', customerId: 'acme', siteId: 'hq', purpose: 'replace' })
        expect(rest).toEqual([pool, free])
        const siteStockroom = 'stockroom.x_daas_ham_stockroom_type=customer_site^stockroom.x_daas_ham_customer=acme'
        const atSite = 'stockroom.location=hq^ORstockroom.location.parent=hq'
        expect(site).toBe(stagesQuery(['available', 'spare_pool'], `${base}^${siteStockroom}^${atSite}`))
    })

    it('asks for free stock only when stock is sought for no Customer (the spare-pool top-up)', () => {
        expect(stockQueries(freeStockOf('m1'))).toEqual([free])
    })
})

describe('shortfallOutcome', () => {
    const line = { planSummary: '1 from central stock, 2 to purchase', missing: 2, onOrder: 3 }
    const purchase = (result: PurchaseResult = { ok: true, poId: 'po1' }) => vi.fn(() => result)

    it('sources a line with nothing left to buy as planned, buying nothing', () => {
        const buy = purchase()
        expect(shortfallOutcome('none', { ...line, missing: 0 }, buy)).toEqual({ stage: 'sourced', summary: line.planSummary, quantityToPurchase: 3 })
        expect(buy).not.toHaveBeenCalled()
    })

    it('notes an OEM advance replacement without buying anything', () => {
        const buy = purchase()
        expect(shortfallOutcome('oem_advance_replacement', { ...line, missing: 1 }, buy)).toEqual({
            stage: 'sourced',
            summary: '1 from central stock, 2 to purchase (OEM advance replacement under RMA)',
            quantityToPurchase: 3,
        })
        expect(buy).not.toHaveBeenCalled()
    })

    it('buys once, links the purchase order and counts its units on top of those already on order', () => {
        const buy = purchase()
        expect(shortfallOutcome('purchase', line, buy)).toEqual({ stage: 'sourced', summary: line.planSummary, purchaseOrder: 'po1', quantityToPurchase: 5 })
        expect(buy).toHaveBeenCalledOnce()
    })

    it('leaves the line waiting for stock, saying why, when no purchase order comes of it', () => {
        for (const reason of ['Procurement did not create it', 'set x_daas_ham.staging.default_stockroom']) {
            expect(shortfallOutcome('purchase', line, purchase({ ok: false, reason }))).toEqual({
                stage: 'awaiting_stock',
                summary: `1 from central stock, 2 to purchase (no purchase order: ${reason})`,
                quantityToPurchase: 3,
            })
        }
    })

    it('leaves the line waiting for stock, saying why, when picked stock could not be moved to staging', () => {
        const unmoved = [
            { units: 2, from: 'North', reason: 'not created' },
            { units: 1, from: 'South', reason: 'lines missing' },
        ]
        expect(shortfallOutcome('none', { ...line, missing: 0, unmoved }, purchase())).toEqual({
            stage: 'awaiting_stock',
            summary: '1 from central stock, 2 to purchase (no transfer order for 2 from North: not created; no transfer order for 1 from South: lines missing)',
            quantityToPurchase: 3,
        })
    })

    it('still buys the real shortfall when picked stock could not be moved', () => {
        const buy = purchase()
        const outcome = shortfallOutcome('purchase', { ...line, unmoved: [{ units: 1, from: 'Depot North', reason: 'Inventory did not create it' }] }, buy)
        expect(outcome).toMatchObject({ stage: 'awaiting_stock', purchaseOrder: 'po1', quantityToPurchase: 5 })
        expect(buy).toHaveBeenCalledOnce()
    })
})

describe('sparePoolShortfall', () => {
    it('is the spares needed to reach the ratio of deployed assets, rounded up', () => {
        expect(sparePoolShortfall({ deployed: 41, reserved: 1, ratio: 0.05 })).toBe(2)
        expect(sparePoolShortfall({ deployed: 40, reserved: 5, ratio: 0.05 })).toBe(0)
        expect(sparePoolShortfall({ deployed: 0, reserved: 0, ratio: 0.05 })).toBe(0)
    })
})

describe('pickForSparePool', () => {
    it('takes free central stock only, never reserved or customer-site stock', () => {
        expect(pickForSparePool(stock, 'c9300', 5)).toEqual(['central-1', 'central-2', 'staging-1'])
        expect(pickForSparePool(stock, 'c9300', 1)).toEqual(['central-1'])
    })
})
