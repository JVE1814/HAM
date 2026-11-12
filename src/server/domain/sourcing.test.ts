import { describe, expect, it, vi } from 'vitest'
import { ALL_STAGES, type Stage } from './lifecycle'
import {
    candidateLimit,
    lineShortfall,
    needsTransfer,
    planSourcing,
    type PurchaseResult,
    shortfallOutcome,
    shortfallRouteFor,
    sourcingPurpose,
    type SourcingRequest,
    type SourcingScope,
    stillToBuy,
    stockQueries,
} from './sourcing'
import type { StockCandidate } from './stock'
import { recordMatches as matches } from '../test-support/encoded-query'
import { assetIn, type SampleRecord } from '../test-support/stored-asset'

/** What the queries for a replacement for Acme at its HQ Site find, each unit under the Source of its query. */
const stock: StockCandidate[] = [
    { assetId: 'central-1', stockroomId: 'depot', source: 'central_stock' },
    { assetId: 'central-2', stockroomId: 'depot', source: 'central_stock' },
    { assetId: 'pool-1', stockroomId: 'depot', source: 'spare_pool' },
    { assetId: 'site-1', stockroomId: 'acme-hq', source: 'customer_site_stock' },
    { assetId: 'staging-1', stockroomId: 'lab', source: 'central_stock' },
]

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
    })

    it('serves replacements from the hot spare at the customer site first, buying none once stock covers them', () => {
        const plan = planSourcing(acme({ modelId: 'c9300', quantity: 2, purpose: 'replace' }), stock)
        expect(plan.picks).toEqual([
            { assetId: 'site-1', source: 'customer_site_stock' },
            { assetId: 'pool-1', source: 'spare_pool' },
        ])
        expect(plan.summary).toBe('1 from site stock, 1 from spare pool')
    })

    it('leaves a hot spare where it is for a new install: site stock serves replacements only', () => {
        const plan = planSourcing(acme({ modelId: 'c9300', quantity: 5, purpose: 'new' }), stock)
        expect(plan.picks.map((p) => p.assetId)).not.toContain('site-1')
    })


    it('summarises where the line will come from', () => {
        const plan = planSourcing(acme({ modelId: 'c9300', quantity: 5, purpose: 'new' }), stock)
        expect(plan.summary).toBe('1 from spare pool, 3 from central stock, 1 to purchase')
    })
})


const STOCKROOM_TYPE = 'stockroom.x_daas_ham_stockroom_type'
const LEASE_END = 'x_daas_ham_lease.end_action'
const unit = (stage: Stage, fields: SampleRecord = {}) =>
    assetIn(stage, { x_daas_ham_fleet: 'true', model: 'm1', x_daas_ham_order_line: '', [STOCKROOM_TYPE]: 'central_depot', ...fields })
const IN_TRANSIT_RESERVED = { install_status: '9', substatus: 'reserved' }

