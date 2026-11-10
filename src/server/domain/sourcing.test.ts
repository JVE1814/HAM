import { describe, expect, it, vi } from 'vitest'
import { ALL_STAGES, type Stage } from './lifecycle'
import {
    cancelledUnit,
    candidateLimit,
    freeStockOf,
    isClaimable,
    isFree,
    lineShortfall,
    lineStillOpen,
    needsTransfer,
    pickForSparePool,
    planSourcing,
    type PurchaseResult,
    reservedSparesQuery,
    shortfallOutcome,
    shortfallRouteFor,
    sourcingPurpose,
    type SourcingRequest,
    sparePoolLead,
    sparePools,
    sparePoolShortfall,
    stillToBuy,
    type StockCandidate,
    stockQueries,
    type StockScope,
    type StockUnit,
} from './sourcing'
import { recordMatches as matches } from '../test-support/encoded-query'
import { assetIn, type SampleRecord } from '../test-support/stored-asset'

/** What the queries for a replacement for Acme at its HQ Site find, each unit under the Source of its query. */
const stock: StockCandidate[] = [
    { assetId: 'central-1', modelId: 'c9300', stockroomId: 'depot', source: 'central_stock' },
    { assetId: 'central-2', modelId: 'c9300', stockroomId: 'depot', source: 'central_stock' },
    { assetId: 'pool-1', modelId: 'c9300', stockroomId: 'depot', source: 'spare_pool' },
    { assetId: 'site-1', modelId: 'c9300', stockroomId: 'acme-hq', source: 'customer_site_stock' },
    { assetId: 'staging-1', modelId: 'c9300', stockroomId: 'lab', source: 'central_stock' },
    { assetId: 'ap-1', modelId: 'mr46', stockroomId: 'depot', source: 'central_stock' },
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

    it('leaves a hot spare where it is for a new install: site stock serves replacements only', () => {
        const plan = planSourcing(acme({ modelId: 'c9300', quantity: 5, purpose: 'new' }), stock)
        expect(plan.picks.map((p) => p.assetId)).not.toContain('site-1')
    })

    it('never takes another Model', () => {
        const plan = planSourcing(acme({ modelId: 'mr46', quantity: 2, purpose: 'new' }), stock)
        expect(plan.picks.map((p) => p.assetId)).toEqual(['ap-1'])
        expect(plan.toPurchase).toBe(1)
    })

    it('summarises where the line will come from', () => {
        const plan = planSourcing(acme({ modelId: 'c9300', quantity: 5, purpose: 'new' }), stock)
        expect(plan.summary).toBe('1 from spare pool, 3 from central stock, 1 to purchase')
    })
})

describe('isFree and isClaimable', () => {
    const unit: StockUnit = { stage: 'available', orderLineId: '', leaseEndAction: '' }
    const inStock = ['available', 'spare_pool'] as const

    it('takes stock still in one of the stages and on no Order line', () => {
        expect(isClaimable(unit, inStock)).toBe(true)
        expect(isClaimable({ ...unit, stage: 'spare_pool', leaseEndAction: 'undecided' }, inStock)).toBe(true)
        expect(isFree({ ...unit, stage: 'reserved' }, inStock)).toBe(false)
        expect(isFree({ ...unit, stage: null }, inStock)).toBe(false)
        expect(isFree({ ...unit, orderLineId: 'line-1' }, inStock)).toBe(false)
    })

    it('never claims stock of a lease being returned to its Lessor, though it is free', () => {
        const returning: StockUnit = { ...unit, leaseEndAction: 'return' }
        expect(isFree(returning, inStock)).toBe(true)
        expect(isClaimable(returning, inStock)).toBe(false)
        for (const leaseEndAction of ['undecided', 'extend', 'buyout'] as const) {
            expect(isClaimable({ ...unit, leaseEndAction }, inStock)).toBe(true)
        }
    })
})

const STOCKROOM_TYPE = 'stockroom.x_daas_ham_stockroom_type'
const LEASE_END = 'x_daas_ham_lease.end_action'
/** A fleet asset of Model m1 on no Order line, in a central depot unless `fields` say otherwise. */
const unit = (stage: Stage, fields: SampleRecord = {}) =>
    assetIn(stage, { x_daas_ham_fleet: 'true', model: 'm1', x_daas_ham_order_line: '', [STOCKROOM_TYPE]: 'central_depot', ...fields })
const PENDING_TRANSFER = { install_status: '6', substatus: 'pending_transfer' }
const IN_TRANSIT_RESERVED = { install_status: '9', substatus: 'reserved' }

