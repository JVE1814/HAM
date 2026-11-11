import type { GlideRecord } from '@servicenow/glide'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fieldsOf, stageOf, type Stage } from '../domain/lifecycle.ts'
import { LOCK } from '../domain/lock-names.ts'
import { recomputeLine } from './fulfilment.ts'
import { cancelOrder, rollUpOrderApprovals } from './orders.ts'
import { PROPERTY } from '../domain/properties.ts'
import { findById } from './records.ts'
import { platform, type Row } from '../test-support/fake-glide.ts'

/*
 * Cancel order, an Order's rejection and a line's derived stage, run against the in-memory stand-in for the platform,
 * job locks included (ADR 0013): Order ORD0001 with two lines not shipped, a unit reserved for the second.
 */

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

const ORDERS = 'x_daas_ham_order'
const LINES = 'x_daas_ham_order_line'
const ASSETS = 'alm_hardware'
const LOCKS = 'x_daas_ham_job_lock'
const APPROVALS = 'sysapproval_approver'

const rows = (table: string): Row[] => platform.tables[table] ?? []
const storedOrder = (): Row => rows(ORDERS)[0]
const lineStages = (): Record<string, string> => Object.fromEntries(rows(LINES).map((line) => [line.sys_id, line.line_stage]))
const unit = (): Row => rows(ASSETS)[0]
const stageOfUnit = (): Stage | null => stageOf({ installStatus: unit().install_status, substatus: unit().substatus })
const lockNames = (): string[] => rows(LOCKS).map((lock) => lock.name)

function inStage(stage: Stage): Row {
    const { installStatus, substatus } = fieldsOf(stage)
    return { install_status: installStatus, substatus: substatus ?? '' }
}

function order(): GlideRecord {
    const found = findById(ORDERS, 'order1')
    if (!found) throw new Error('the Order is not stored')
    return found
}

/** A receipt (or another cancel) holds the lock of `lineId`, taken just now. */
function holdLineLock(lineId: string): Row {
    const theirs = { sys_id: 'theirs', name: LOCK.orderLine(lineId), sys_created_on: '2025-11-09 12:00:00' }
    ;(platform.tables[LOCKS] ??= []).push(theirs)
    return theirs
}

/** The locks held each time a row of `table` is saved, and the order the locks were taken in. */
function watchLocks(table: string): { heldAtSave: string[][]; taken: string[] } {
    const watched = { heldAtSave: [] as string[][], taken: [] as string[] }
    platform.onSave = (saved, row, operation) => {
        if (saved === LOCKS && operation === 'insert') watched.taken.push(row.name)
        if (saved === table) watched.heldAtSave.push(lockNames())
    }
    return watched
}

beforeEach(() => {
    platform.reset()
    platform.uniqueKeys = { [LOCKS]: 'name' }
    platform.references = {
        [`${LINES}.order`]: ORDERS,
        [`${ASSETS}.x_daas_ham_order_line`]: LINES,
        'sys_user_has_role.role': 'sys_user_role',
        'sys_user_has_role.user': 'sys_user',
    }
    platform.properties = { [PROPERTY.providerCompany.name]: 'provider' }
    platform.tables[ORDERS] = [{ sys_id: 'order1', number: 'ORD0001', customer: 'acme', agreement: 'agr1', stage: 'sourcing' }]
    // Stored out of sys_id order: the locks are taken in sys_id order all the same.
    platform.tables[LINES] = [
        { sys_id: 'line2', number: 'ORL0002', order: 'order1', quantity: '1', line_stage: 'sourced' },
        { sys_id: 'line1', number: 'ORL0001', order: 'order1', quantity: '2', line_stage: 'awaiting_stock' },
        { sys_id: 'line0', number: 'ORL0000', order: 'order1', quantity: '1', line_stage: 'shipped' },
    ]
    platform.tables[ASSETS] = [
        {
            sys_id: 'asset1',
            serial_number: 'FOC111',
            x_daas_ham_fleet: 'true',
            x_daas_ham_legal_owner: 'provider',
            company: 'acme',
            x_daas_ham_agreement: 'agr1',
            x_daas_ham_order_line: 'line2',
            ...inStage('reserved'),
        },
    ]
})

describe('Cancel order', () => {
    beforeEach(() => {
        // Nothing of the Order has shipped: the cancel is not refused for that.
        rows(LINES).pop()
    })

    it("holds the Order's sourcing and Ship locks and each open line's, taken in sys_id order, while it cancels the lines and releases their units", () => {
        const lines = watchLocks(LINES)

        expect(cancelOrder(order())).toEqual({ cancelled: true, complete: true })

        const held = [LOCK.sourceOrder('order1'), LOCK.shipOrder('order1'), LOCK.orderLine('line1'), LOCK.orderLine('line2')]
        expect(lines.taken).toEqual(held)
        expect(lines.heldAtSave).toEqual([held, held])
        expect(storedOrder().stage).toBe('cancelled')
        expect(lineStages()).toEqual({ line1: 'cancelled', line2: 'cancelled' })
        expect(stageOfUnit()).toBe('available')
        expect(unit()).toMatchObject({ x_daas_ham_order_line: '', company: 'provider', x_daas_ham_agreement: '' })
        expect(rows(LOCKS)).toEqual([])
    })

    it('changes nothing while a receipt holds the lock of one of its lines, and says to try again', () => {
        const theirs = holdLineLock('line2')
        const before = { order: { ...storedOrder() }, unit: { ...unit() } }

        expect(cancelOrder(order())).toEqual({ cancelled: false, reason: 'a unit is being received for one of its lines. Try again shortly' })

        expect(storedOrder()).toEqual(before.order)
        expect(lineStages()).toEqual({ line1: 'awaiting_stock', line2: 'sourced' })
        expect(unit()).toEqual(before.unit)
        // The locks it took before it met the held one are let go; the receipt's is not its to release.
        expect(rows(LOCKS)).toEqual([theirs])
    })

    it('releases the units of a line it locked even when a derived stage already shows the line cancelled', () => {
        // A stage derived beside the cancel, after the cancel read the line as open and before it took its lock.
        platform.onSave = (table, row, operation) => {
            if (table !== LOCKS || operation !== 'insert' || row.name !== LOCK.orderLine('line2')) return
            const line = rows(LINES).find((stored) => stored.sys_id === 'line2')
            if (line) line.line_stage = 'cancelled'
        }

        expect(cancelOrder(order())).toEqual({ cancelled: true, complete: true })

        expect(lineStages()).toEqual({ line1: 'cancelled', line2: 'cancelled' })
        expect(stageOfUnit()).toBe('available')
        expect(unit().x_daas_ham_order_line).toBe('')
    })
})

