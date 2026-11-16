import type { GlideRecord } from '@servicenow/glide'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { REQUEUE } from '../domain/job-lock.ts'
import { LOCK } from '../domain/lock-names.ts'
import { ROLE } from '../domain/roles.ts'
import { EVENT } from '../domain/events.ts'
import { cancelOrder, contactOrderInsertRefusal, submitOrder, submitProducedOrder, submitQueuedOrder } from './orders.ts'
import { sourcingRequestOf } from './sourcing-requests.ts'
import { findById } from './records.ts'
import { platform, recordOf, type Row } from '../test-support/fake-glide.ts'

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

const ORDERS = 'x_daas_ham_order'
const LINES = 'x_daas_ham_order_line'
const ASSETS = 'alm_hardware'
const LOCKS = 'x_daas_ham_job_lock'

const BUSY = 'another Order of its Agreement was being submitted at the same time. It is submitted again automatically'

const rows = (table: string): Row[] => platform.tables[table] ?? []
const storedOrder = (): Row => rows(ORDERS)[0]
const line = (): Row => rows(LINES)[0]

function order(): GlideRecord {
    const found = findById(ORDERS, 'order1')
    if (!found) throw new Error('the Order is not stored')
    return found
}

function holdUsageLock(): Row {
    const theirs = { sys_id: 'theirs', name: LOCK.agreementUsage('agr1'), sys_created_on: '2025-11-09 12:00:00' }
    ;(platform.tables[LOCKS] ??= []).push(theirs)
    return theirs
}

beforeEach(() => {
    platform.reset()
    platform.uniqueKeys = { [LOCKS]: 'name' }
    platform.user = { id: 'am', name: 'Asset manager', company: 'provider', roles: [ROLE.assetManager], interactive: true }
    platform.creatable = () => true
    // A line is new until it is sourced: the column's default.
    platform.defaults = { [LINES]: () => ({ line_stage: 'new' }) }
    platform.references = {
        [`${ORDERS}.site`]: 'cmn_location',
        [`${LINES}.order`]: ORDERS,
        [`${LINES}.model`]: 'cmdb_model',
        [`${ASSETS}.model`]: 'cmdb_model',
        [`${ASSETS}.x_daas_ham_order_line`]: LINES,
    }
    platform.tables.cmn_location = [{ sys_id: 'site1', company: 'acme', x_daas_ham_is_site: 'true' }]
    platform.tables.cmdb_model = [{ sys_id: 'model1', name: 'C9300-48P', x_daas_ham_device_class: 'switch' }]
    platform.tables.x_daas_ham_agreement = [{ sys_id: 'agr1', customer: 'acme' }]
    platform.tables.x_daas_ham_catalog_entry = [{ sys_id: 'entry1', customer: 'acme', entry_type: 'model', model: 'model1', active: 'true' }]
    platform.tables[ORDERS] = [{ sys_id: 'order1', number: 'ORD0001', customer: 'acme', site: 'site1', agreement: 'agr1', stage: 'draft' }]
    platform.tables[LINES] = [{ sys_id: 'line1', number: 'ORL0001', order: 'order1', model: 'model1', quantity: '1', line_stage: 'new' }]
})

function queuedRequests() {
    return platform.events.map((queued) => ({
        name: queued.name,
        record: queued.record,
        delayed: queued.delayed,
        ...sourcingRequestOf({ getValue: (field: string) => queued[field as 'parm1' | 'parm2'] } as unknown as GlideRecord),
    }))
}

