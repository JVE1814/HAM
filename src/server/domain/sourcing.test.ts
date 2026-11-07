import { describe, expect, it, vi } from 'vitest'
import { pickForSparePool, planSourcing, shortfallOutcome, sparePoolShortfall, type PurchaseResult, type StockCandidate } from './sourcing'

const stock: StockCandidate[] = [
    { assetId: 'central-1', modelId: 'c9300', stage: 'available', stockroomId: 'depot', stockroomType: 'central_depot', reservedFor: '' },
    { assetId: 'central-2', modelId: 'c9300', stage: 'available', stockroomId: 'depot', stockroomType: 'central_depot', reservedFor: '' },
    { assetId: 'pool-1', modelId: 'c9300', stage: 'spare_pool', stockroomId: 'depot', stockroomType: 'central_depot', reservedFor: 'acme' },
    { assetId: 'site-1', modelId: 'c9300', stage: 'spare_pool', stockroomId: 'acme-hq', stockroomType: 'customer_site', reservedFor: 'acme' },
    { assetId: 'other-pool', modelId: 'c9300', stage: 'spare_pool', stockroomId: 'depot', stockroomType: 'central_depot', reservedFor: 'globex' },
    { assetId: 'staging-1', modelId: 'c9300', stage: 'available', stockroomId: 'lab', stockroomType: 'staging_centre', reservedFor: '' },
    { assetId: 'ap-1', modelId: 'mr46', stage: 'available', stockroomId: 'depot', stockroomType: 'central_depot', reservedFor: '' },
]

describe('planSourcing', () => {
    it('serves new installs from the customer spare pool, then central stock, then purchase', () => {
        const plan = planSourcing({ modelId: 'c9300', quantity: 5, customerId: 'acme', purpose: 'new' }, stock)
        expect(plan.picks).toEqual([
            { assetId: 'pool-1', source: 'spare_pool' },
            { assetId: 'central-1', source: 'central_stock' },
            { assetId: 'central-2', source: 'central_stock' },
            { assetId: 'staging-1', source: 'central_stock' },
        ])
        expect(plan.toPurchase).toBe(1)
    })

    it('serves replacements from the hot spare at the customer site first', () => {
        const plan = planSourcing({ modelId: 'c9300', quantity: 2, customerId: 'acme', purpose: 'replace' }, stock)
        expect(plan.picks).toEqual([
            { assetId: 'site-1', source: 'customer_site_stock' },
            { assetId: 'pool-1', source: 'spare_pool' },
        ])
        expect(plan.toPurchase).toBe(0)
    })

    it("never takes another customer's spares or another model", () => {
        const plan = planSourcing({ modelId: 'mr46', quantity: 2, customerId: 'acme', purpose: 'new' }, stock)
        expect(plan.picks.map((p) => p.assetId)).toEqual(['ap-1'])
        expect(plan.toPurchase).toBe(1)
    })

    it('summarises where the line will come from', () => {
        const plan = planSourcing({ modelId: 'c9300', quantity: 5, customerId: 'acme', purpose: 'new' }, stock)
        expect(plan.summary).toBe('1 from spare pool, 3 from central stock, 1 to purchase')
    })
})

describe('shortfallOutcome', () => {
    const line = { planSummary: '1 from central stock, 2 to purchase', missing: 2, onOrder: 3 }
    const purchasing = (stagingStockroomId: string, result: PurchaseResult = { ok: true, poId: 'po1' }) => ({
        stagingStockroomId,
        purchase: vi.fn((_shipToStockroomId: string) => result),
        noStagingStockroom: vi.fn(() => 'set x_daas_ham.staging.default_stockroom'),
    })

    it('sources a line with nothing left to buy as planned, even while no staging stockroom is set', () => {
        const procurement = purchasing('')
        expect(shortfallOutcome('none', { ...line, missing: 0 }, procurement)).toEqual({ stage: 'sourced', summary: line.planSummary, quantityToPurchase: 3 })
        expect(procurement.purchase).not.toHaveBeenCalled()
        expect(procurement.noStagingStockroom).not.toHaveBeenCalled()
    })

    it('notes an OEM advance replacement without buying anything, even while no staging stockroom is set', () => {
        const procurement = purchasing('')
        expect(shortfallOutcome('oem_advance_replacement', { ...line, missing: 1 }, procurement)).toEqual({
            stage: 'sourced',
            summary: '1 from central stock, 2 to purchase (OEM advance replacement under RMA)',
            quantityToPurchase: 3,
        })
        expect(procurement.purchase).not.toHaveBeenCalled()
        expect(procurement.noStagingStockroom).not.toHaveBeenCalled()
    })

    it('buys for the staging stockroom, links the purchase order and counts its units on top of those already on order', () => {
        const procurement = purchasing('lab')
        expect(shortfallOutcome('purchase', line, procurement)).toEqual({ stage: 'sourced', summary: line.planSummary, purchaseOrder: 'po1', quantityToPurchase: 5 })
        expect(procurement.purchase).toHaveBeenCalledExactlyOnceWith('lab')
        expect(procurement.noStagingStockroom).not.toHaveBeenCalled()
    })

    it('leaves the line waiting for stock, saying why, when Procurement creates no purchase order', () => {
        const procurement = purchasing('lab', { ok: false, reason: 'Procurement did not create it' })
        expect(shortfallOutcome('purchase', line, procurement)).toEqual({
            stage: 'awaiting_stock',
            summary: '1 from central stock, 2 to purchase (no purchase order: Procurement did not create it)',
            quantityToPurchase: 3,
        })
        expect(procurement.noStagingStockroom).not.toHaveBeenCalled()
    })

    it('requests no purchase while no staging stockroom is set and leaves the line waiting for stock, saying why', () => {
        const procurement = purchasing('')
        expect(shortfallOutcome('purchase', line, procurement)).toEqual({
            stage: 'awaiting_stock',
            summary: '1 from central stock, 2 to purchase (no purchase order: set x_daas_ham.staging.default_stockroom)',
            quantityToPurchase: 3,
        })
        expect(procurement.purchase).not.toHaveBeenCalled()
        expect(procurement.noStagingStockroom).toHaveBeenCalledOnce()
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