describe("an Order's rejection", () => {
    beforeEach(() => {
        Object.assign(storedOrder(), { stage: 'awaiting_approval', approval: 'requested', entitlement_verdict: 'off_catalog' })
        platform.tables.sys_user_role = [{ sys_id: 'customer_admin_role', name: 'x_daas_ham.customer_admin' }]
        platform.tables.sys_user = [{ sys_id: 'ca', company: 'acme', active: 'true' }]
        platform.tables.sys_user_has_role = [{ sys_id: 'role-of-ca', role: 'customer_admin_role', user: 'ca', state: 'active' }]
        platform.tables[APPROVALS] = [{ sys_id: 'approval1', sysapproval: 'order1', approver: 'ca', state: 'rejected' }]
    })

    it("saves the Order rejected and cancels its open lines holding each line's lock", () => {
        const lines = watchLocks(LINES)

        expect(rollUpOrderApprovals('order1')).toMatchObject({ outcome: 'rejected', refused: '' })

        const held = [LOCK.orderLine('line1'), LOCK.orderLine('line2')]
        expect(lines.taken).toEqual(held)
        expect(lines.heldAtSave).toEqual([held, held])
        expect(storedOrder()).toMatchObject({ stage: 'rejected', approval: 'rejected' })
        expect(lineStages()).toEqual({ line0: 'shipped', line1: 'cancelled', line2: 'cancelled' })
        expect(stageOfUnit()).toBe('available')
        expect(rows(LOCKS)).toEqual([])
    })

    it('changes nothing while a receipt holds the lock of one of its lines: the Order stays awaiting approval, to re-check', () => {
        const theirs = holdLineLock('line1')

        expect(rollUpOrderApprovals('order1')).toMatchObject({
            outcome: 'rejected',
            refused: 'one of its lines is being received or cancelled: re-check its approvals shortly',
        })

        expect(storedOrder()).toMatchObject({ stage: 'awaiting_approval', approval: 'requested' })
        expect(lineStages()).toEqual({ line0: 'shipped', line1: 'awaiting_stock', line2: 'sourced' })
        expect(stageOfUnit()).toBe('reserved')
        expect(platform.warnings).toEqual(["[x_daas_ham] ORD0001 not rejected: a line's lock stayed held through every try; re-check its approvals"])
        expect(rows(LOCKS)).toEqual([theirs])
    })
})

describe("a line's stage derived from its Assets", () => {
    const line2 = (): Row => rows(LINES)[0]

    beforeEach(() => {
        // The unit of line2 is being staged, so the line derives from sourced to staging.
        Object.assign(unit(), inStage('staging'))
    })

    it('moves the line on with its Assets on a live Order', () => {
        recomputeLine('line2')

        expect(line2().line_stage).toBe('staging')
    })

    it('is not saved on a line whose Order was cancelled or rejected, even one a refused cancel left open', () => {
        for (const stage of ['cancelled', 'rejected']) {
            storedOrder().stage = stage

            recomputeLine('line2')

            expect(line2().line_stage).toBe('sourced')
        }
    })

    it('cancels the line again when its Order ended while the derived stage was saved', () => {
        // The cancel saves the Order, then the line, between this derive's check and its save.
        platform.onSave = (table, row) => {
            if (table !== LINES || row.line_stage !== 'staging') return
            storedOrder().stage = 'cancelled'
        }

        recomputeLine('line2')

        expect(line2().line_stage).toBe('cancelled')
    })
})

describe("an Order's stage derived from its lines", () => {
    beforeEach(() => {
        // Nothing has shipped, so Cancel order goes ahead; the unit of line2 is being staged, so the Order derives to preparing.
        rows(LINES).pop()
        Object.assign(storedOrder(), { state: '2' })
        Object.assign(unit(), inStage('staging'))
    })

    it('leaves the Order cancelled when Cancel order lands between its read and its save', () => {
        let cancel: unknown
        platform.onSave = (table, row, operation) => {
            if (cancel || table !== ORDERS || operation !== 'update' || row.stage !== 'preparing') return
            cancel = cancelOrder(order())
        }

        recomputeLine('line2')

        expect(cancel).toEqual({ cancelled: true, complete: true })
        expect(storedOrder()).toMatchObject({ stage: 'cancelled', state: '7' })
        expect(lineStages()).toEqual({ line1: 'cancelled', line2: 'cancelled' })
    })
})
