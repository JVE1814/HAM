import { describe, expect, it, vi } from 'vitest'
import { andEachClause } from './encoded-query'
import { stagesQuery } from './lifecycle'
import {
    advanceReplacementRma,
    freeStockOf,
    isClaimable,
    isFree,
    lineStillOpen,
    orderLineLockName,
    pickForSparePool,
    planSourcing,
    reservedSparesQuery,
    shortfallOutcome,
    sourcingLockName,
    sparePoolShortfall,
    stockQueries,
    type OpenRma,
    type PurchaseResult,
    type SourcingRequest,
    type StockCandidate,
    type StockUnit,
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
    const provider = `${base}^${type}INcentral_depot,staging_centre,customer_site^${type}!=customer_site`
    const fleet = (query: string) => andEachClause(query, 'x_daas_ham_fleet=true')
    const free = fleet(stagesQuery(['available'], provider))
    const pool = fleet(stagesQuery(['spare_pool'], `${provider}^company=acme`))

    it("asks for the Customer's own stock and free stock only, one query per source in priority order", () => {
        expect(stockQueries({ modelId: 'm1', customerId: 'acme', siteId: 'hq', purpose: 'new' })).toEqual([pool, free])
    })

    it("adds the Customer's site stockroom stock at the Site or one of its Rooms for a replacement, first", () => {
        const [site, ...rest] = stockQueries({ modelId: 'm1', customerId: 'acme', siteId: 'hq', purpose: 'replace' })
        expect(rest).toEqual([pool, free])
        const siteStockroom = 'stockroom.x_daas_ham_stockroom_type=customer_site^stockroom.x_daas_ham_customer=acme'
        const atSite = 'stockroom.location=hq^ORstockroom.location.parent=hq'
        expect(site).toBe(fleet(stagesQuery(['available', 'spare_pool'], `${base}^${siteStockroom}^${atSite}`)))
    })

    it('asks for free stock only when stock is sought for no Customer (the spare-pool top-up)', () => {
        expect(stockQueries(freeStockOf('m1'))).toEqual([free])
    })

    it('asks for fleet assets only, in every clause of every query (ADR 0016)', () => {
        for (const purpose of ['new', 'replace'] as const) {
            for (const query of stockQueries({ modelId: 'm1', customerId: 'acme', siteId: 'hq', purpose })) {
                for (const clause of query.split('^NQ')) expect(clause.split('^')).toContain('x_daas_ham_fleet=true')
            }
        }
    })

    it('never counts stock in a stockroom with no NaaS stockroom type as central stock or spares', () => {
        const [pooled, central] = stockQueries({ modelId: 'm1', customerId: 'acme', siteId: 'hq', purpose: 'new' })
        for (const clause of [...pooled.split('^NQ'), ...central.split('^NQ')]) {
            expect(clause).toContain(`^${type}INcentral_depot,staging_centre,customer_site^`)
            expect(clause).not.toContain(`${type}ISEMPTY`)
        }
    })

    it('leaves stock of a lease being returned to its Lessor out of every clause of every query', () => {
        for (const purpose of ['new', 'replace'] as const) {
            for (const query of stockQueries({ modelId: 'm1', customerId: 'acme', siteId: 'hq', purpose })) {
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

describe('advanceReplacementRma', () => {
    const rma = (rma: Partial<OpenRma> & Pick<OpenRma, 'rmaId'>): OpenRma => ({
        rmaNumber: '',
        state: 'to_open',
        lineId: '',
        lineOpen: false,
        ...rma,
    })

    it('opens a new RMA when none is open for the unit the line replaces', () => {
        expect(advanceReplacementRma('line-1', [])).toBeNull()
        const returned = rma({ rmaId: 'r1', state: 'defective_returned', lineId: 'line-1', lineOpen: true })
        const done = [returned, rma({ rmaId: 'r2', state: 'closed' })]
        expect(advanceReplacementRma('line-1', done)).toBeNull()
    })

    it("reuses the line's own RMA whose replacement was lost in transit, open again to ask for another", () => {
        const received = rma({ rmaId: 'r1', state: 'replacement_received', lineId: 'line-1', lineOpen: true })
        expect(advanceReplacementRma('line-1', [received])).toEqual({ rma: received, state: 'open', askAgain: true })
    })

    it('reuses an RMA whose replacement is still to come as it is, the line waiting for that replacement', () => {
        for (const state of ['to_open', 'open'] as const) {
            const awaited = rma({ rmaId: 'r1', state })
            expect(advanceReplacementRma('line-1', [awaited])).toEqual({ rma: awaited, state, askAgain: false })
        }
    })

    it('reuses one left by a line no longer waiting for it, such as a cancelled Order', () => {
        const left = rma({ rmaId: 'r1', state: 'open', lineId: 'line-0', lineOpen: false })
        expect(advanceReplacementRma('line-1', [left])?.rma).toBe(left)
    })

    it('leaves an RMA another open line waits for to that line', () => {
        const theirs = rma({ rmaId: 'r1', state: 'open', lineId: 'line-2', lineOpen: true })
        expect(advanceReplacementRma('line-1', [theirs])).toBeNull()
    })

    it("prefers the line's own RMA, then one whose replacement is still to come", () => {
        const stray = rma({ rmaId: 'stray', state: 'replacement_received' })
        const awaited = rma({ rmaId: 'awaited', state: 'to_open' })
        const own = rma({ rmaId: 'own', state: 'replacement_received', lineId: 'line-1', lineOpen: true })
        expect(advanceReplacementRma('line-1', [stray, awaited, own])?.rma).toBe(own)
        expect(advanceReplacementRma('line-1', [stray, awaited])?.rma).toBe(awaited)
    })

    it('takes the oldest of RMAs ranked alike (the platform lists them oldest first)', () => {
        const older = rma({ rmaId: 'older', state: 'open' })
        const newer = rma({ rmaId: 'newer', state: 'to_open' })
        expect(advanceReplacementRma('line-1', [older, newer])?.rma).toBe(older)
        expect(advanceReplacementRma('line-1', [newer, older])?.rma).toBe(newer)
    })
})

describe('sourcingLockName and orderLineLockName', () => {
    const sysId = (c: string) => c.repeat(32)

    it('lock each Order and each line on its own, within the job lock name length', () => {
        const names = [sysId('a'), sysId('b')].flatMap((id) => [sourcingLockName(id), orderLineLockName(id)])
        expect(new Set(names).size).toBe(names.length)
        for (const name of names) expect(name.length).toBeLessThanOrEqual(100)
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
        expect(poolStock).toContain(`^${notLessorBound}`)
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