describe('submitting an Order that adds a unit', () => {
    it('assesses it and saves it out of draft while another submission of its Agreement waits its turn, then queues its sourcing', () => {
        rows(ORDERS).push({ sys_id: 'order2', number: 'ORD0002', customer: 'acme', site: 'site1', agreement: 'agr1', stage: 'draft' })
        rows(LINES).push({ sys_id: 'line2', number: 'ORL0002', order: 'order2', model: 'model1', quantity: '1', line_stage: 'new' })
        let meanwhile: unknown
        platform.onSave = (table, row) => {
            if (meanwhile || table !== ORDERS || row.sys_id !== 'order1' || row.stage === 'draft') return
            meanwhile = submitOrder(findById(ORDERS, 'order2')!)
        }

        expect(submitOrder(order())).toEqual({ submitted: true })

        expect(meanwhile).toMatchObject({ submitted: false, queued: true })
        expect(storedOrder()).toMatchObject({ stage: 'sourcing', approval: 'approved', entitlement_verdict: 'within_agreement' })
        expect(queuedRequests()).toEqual([
            { name: EVENT.sourceOrder, record: 'order2', delayed: true, request: 'submission', tries: 1 },
            { name: EVENT.sourceOrder, record: 'order1', delayed: false, request: 'pass', tries: 0 },
        ])
        expect(rows(LOCKS)).toEqual([])
    })

    it('stays a draft, noted, and is queued to be submitted again while another submission of its Agreement holds the lock', () => {
        const theirs = holdUsageLock()

        expect(submitOrder(order())).toEqual({ submitted: false, message: `Order not submitted yet: ${BUSY} in a minute`, queued: true })

        expect(storedOrder()).toMatchObject({ stage: 'draft' })
        expect(platform.notesOn('order1')).toEqual([`Not submitted yet: ${BUSY}`])
        expect(storedOrder().entitlement_verdict ?? '').toBe('')
        expect(queuedRequests()).toEqual([{ name: EVENT.sourceOrder, record: 'order1', delayed: true, request: 'submission', tries: 1 }])
        expect(rows(LOCKS)).toEqual([theirs])
    })

    it('queues an Order the record producer raised to be submitted again, as Submit does', () => {
        holdUsageLock()
        // The producer adds the lines itself.
        rows(LINES).pop()

        expect(submitProducedOrder(order(), [{ modelId: 'model1', quantity: 1 }], '')).toEqual({
            submitted: false,
            message: `Order not submitted yet: ${BUSY} in a minute`,
            queued: true,
        })

        expect(storedOrder().stage).toBe('draft')
        expect(queuedRequests()).toEqual([{ name: EVENT.sourceOrder, record: 'order1', delayed: true, request: 'submission', tries: 1 }])
    })

    it('goes ahead when the submission queued again finds the lock free', () => {
        submitQueuedOrder('order1', 1)

        expect(storedOrder().stage).toBe('sourcing')
        expect(rows(LOCKS)).toEqual([])
    })

    it('is queued again with its count, without a second note, and is left for staff to submit once it was queued again as often as a sourcing request', () => {
        holdUsageLock()

        submitQueuedOrder('order1', 3)

        expect(queuedRequests()).toEqual([{ name: EVENT.sourceOrder, record: 'order1', delayed: true, request: 'submission', tries: 4 }])
        expect(platform.notesOn('order1')).toEqual([])

        platform.events.length = 0
        submitQueuedOrder('order1', REQUEUE.times)

        expect(platform.events).toEqual([])
        expect(storedOrder().stage).toBe('draft')
        expect(platform.notesOn('order1')).toEqual(['Not submitted: other Orders of its Agreement kept being submitted at the same time. Submit it'])
        expect(platform.warnings).toEqual([expect.stringContaining('ORD0001')])
    })

    it('reports an Order another submission of it took ahead as already submitted, and leaves it as that one saved it', () => {
        const stale = order()
        submitOrder(order())
        const submitted = { ...storedOrder() }
        platform.events.length = 0

        expect(submitOrder(stale)).toEqual({ submitted: true, already: 'Order ORD0001 was already submitted (sourcing)' })

        expect(storedOrder()).toEqual(submitted)
        expect(platform.events).toEqual([])
    })

    it('keeps Cancel order out until it is saved out of draft, so the cancel changes nothing and asks to try again', () => {
        let cancel: unknown
        platform.onSave = (table, row) => {
            if (cancel || table !== ORDERS || row.stage !== 'sourcing') return
            cancel = cancelOrder(order())
        }

        expect(submitOrder(order())).toEqual({ submitted: true })

        expect(cancel).toEqual({ cancelled: false, reason: 'it is being submitted or sourced. Try again in a minute' })
        expect(storedOrder()).toMatchObject({ stage: 'sourcing', approval: 'approved' })
        expect(line().line_stage).toBe('new')
        expect(rows(LOCKS)).toEqual([])
    })

    it('is not submitted once the Order was cancelled meanwhile, and a submission queued again does nothing', () => {
        const stale = order()
        storedOrder().stage = 'cancelled'

        expect(submitOrder(stale)).toEqual({ submitted: false, message: 'Order not submitted: it is cancelled' })
        submitQueuedOrder('order1', 1)

        expect(storedOrder().stage).toBe('cancelled')
        expect(platform.events).toEqual([])
    })
})

