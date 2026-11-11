import type { GlideRecord } from '@servicenow/glide'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { REQUEUE } from '../domain/job-lock.ts'
import { LOCK } from '../domain/lock-names.ts'
import { ROLE } from '../domain/roles.ts'
import { EVENT } from '../domain/events.ts'
import { cancelOrder, submitOrder, submitProducedOrder, submitQueuedOrder, SUBMIT_AGAIN } from './orders.ts'
import { findById } from './records.ts'
import { platform, type Row } from '../test-support/fake-glide.ts'

/*
 * Submitting an Order, run against the in-memory stand-in for the platform, job locks included (ADR 0013): draft
 * ORD0001 of Customer acme asks for one more switch under Agreement agr1, whose catalog offers it; an asset manager
 * submits it.
 */

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

/** Another submission of the Agreement holds its usage lock, taken just now. */
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

describe('submitting an Order that adds a unit', () => {
    it("assesses it and saves it out of draft holding its Agreement's usage lock and its own sourcing lock, then lets them go", () => {
        let heldAtSave: string[] = []
        platform.onSave = (table, row) => {
            if (table === ORDERS && row.stage !== 'draft') heldAtSave = rows(LOCKS).map((lock) => lock.name)
        }

        expect(submitOrder(order())).toEqual({ submitted: true })

        expect(heldAtSave).toEqual([LOCK.agreementUsage('agr1'), LOCK.sourceOrder('order1')])
        expect(storedOrder()).toMatchObject({ stage: 'sourcing', approval: 'approved', entitlement_verdict: 'within_agreement' })
        expect(platform.events).toEqual([{ name: EVENT.sourceOrder, record: 'order1', parm1: '', parm2: '', delayed: false }])
        expect(rows(LOCKS)).toEqual([])
    })

    it('stays a draft, noted, and is queued to be submitted again while another submission of its Agreement holds the lock', () => {
        const theirs = holdUsageLock()

        expect(submitOrder(order())).toEqual({ submitted: false, message: `Order not submitted yet: ${BUSY} in a minute` })

        expect(storedOrder()).toMatchObject({ stage: 'draft', work_notes: `Not submitted yet: ${BUSY}` })
        expect(storedOrder().entitlement_verdict ?? '').toBe('')
        expect(platform.events).toEqual([{ name: EVENT.sourceOrder, record: 'order1', parm1: SUBMIT_AGAIN, parm2: '1', delayed: true }])
        expect(rows(LOCKS)).toEqual([theirs])
    })

    it('tells the raiser of a record producer, who may have no Submit, that it is saved and not to raise it again', () => {
        holdUsageLock()
        // The producer adds the lines itself.
        rows(LINES).pop()

        expect(submitProducedOrder(order(), [{ modelId: 'model1', quantity: 1 }], '')).toEqual({
            submitted: false,
            message:
                'Order ORD0001 is saved and is submitted within a few minutes: another order of the same agreement was being submitted at that moment. There is no need to raise it again',
            info: true,
        })

        expect(storedOrder().stage).toBe('draft')
        expect(platform.events).toEqual([{ name: EVENT.sourceOrder, record: 'order1', parm1: SUBMIT_AGAIN, parm2: '1', delayed: true }])
    })

    it('goes ahead when the submission queued again finds the lock free', () => {
        submitQueuedOrder('order1', 1)

        expect(storedOrder().stage).toBe('sourcing')
        expect(rows(LOCKS)).toEqual([])
    })

    it('is queued again with its count, without a second note, and is left for staff to submit once it was queued again as often as a sourcing request', () => {
        const theirs = holdUsageLock()

        submitQueuedOrder('order1', 3)

        expect(platform.events).toEqual([{ name: EVENT.sourceOrder, record: 'order1', parm1: SUBMIT_AGAIN, parm2: '4', delayed: true }])
        expect(storedOrder().work_notes ?? '').toBe('')

        platform.events.length = 0
        submitQueuedOrder('order1', REQUEUE.times)

        expect(platform.events).toEqual([])
        expect(storedOrder()).toMatchObject({
            stage: 'draft',
            work_notes: 'Not submitted: other Orders of its Agreement kept being submitted at the same time. Submit it',
        })
        expect(platform.warnings).toEqual([
            `[x_daas_ham] ORD0001 left a draft: ${theirs.name} stayed held through ${REQUEUE.times} submissions queued again; submit it`,
        ])
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
