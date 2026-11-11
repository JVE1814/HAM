import type { GlideRecord } from '@servicenow/glide'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCK } from '../domain/lock-names.ts'
import { EVENT } from '../domain/events.ts'
import { PROPERTY } from '../domain/properties.ts'
import { findById } from './records.ts'
import { runSourcingPass } from './sourcing.ts'
import { platform, type Row } from '../test-support/fake-glide.ts'

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

const ORDERS = 'x_daas_ham_order'
const LINES = 'x_daas_ham_order_line'
const LOCKS = 'x_daas_ham_job_lock'
const PURCHASE_ORDERS = 'proc_po'
const PURCHASE_ITEMS = 'proc_po_item'

const rows = (table: string): Row[] => platform.tables[table] ?? []
const line = (): Row => rows(LINES)[0]

function order(): GlideRecord {
    const found = findById(ORDERS, 'order1')
    if (!found) throw new Error('the Order is not stored')
    return found
}

/**
 * Another pass takes the Order's lock over (having judged it abandoned) while this one holds the line's lock for the
 * first time, which is when it counts what the line still needs.
 */
function loseOrderLockWhileTheLineIsCounted(): void {
    let lost = false
    platform.onSave = (table, row) => {
        if (lost || table !== LOCKS || row.name !== LOCK.orderLine('line1')) return
        lost = true
        const locks = rows(LOCKS)
        locks.splice(locks.findIndex((lock) => lock.name === LOCK.sourceOrder('order1')), 1, { sys_id: 'theirs', name: LOCK.sourceOrder('order1') })
    }
}

beforeEach(() => {
    platform.reset()
    platform.uniqueKeys = { [LOCKS]: 'name' }
    platform.references = { [`${LINES}.order`]: ORDERS, [`${LINES}.model`]: 'cmdb_model' }
    platform.properties = { [PROPERTY.stagingStockroom.name]: 'staging1' }
    platform.defaults = { [PURCHASE_ORDERS]: () => ({ number: `PO000${rows(PURCHASE_ORDERS).length + 1}` }) }
    platform.tables.cmdb_model = [{ sys_id: 'model1', name: 'C9300-48P', display_name: 'Cisco C9300-48P', cmdb_model_category: 'switch' }]
    platform.tables[ORDERS] = [{ sys_id: 'order1', number: 'ORD0001', customer: 'acme', site: 'site1', agreement: 'agr1', order_type: 'device_add', stage: 'sourcing' }]
    platform.tables[LINES] = [{ sys_id: 'line1', number: 'ORL0001', order: 'order1', model: 'model1', quantity: '2', line_stage: 'new' }]
})

describe('a sourcing pass', () => {
    it('buys what no stock covers and puts it on the line as on order, under locks it lets go of', () => {
        runSourcingPass(order(), 0)

        expect(rows(PURCHASE_ORDERS)).toEqual([expect.objectContaining({ status: 'requested', ship_to: 'staging1', short_description: 'ORD0001 ORL0001: 2 x Cisco C9300-48P' })])
        const [purchaseOrder] = rows(PURCHASE_ORDERS)
        expect(rows(PURCHASE_ITEMS)).toEqual([expect.objectContaining({ purchase_order: purchaseOrder.sys_id, model: 'model1', ordered_quantity: '2' })])
        expect(line()).toMatchObject({ quantity_to_purchase: '2', purchase_order: purchaseOrder.sys_id, purchase_orders: purchaseOrder.sys_id, sourcing_summary: '2 to purchase' })
        expect(line().line_stage).not.toBe('new')
        expect(platform.events).toEqual([])
        expect(rows(LOCKS)).toEqual([])
    })

    it('buys nothing once it has lost its lock on the Order: the line is left as it was, for the pass queued again', () => {
        loseOrderLockWhileTheLineIsCounted()
        const before = { ...line() }

        runSourcingPass(order(), 0)

        expect(rows(PURCHASE_ORDERS)).toEqual([])
        expect(rows(PURCHASE_ITEMS)).toEqual([])
        expect(line()).toEqual(before)
        expect(platform.events).toEqual([{ name: EVENT.sourceOrder, record: 'order1', parm1: '', parm2: '1', delayed: true }])
        // The lock of the pass that took over is not this one's to release.
        expect(rows(LOCKS)).toEqual([{ sys_id: 'theirs', name: LOCK.sourceOrder('order1') }])
    })
})