describe('stockQueries', () => {
    const forAcme: SourcingScope = { modelId: 'm1', customerId: 'acme', siteId: 'hq', purpose: 'new' }
    const replacement: SourcingScope = { ...forAcme, purpose: 'replace' }
    const free = unit('available')
    const acmeSpare = unit('spare_pool', { company: 'acme', [STOCKROOM_TYPE]: 'staging_centre' })
    const siteSpare = (location: SampleRecord) =>
        unit('spare_pool', { company: 'acme', [STOCKROOM_TYPE]: 'customer_site', 'stockroom.x_daas_ham_customer': 'acme', ...location })
    const atHq = siteSpare({ 'stockroom.location': 'hq' })
    const sources = (scope: SourcingScope) => stockQueries(scope).map(({ source }) => source)
    const sourcesOf = (scope: SourcingScope, asset: SampleRecord) =>
        stockQueries(scope)
            .filter(({ query }) => matches(query, asset))
            .map(({ source }) => source)

    it("finds the Customer's spares as its Spare pool and free stock as central stock, one query per Source in priority order", () => {
        expect(sources(forAcme)).toEqual(['spare_pool', 'central_stock'])
        expect(sourcesOf(forAcme, acmeSpare)).toEqual(['spare_pool'])
        expect(sourcesOf(forAcme, free)).toEqual(['central_stock'])
        expect(sourcesOf(forAcme, unit('available', { [STOCKROOM_TYPE]: 'staging_centre' }))).toEqual(['central_stock'])
    })

    it('takes only central stock for an Order with no Customer, whose blank would match every unowned spare', () => {
        const noCustomer: SourcingScope = { ...replacement, customerId: '' }
        expect(sources(noCustomer)).toEqual(['central_stock'])
        expect(sourcesOf(noCustomer, { ...acmeSpare, company: '' })).toEqual([])
    })

    it("finds no other Customer's spares, no unit of another Model or on an Order line, and no unit in another stage", () => {
        expect(sourcesOf(forAcme, { ...acmeSpare, company: 'globex' })).toEqual([])
        for (const stock of [free, acmeSpare, atHq]) {
            expect(sourcesOf(replacement, { ...stock, model: 'm2' })).toEqual([])
            expect(sourcesOf(replacement, { ...stock, x_daas_ham_order_line: 'line1' })).toEqual([])
        }
        const notStock = [...ALL_STAGES.filter((stage) => stage !== 'available' && stage !== 'spare_pool').map((stage) => assetIn(stage)), IN_TRANSIT_RESERVED]
        for (const stage of notStock) {
            expect(sourcesOf(replacement, { ...acmeSpare, ...stage }), JSON.stringify(stage)).toEqual([])
            expect(sourcesOf(replacement, { ...atHq, ...stage }), JSON.stringify(stage)).toEqual([])
        }
    })

    it("adds the stock in the Customer's site stockroom at the Site or one of its Rooms for a replacement, first", () => {
        expect(sources(replacement)).toEqual(['customer_site_stock', 'spare_pool', 'central_stock'])
        expect(sourcesOf(replacement, atHq)).toEqual(['customer_site_stock'])
        expect(sourcesOf(replacement, siteSpare({ 'stockroom.location': 'hq-mdf', 'stockroom.location.parent': 'hq' }))).toEqual(['customer_site_stock'])
        expect(sourcesOf(replacement, { ...atHq, ...assetIn('available') })).toEqual(['customer_site_stock'])
        expect(sourcesOf(replacement, acmeSpare)).toEqual(['spare_pool'])
        expect(sourcesOf(replacement, free)).toEqual(['central_stock'])
        expect(sourcesOf(forAcme, atHq)).toEqual([])
    })

    it("finds no hot spare at another of the Customer's Sites, nor in another Customer's site stockroom", () => {
        expect(sourcesOf(replacement, siteSpare({ 'stockroom.location': 'store-42' }))).toEqual([])
        expect(sourcesOf(replacement, siteSpare({ 'stockroom.location': 'store-42-mdf', 'stockroom.location.parent': 'store-42' }))).toEqual([])
        expect(sourcesOf(replacement, { ...atHq, 'stockroom.x_daas_ham_customer': 'globex' })).toEqual([])
    })


    it('finds fleet assets only, whatever the Source (ADR 0016)', () => {
        for (const stock of [free, acmeSpare, atHq]) {
            expect(sourcesOf(replacement, { ...stock, x_daas_ham_fleet: 'false' })).toEqual([])
            expect(sourcesOf(replacement, { ...stock, x_daas_ham_fleet: '' })).toEqual([])
        }
    })

    it("counts stock in the Provider's own NaaS stockrooms only as central stock or spares: in no other type, nor in none", () => {
        for (const type of ['customer_site', '', 'it_storeroom']) {
            expect(sourcesOf(forAcme, { ...free, [STOCKROOM_TYPE]: type }), type).toEqual([])
            expect(sourcesOf(forAcme, { ...acmeSpare, [STOCKROOM_TYPE]: type }), type).toEqual([])
        }
    })

    it('leaves stock of a lease being returned to its Lessor out, whatever the Source, and keeps stock of any other lease or of none', () => {
        for (const stock of [free, acmeSpare, atHq]) {
            expect(sourcesOf(replacement, { ...stock, [LEASE_END]: 'return' })).toEqual([])
            for (const endAction of ['undecided', 'extend', 'buyout', '']) expect(sourcesOf(replacement, { ...stock, [LEASE_END]: endAction }), endAction).toHaveLength(1)
        }
    })
})