describe('submitting an Order that only replaces Assets', () => {
    beforeEach(() => {
        line().replaces_asset = 'old1'
    })

    it("reads no usage, so it takes no usage lock: it goes ahead while another submission holds its Agreement's", () => {
        const theirs = holdUsageLock()

        expect(submitOrder(order())).toEqual({ submitted: true })

        expect(storedOrder().stage).toBe('sourcing')
        expect(rows(LOCKS)).toEqual([theirs])
    })
})

describe('an Order saved in a Customer contact session', () => {
    // Users no other test of this file signs in as: a user's scope is kept for as long as the modules are loaded.
    const ADMIN = { id: 'direct-admin', name: 'Ada', company: 'acme', roles: [ROLE.customerAdmin], interactive: true }
    const SITE_CONTACT = { id: 'direct-contact', name: 'Sam', company: 'acme', roles: [ROLE.siteContact], interactive: true }

    const refusalOf = (row: Row) => contactOrderInsertRefusal(recordOf<GlideRecord>(ORDERS, row, { fresh: true }))

    beforeEach(() => {
        rows('cmn_location').push({ sys_id: 'site9', company: 'other', x_daas_ham_is_site: 'true' })
        rows('x_daas_ham_agreement').push({ sys_id: 'agr9', customer: 'other' })
    })

    it('is refused unless it names their own Customer with an Agreement and a Site of that Customer', () => {
        platform.user = ADMIN
        expect(refusalOf({ customer: 'acme', site: 'site1', agreement: 'agr1' })).toBeNull()
        expect(refusalOf({})).toBe('Order not raised. You can only order for your own customer.')
        expect(refusalOf({ customer: 'other', site: 'site9', agreement: 'agr9' })).toBe('Order not raised. You can only order for your own customer.')
        expect(refusalOf({ customer: 'acme', site: 'site1' })).toBe("Order not raised. Choose one of the customer's agreements.")
        expect(refusalOf({ customer: 'acme', site: 'site9', agreement: 'agr9' })).toBe(
            "Order not raised. The agreement is not one of the customer's agreements. The site is not one of the customer's sites.",
        )
    })

    it('is refused for a site contact, who raises no Orders', () => {
        platform.user = SITE_CONTACT
        expect(refusalOf({ customer: 'acme', site: 'site1', agreement: 'agr1' })).toBe('Order not raised. You may not raise orders.')
    })

    it('is not checked when provider staff save it: their draft stays a draft to correct', () => {
        expect(refusalOf({})).toBeNull()
        expect(refusalOf({ customer: 'acme', site: 'site9', agreement: 'agr9' })).toBeNull()
    })
})

describe('an Order the record producer saved for a requester who may not raise it', () => {
    const produced = () => recordOf<GlideRecord>(ORDERS, storedOrder(), { produced: true })

    beforeEach(() => {
        platform.creatable = () => false
    })

    it('is removed again, with no line', () => {
        expect(submitProducedOrder(produced(), [{ modelId: 'model1', quantity: 1 }], '')).toEqual({ submitted: false, message: 'Order not raised. You may not raise orders.' })

        expect(rows(ORDERS)).toEqual([])
        expect(platform.warnings).toEqual([])
    })

    it('is logged, to cancel, when the platform keeps it', () => {
        platform.refuses = (table, _row, operation) => (table === ORDERS && operation === 'delete' ? 'kept for this test' : '')

        submitProducedOrder(produced(), [], '')

        expect(storedOrder()).toMatchObject({ sys_id: 'order1', stage: 'draft' })
        expect(platform.warnings).toEqual(['[x_daas_ham] ORD0001 not removed (You may not raise orders), cancel it: kept for this test'])
    })
})