describe('stockQueries', () => {
    const forAcme: StockScope = { modelId: 'm1', customerId: 'acme', siteId: 'hq', purpose: 'new' }
    const replacement: StockScope = { ...forAcme, purpose: 'replace' }
    const free = unit('available')
    const acmeSpare = unit('spare_pool', { company: 'acme', [STOCKROOM_TYPE]: 'staging_centre' })
    /** A hot spare in Acme's site stockroom at the location given. */
    const siteSpare = (location: SampleRecord) =>
        unit('spare_pool', { company: 'acme', [STOCKROOM_TYPE]: 'customer_site', 'stockroom.x_daas_ham_customer': 'acme', ...location })
    const atHq = siteSpare({ 'stockroom.location': 'hq' })
    const sources = (scope: StockScope) => stockQueries(scope).map(({ source }) => source)
    /** The Sources whose query finds `asset`. */
    const sourcesOf = (scope: StockScope, asset: SampleRecord) =>
        stockQueries(scope)
            .filter(({ query }) => matches(query, asset))
            .map(({ source }) => source)

    it("finds the Customer's spares as its Spare pool and free stock as central stock, one query per Source in priority order", () => {
        expect(sources(forAcme)).toEqual(['spare_pool', 'central_stock'])
        expect(sourcesOf(forAcme, acmeSpare)).toEqual(['spare_pool'])
        expect(sourcesOf(forAcme, free)).toEqual(['central_stock'])
        expect(sourcesOf(forAcme, unit('available', { [STOCKROOM_TYPE]: 'staging_centre' }))).toEqual(['central_stock'])
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

    it('finds free stock only when stock is sought for no Customer (the spare-pool top-up)', () => {
        expect(sources(freeStockOf('m1'))).toEqual(['central_stock'])
        expect(sourcesOf(freeStockOf('m1'), free)).toEqual(['central_stock'])
        expect(sourcesOf(freeStockOf('m1'), acmeSpare)).toEqual([])
        expect(sourcesOf(freeStockOf('m1'), { ...acmeSpare, company: '' })).toEqual([])
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

describe('lineStillOpen', () => {
    it('is a line not yet shipped, cancelled or rejected, on an Order neither cancelled nor rejected', () => {
        expect(lineStillOpen({ lineStage: 'awaiting_stock', orderStage: 'sourcing' })).toBe(true)
        expect(lineStillOpen({ lineStage: 'ready_to_ship', orderStage: 'preparing' })).toBe(true)
        for (const lineStage of ['shipped', 'installed', 'in_service', 'cancelled']) {
            expect(lineStillOpen({ lineStage, orderStage: 'sourcing' })).toBe(false)
        }
        // A line whose cancel was refused stays open on its cancelled Order.
        for (const orderStage of ['cancelled', 'rejected']) {
            expect(lineStillOpen({ lineStage: 'awaiting_stock', orderStage })).toBe(false)
        }
    })
})

describe('sparePools', () => {
    const share = (agreementId: string, modelId: string, deployed: number, ratio: number) => ({ agreementId, modelId, deployed, ratio })

    it('sizes one pool per Model at the ratio of deployed assets, rounded up', () => {
        expect(sparePools([share('a1', 'c9300', 41, 0.05)])).toEqual([{ modelId: 'c9300', size: 3, agreementId: 'a1' }])
        expect(sparePools([share('a1', 'c9300', 40, 0.05)])).toEqual([{ modelId: 'c9300', size: 2, agreementId: 'a1' }])
        expect(sparePools([share('a1', 'c9300', 0, 0.05)])).toEqual([{ modelId: 'c9300', size: 0, agreementId: 'a1' }])
    })

    it("sizes a Model's pool from the units of all the Customer's Agreements, each at its own ratio, rounded up once", () => {
        // 10 × 0.05 + 10 × 0.05 = 1 spare, not one rounded up for each Agreement.
        expect(sparePools([share('a1', 'c9300', 10, 0.05), share('a2', 'c9300', 10, 0.05)])).toEqual([{ modelId: 'c9300', size: 1, agreementId: 'a1' }])
        // 20 × 0.05 + 30 × 0.1 = 4.
        expect(sparePools([share('a1', 'c9300', 20, 0.05), share('a2', 'c9300', 30, 0.1)])).toEqual([{ modelId: 'c9300', size: 4, agreementId: 'a2' }])
        // 1 × 0.05 + 1 × 0.1 = 0.15: one spare.
        expect(sparePools([share('a1', 'mr46', 1, 0.05), share('a2', 'mr46', 1, 0.1)])[0].size).toBe(1)
    })

    it('keeps each Model in a pool of its own', () => {
        const pools = sparePools([share('a1', 'c9300', 20, 0.05), share('a1', 'mr46', 30, 0.05), share('a2', 'mr46', 10, 0.1)])
        expect(pools).toEqual([
            { modelId: 'c9300', size: 1, agreementId: 'a1' },
            { modelId: 'mr46', size: 3, agreementId: 'a1' },
        ])
    })

    it('files new spares under the Agreement with the largest share, the first by sys_id on a tie', () => {
        expect(sparePools([share('a1', 'c9300', 10, 0.05), share('a2', 'c9300', 30, 0.05)])[0].agreementId).toBe('a2')
        expect(sparePools([share('b', 'c9300', 10, 0.1), share('a', 'c9300', 20, 0.05)])[0].agreementId).toBe('a')
        expect(sparePools([share('a', 'c9300', 20, 0.05), share('b', 'c9300', 10, 0.1)])[0].agreementId).toBe('a')
    })
})

describe('sparePoolShortfall', () => {
    it('is the spares a pool still needs, never below none', () => {
        expect(sparePoolShortfall(3, 1)).toBe(2)
        expect(sparePoolShortfall(2, 5)).toBe(0)
        expect(sparePoolShortfall(0, 0)).toBe(0)
    })
})

describe('sparePoolLead', () => {
    it("is the first of the Customer's Agreements by sys_id, so one row of the pass tops up their pools", () => {
        expect(sparePoolLead(['b2', 'a9', 'c1'])).toBe('a9')
        expect(sparePoolLead(['a9'])).toBe('a9')
        expect(sparePoolLead([])).toBe('')
    })
})

describe('reservedSparesQuery', () => {
    const query = reservedSparesQuery('acme')
    const pooled = unit('spare_pool', { company: 'acme' })
    const inTransfer = [PENDING_TRANSFER, IN_TRANSIT_RESERVED].map((stored) => ({ ...pooled, ...stored }))

    it("counts the Customer's fleet assets in its Spare pool, whatever their Model, and no other Customer's or the Provider IT's", () => {
        expect(matches(query, pooled)).toBe(true)
        expect(matches(query, { ...pooled, model: 'm2' })).toBe(true)
        expect(matches(query, { ...pooled, company: 'globex' })).toBe(false)
        expect(matches(query, { ...pooled, company: '' })).toBe(false)
        expect(matches(query, { ...pooled, x_daas_ham_fleet: 'false' })).toBe(false)
        expect(matches(query, { ...pooled, x_daas_ham_fleet: '' })).toBe(false)
    })

    it("counts the Customer's units in transfer on no Order line, which go back to the pool, in both of Inventory's combinations", () => {
        for (const spare of inTransfer) {
            expect(matches(query, spare), spare.substatus).toBe(true)
            expect(matches(query, { ...spare, company: 'globex' }), spare.substatus).toBe(false)
            expect(matches(query, { ...spare, x_daas_ham_fleet: 'false' }), spare.substatus).toBe(false)
        }
    })

    it('counts no unit of the Customer in any other stage', () => {
        expect(ALL_STAGES.filter((stage) => matches(query, { ...pooled, ...assetIn(stage) }))).toEqual(['spare_pool', 'in_transfer'])
    })

    it('leaves out a unit in transfer on an Order line: sourcing moves it to staging for that line', () => {
        for (const spare of inTransfer) expect(matches(query, { ...spare, x_daas_ham_order_line: 'line1' }), spare.substatus).toBe(false)
        // A unit still in the pool on an Order line (a hot spare a replacement takes at Ship) is counted until it leaves.
        expect(matches(query, { ...pooled, x_daas_ham_order_line: 'line1' })).toBe(true)
    })

    it('leaves out the units bound for their Lessor, as sourcing does, and keeps those of any other lease', () => {
        for (const spare of [pooled, ...inTransfer]) {
            expect(matches(query, { ...spare, [LEASE_END]: 'return' }), spare.substatus).toBe(false)
            for (const endAction of ['undecided', 'extend', 'buyout']) expect(matches(query, { ...spare, [LEASE_END]: endAction }), spare.substatus).toBe(true)
        }
    })
})

describe('pickForSparePool', () => {
    it('takes free central stock only, never reserved or customer-site stock', () => {
        expect(pickForSparePool(stock, 'c9300', 5)).toEqual(['central-1', 'central-2', 'staging-1'])
        expect(pickForSparePool(stock, 'c9300', 1)).toEqual(['central-1'])
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
        expect(stillToBuy(-1, 3, 0)).toBe(0)
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

describe('cancelledUnit', () => {
    it('leaves a hot spare in its Spare pool', () => {
        expect(cancelledUnit('spare_pool')).toBe('stays_spare')
    })

    it('leaves a unit in transfer where it is, to be free stock once Inventory lets it go', () => {
        expect(cancelledUnit('in_transfer')).toBe('stays_in_transfer')
    })

    it('makes any other unit free stock', () => {
        for (const stage of ['reserved', 'staging', 'staged', 'available', null] as const) expect(cancelledUnit(stage)).toBe('free_stock')
    })
})
