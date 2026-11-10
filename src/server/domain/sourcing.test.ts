import { describe, expect, it, vi } from 'vitest'
import { andEachClause } from './encoded-query'
import { stagesQuery } from './lifecycle'
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
    sparePoolShortfall,
    stillToBuy,
    type StockCandidate,
    stockQueries,
    type StockScope,
    type StockUnit,
} from './sourcing'

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

describe('stockQueries', () => {
    const lease = 'x_daas_ham_lease.end_action'
    const base = `model=m1^x_daas_ham_order_lineISEMPTY^${lease}!=return^OR${lease}ISEMPTY`
    const type = 'stockroom.x_daas_ham_stockroom_type'
    const provider = `${base}^${type}INcentral_depot,staging_centre`
    const fleet = (query: string) => andEachClause(query, 'x_daas_ham_fleet=true')
    const free = fleet(stagesQuery(['available'], provider))
    const pool = fleet(stagesQuery(['spare_pool'], `${provider}^company=acme`))
    const queries = (scope: StockScope) => stockQueries(scope).map((found) => found.query)

    it("asks for the Customer's own stock and free stock only, one query per source in priority order", () => {
        expect(stockQueries({ modelId: 'm1', customerId: 'acme', siteId: 'hq', purpose: 'new' })).toEqual([
            { source: 'spare_pool', query: pool },
            { source: 'central_stock', query: free },
        ])
    })

    it("adds the Customer's site stockroom stock at the Site or one of its Rooms for a replacement, first", () => {
        const [site, ...rest] = stockQueries({ modelId: 'm1', customerId: 'acme', siteId: 'hq', purpose: 'replace' })
        expect(rest.map((found) => found.query)).toEqual([pool, free])
        const siteStockroom = 'stockroom.x_daas_ham_stockroom_type=customer_site^stockroom.x_daas_ham_customer=acme'
        const atSite = 'stockroom.location=hq^ORstockroom.location.parent=hq'
        expect(site.source).toBe('customer_site_stock')
        expect(site.query).toBe(fleet(stagesQuery(['available', 'spare_pool'], `${base}^${siteStockroom}^${atSite}`)))
    })

    it("finds no hot spare at another of the Customer's Sites, nor another Customer's spares, in any clause", () => {
        const [site, pooled] = queries({ modelId: 'm1', customerId: 'acme', siteId: 'store-42', purpose: 'replace' })
        for (const clause of site.split('^NQ')) {
            expect(clause).toContain('^stockroom.x_daas_ham_customer=acme^stockroom.location=store-42^ORstockroom.location.parent=store-42')
        }
        for (const clause of pooled.split('^NQ')) expect(clause.split('^')).toContain('company=acme')
    })

    it('asks for free stock only when stock is sought for no Customer (the spare-pool top-up)', () => {
        expect(stockQueries(freeStockOf('m1'))).toEqual([{ source: 'central_stock', query: free }])
    })

    it('asks for fleet assets only, in every clause of every query (ADR 0016)', () => {
        for (const purpose of ['new', 'replace'] as const) {
            for (const query of queries({ modelId: 'm1', customerId: 'acme', siteId: 'hq', purpose })) {
                for (const clause of query.split('^NQ')) expect(clause.split('^')).toContain('x_daas_ham_fleet=true')
            }
        }
    })

    it("counts stock in the Provider's own NaaS stockrooms only as central stock or spares: no other type, nor none", () => {
        const [pooled, central] = queries({ modelId: 'm1', customerId: 'acme', siteId: 'hq', purpose: 'new' })
        for (const clause of [...pooled.split('^NQ'), ...central.split('^NQ')]) {
            expect(clause.split('^')).toContain(`${type}INcentral_depot,staging_centre`)
            expect(clause).not.toContain(`${type}ISEMPTY`)
        }
    })

    it('leaves stock of a lease being returned to its Lessor out of every clause of every query', () => {
        for (const purpose of ['new', 'replace'] as const) {
            for (const query of queries({ modelId: 'm1', customerId: 'acme', siteId: 'hq', purpose })) {
                for (const clause of query.split('^NQ')) expect(clause).toContain(`^${lease}!=return^OR${lease}ISEMPTY`)
            }
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

describe('sparePoolShortfall', () => {
    it('is the spares needed to reach the ratio of deployed assets, rounded up', () => {
        expect(sparePoolShortfall({ deployed: 41, reserved: 1, ratio: 0.05 })).toBe(2)
        expect(sparePoolShortfall({ deployed: 40, reserved: 5, ratio: 0.05 })).toBe(0)
        expect(sparePoolShortfall({ deployed: 0, reserved: 0, ratio: 0.05 })).toBe(0)
    })
})

describe('reservedSparesQuery', () => {
    const lease = 'x_daas_ham_lease.end_action'

    const notLessorBound = `${lease}!=return^OR${lease}ISEMPTY`
    const clauses = reservedSparesQuery('acme').split('^NQ')

    it("counts the Customer's spare-pool units, leaving out those bound for their Lessor as sourcing does", () => {
        const pool = andEachClause(stagesQuery(['spare_pool'], `company=acme^${notLessorBound}`), 'x_daas_ham_fleet=true')
        expect(clauses).toEqual(expect.arrayContaining(pool.split('^NQ')))
        const [poolStock] = stockQueries({ modelId: 'm1', customerId: 'acme', siteId: 'hq', purpose: 'new' })
        expect(poolStock.query).toContain(`^${notLessorBound}`)
    })

    it("counts the Customer's units in transfer on no Order line, which go back to the pool, in both of its combinations", () => {
        const transfer = andEachClause(
            stagesQuery(['in_transfer'], `company=acme^${notLessorBound}^x_daas_ham_order_lineISEMPTY`),
            'x_daas_ham_fleet=true',
        )
        expect(transfer.split('^NQ')).toHaveLength(2)
        expect(clauses).toEqual(expect.arrayContaining(transfer.split('^NQ')))
        // Nothing else: the pool's one combination and the transfer's two, each a fleet asset of the Customer.
        expect(clauses).toHaveLength(3)
        for (const clause of clauses) expect(clause.split('^')).toEqual(expect.arrayContaining(['company=acme', 'x_daas_ham_fleet=true']))
    })

    it('leaves out a unit in transfer on an Order line: sourcing moves it to staging for that line', () => {
        const transferClauses = clauses.filter((clause) => !clause.includes('substatus=reserved_spare_pool'))
        expect(transferClauses).toHaveLength(2)
        for (const clause of transferClauses) expect(clause).toContain('^x_daas_ham_order_lineISEMPTY')
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
        expect(candidateLimit(1)).toBe(55)
        expect(candidateLimit(20)).toBe(150)
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
