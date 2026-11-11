import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fieldsOf, stageOf, type Stage } from '../domain/lifecycle.ts'
import { LOCK } from '../domain/lock-names.ts'
import { receive } from './receiving.ts'
import { platform, type Row } from '../test-support/fake-glide.ts'

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

const ORDERS = 'x_daas_ham_order'
const LINES = 'x_daas_ham_order_line'
const ASSETS = 'alm_hardware'
const LOCKS = 'x_daas_ham_job_lock'
const STAGING_TASKS = 'x_daas_ham_staging_task'
const RMAS = 'x_daas_ham_oem_rma'

const rows = (table: string): Row[] => platform.tables[table] ?? []
const unit = (): Row => rows(ASSETS)[0]
const line = (): Row => rows(LINES)[0]
const storedOrder = (): Row => rows(ORDERS)[0]
const stageOfUnit = (): Stage | null => stageOf({ installStatus: unit().install_status, substatus: unit().substatus })
const lockNames = (): string[] => rows(LOCKS).map((lock) => lock.name)

function inStage(stage: Stage): Row {
    const { installStatus, substatus } = fieldsOf(stage)
    return { install_status: installStatus, substatus: substatus ?? '' }
}

beforeEach(() => {
    platform.reset()
    platform.uniqueKeys = { [LOCKS]: 'name' }
    platform.references = {
        [`${ASSETS}.model`]: 'cmdb_model',
        [`${ASSETS}.stockroom`]: 'alm_stockroom',
        [`${ASSETS}.x_daas_ham_order_line`]: LINES,
        [`${ASSETS}.x_daas_ham_lease`]: 'x_daas_ham_lease_schedule',
        [`${LINES}.order`]: ORDERS,
        [`${RMAS}.order_line`]: LINES,
    }
    platform.defaults = { [STAGING_TASKS]: () => ({ number: `NSTG000${rows(STAGING_TASKS).length + 1}` }) }
    platform.tables.alm_stockroom = [{ sys_id: 'staging1', name: 'Staging centre', x_daas_ham_stockroom_type: 'staging_centre' }]
    platform.tables.cmdb_model = [{ sys_id: 'model1', name: 'C9300-48P', display_name: 'Cisco C9300-48P' }]
    platform.tables.proc_po = [{ sys_id: 'po1', number: 'PO0001' }]
    platform.tables[ORDERS] = [{ sys_id: 'order1', number: 'ORD0001', customer: 'acme', agreement: 'agr1', stage: 'sourcing' }]
    platform.tables[LINES] = [
        { sys_id: 'line1', number: 'ORL0001', order: 'order1', model: 'model1', quantity: '1', quantity_to_purchase: '1', purchase_orders: 'po1', line_stage: 'awaiting_stock' },
    ]
    platform.tables[ASSETS] = [
        {
            sys_id: 'asset1',
            serial_number: 'FOC111',
            asset_tag: 'NAAS-0000001',
            model: 'model1',
            po_number: 'PO0001',
            x_daas_ham_fleet: 'true',
            x_daas_ham_legal_owner: 'provider',
            company: 'provider',
            ...inStage('in_transit'),
        },
    ]
})

describe('receiving a bought unit for a waiting Order line', () => {
    it("reserves it for the line and stages it, its Staging task opened and its move saved, all under the line's lock", () => {
        const heldAt: Record<string, string[]> = {}
        platform.onSave = (table, row) => {
            if (table === STAGING_TASKS) heldAt.task = lockNames()
            if (table === ASSETS && stageOf({ installStatus: row.install_status, substatus: row.substatus }) === 'staging') heldAt.staging = lockNames()
        }

        expect(receive({ code: 'FOC111' }, 'staging1')).toHaveProperty('asset')

        expect(stageOfUnit()).toBe('staging')
        expect(unit()).toMatchObject({ x_daas_ham_order_line: 'line1', company: 'acme', x_daas_ham_agreement: 'agr1', stockroom: 'staging1' })
        expect(line().quantity_to_purchase).toBe('0')
        expect(rows(STAGING_TASKS)).toEqual([expect.objectContaining({ asset: 'asset1', order_line: 'line1' })])
        expect(heldAt.task).toContain(LOCK.orderLine('line1'))
        expect(heldAt.staging).toContain(LOCK.orderLine('line1'))
        expect(rows(LOCKS)).toEqual([])
    })

    it.each(['cancelled', 'rejected'])('leaves it free stock when the Order is %s, even on a line a refused cancel left awaiting stock', (stage) => {
        storedOrder().stage = stage
        const waiting = { ...line() }

        expect(receive({ code: 'FOC111' }, 'staging1')).toHaveProperty('asset')

        expect(stageOfUnit()).toBe('available')
        expect(unit()).toMatchObject({ stockroom: 'staging1', company: 'provider' })
        expect(unit().x_daas_ham_order_line ?? '').toBe('')
        expect(line()).toEqual(waiting)
        expect(rows(STAGING_TASKS)).toEqual([])
        expect(platform.warnings).toEqual([`[x_daas_ham] Received FOC111 left in stock, not given to ORL0001: its Order is ${stage}`])
        expect(rows(LOCKS)).toEqual([])
    })

    it("saves nothing while a cancel of its Order holds the line's lock, and says to scan again", () => {
        const theirs = { sys_id: 'theirs', name: LOCK.orderLine('line1'), sys_created_on: '2025-11-09 12:00:00' }
        ;(platform.tables[LOCKS] ??= []).push(theirs)
        const before = { ...unit() }

        expect(receive({ code: 'FOC111' }, 'staging1')).toEqual({ reason: 'busy', why: 'Its order line is being sourced, received or cancelled: scan again' })

        expect(unit()).toEqual(before)
        expect(rows(LOCKS)).toEqual([theirs])
    })

    it('names the RMA left open when an advance replacement finds its line on an ended Order', () => {
        // Announced with its RMA number in the PO field.
        unit().po_number = 'RMA-77'
        platform.tables[RMAS] = [{ sys_id: 'rma1', rma_number: 'RMA-77', order_line: 'line1', state: 'open' }]
        // The Order is cancelled between the receipt's find of the waiting line and its take of the line's lock.
        platform.onSave = (table, row) => {
            if (table === LOCKS && row.name === LOCK.orderLine('line1')) storedOrder().stage = 'cancelled'
        }

        expect(receive({ code: 'FOC111' }, 'staging1')).toHaveProperty('asset')

        expect(stageOfUnit()).toBe('available')
        expect(rows(RMAS)[0].state).toBe('open')
        expect(platform.warnings).toEqual([
            '[x_daas_ham] Received FOC111 left in stock, not given to ORL0001: its Order is cancelled; RMA RMA-77 left open, update it by hand',
        ])
    })
})