describe('shortfallOutcome', () => {
    const line = { planSummary: '1 from central stock, 2 to purchase', missing: 2 }
    const purchase = (result: PurchaseResult = { ok: true, poId: 'po1' }) => vi.fn(() => result)

    it('sources a line with nothing left to buy as planned, buying nothing', () => {
        const buy = purchase()
        expect(shortfallOutcome('none', { ...line, missing: 0 }, buy)).toEqual({ stage: 'sourced', summary: line.planSummary, purchased: 0 })
        expect(buy).not.toHaveBeenCalled()
    })

    it('notes an OEM advance replacement without buying anything', () => {
        const buy = purchase()
        expect(shortfallOutcome('oem_advance_replacement', { ...line, missing: 1 }, buy)).toEqual({
            stage: 'sourced',
            summary: '1 from central stock, 2 to purchase (OEM advance replacement under RMA)',
            purchased: 0,
        })
        expect(buy).not.toHaveBeenCalled()
    })

    it('buys once, links the purchase order and counts its units as just put on order', () => {
        const buy = purchase()
        expect(shortfallOutcome('purchase', line, buy)).toEqual({ stage: 'sourced', summary: line.planSummary, purchaseOrder: 'po1', purchased: 2 })
        expect(buy).toHaveBeenCalledOnce()
    })

    it('leaves the line waiting for stock, saying why, when no purchase order comes of it', () => {
        for (const reason of ['Procurement did not create it', 'set x_daas_ham.staging.default_stockroom']) {
            expect(shortfallOutcome('purchase', line, purchase({ ok: false, reason }))).toEqual({
                stage: 'awaiting_stock',
                summary: `1 from central stock, 2 to purchase (no purchase order: ${reason})`,
                purchased: 0,
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
            purchased: 0,
        })
    })

    it('still buys the real shortfall when picked stock could not be moved', () => {
        const buy = purchase()
        const outcome = shortfallOutcome('purchase', { ...line, unmoved: [{ units: 1, from: 'Depot North', reason: 'Inventory did not create it' }] }, buy)
        expect(outcome).toMatchObject({ stage: 'awaiting_stock', purchaseOrder: 'po1', purchased: 2 })
        expect(buy).toHaveBeenCalledOnce()
    })
})

describe('sourcingPurpose', () => {
    it('sources a device replace as a replacement and every other Order as a new install', () => {
        expect(sourcingPurpose('device_replace')).toBe('replace')
        for (const type of ['site_rollout', 'device_add', 'temporary', 'refresh', ''] as const) expect(sourcingPurpose(type)).toBe('new')
    })
})

describe('candidateLimit', () => {
    it('reads more candidates than the shortfall, so claims lost to another run leave enough', () => {
        for (const shortfall of [1, 2, 20, 500]) expect(candidateLimit(shortfall)).toBeGreaterThan(shortfall)
    })

    it('reads fewer candidates for a smaller need, so a large stock is not read whole for it', () => {
        expect(candidateLimit(1)).toBeLessThan(candidateLimit(20))
        expect(candidateLimit(20)).toBeLessThan(candidateLimit(500))
    })
})

describe('lineShortfall', () => {
    it('is what the line asks for less its units, its units on order and its awaited OEM replacements', () => {
        expect(lineShortfall({ quantity: 10, allocated: 3, onOrder: 2, awaitedRmas: 1 })).toBe(4)
    })

    it('is zero or less for a line with nothing left to source', () => {
        expect(lineShortfall({ quantity: 2, allocated: 2, onOrder: 0, awaitedRmas: 0 })).toBe(0)
        expect(lineShortfall({ quantity: 2, allocated: 2, onOrder: 1, awaitedRmas: 0 })).toBe(-1)
    })
})

describe('stillToBuy', () => {
    it('buys what the pass planned while the line still misses it', () => {
        expect(stillToBuy(3, 3, 0)).toBe(3)
    })

    it('buys less when a receipt met part of the need since the line was counted', () => {
        expect(stillToBuy(3, 2, 0)).toBe(2)
        expect(stillToBuy(3, 0, 0)).toBe(0)
    })

    it('does not buy the stock the pass put back for want of a transfer order', () => {
        expect(stillToBuy(1, 3, 2)).toBe(1)
        expect(stillToBuy(1, 2, 2)).toBe(0)
    })

    it('leaves a need grown meanwhile to a later pass', () => {
        expect(stillToBuy(1, 5, 0)).toBe(1)
    })

    it('never buys a negative quantity', () => {
        expect(stillToBuy(2, -1, 0)).toBe(0)
    })
})

describe('needsTransfer', () => {
    it('transfers stock picked outside the staging centre', () => {
        expect(needsTransfer('depot', 'lab')).toBe(true)
    })

    it('stages stock where it is at the staging centre, in no stockroom, or while no staging centre is set', () => {
        expect(needsTransfer('lab', 'lab')).toBe(false)
        expect(needsTransfer('', 'lab')).toBe(false)
        expect(needsTransfer('depot', '')).toBe(false)
    })
})

describe('shortfallRouteFor', () => {
    const today = '2026-11-09'

    it('asks the OEM for an advance replacement of a covered unit of the same Model', () => {
        expect(shortfallRouteFor('c9300', { modelId: 'c9300', coverageEnd: '2026-11-09' }, today, 1)).toBe('oem_advance_replacement')
    })

    it('purchases when the coverage has ended, or the unit has none', () => {
        expect(shortfallRouteFor('c9300', { modelId: 'c9300', coverageEnd: '2026-11-08' }, today, 1)).toBe('purchase')
        expect(shortfallRouteFor('c9300', { modelId: 'c9300', coverageEnd: '' }, today, 1)).toBe('purchase')
    })

    it('purchases a replacement of another Model, covered or not', () => {
        expect(shortfallRouteFor('c9300', { modelId: 'c9200', coverageEnd: '2030-01-01' }, today, 1)).toBe('purchase')
    })

    it('purchases for a line that replaces no failed unit', () => {
        expect(shortfallRouteFor('c9300', null, today, 2)).toBe('purchase')
    })

    it('routes nothing when nothing is missing', () => {
        expect(shortfallRouteFor('c9300', { modelId: 'c9300', coverageEnd: '2030-01-01' }, today, 0)).toBe('none')
        expect(shortfallRouteFor('c9300', null, today, -1)).toBe('none')
    })
})
