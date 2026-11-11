import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fieldsOf, type Stage } from '../domain/lifecycle.ts'
import { readStage } from './assets.ts'
import { onLineAssetMoved } from './fulfilment.ts'
import { findById } from './records.ts'
import { raiseDueReturns } from './scheduled-returns.ts'
import { platform, type Row } from '../test-support/fake-glide.ts'

/*
 * The daily job's Return for a temporary Order of two units (a switch and an access point) ending 2026-12-24, with the
 * default lead of 7 days, run against the in-memory stand-in for the platform.
 */

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

const ORDERS = 'x_daas_ham_order'
const RETURNS = 'x_daas_ham_return_order'
const RETURN_LINES = 'x_daas_ham_return_order_line'

const rows = (table: string): Row[] => platform.tables[table] ?? []

function unit(sysId: string, line: string, stage: Stage): Row {
    const { installStatus, substatus } = fieldsOf(stage)
    return { sys_id: sysId, serial_number: sysId.toUpperCase(), x_daas_ham_fleet: 'true', x_daas_ham_order_line: line, x_daas_ham_site: 's1', x_daas_ham_agreement: 'ag1', install_status: installStatus, substatus: substatus ?? '' }
}

function runOn(day: string, accessPoint: Stage): void {
    platform.clock = Date.parse(`${day}T06:00:00Z`)
    platform.tables.alm_hardware = [unit('switch', 'l1', 'temporary_deployment'), unit('ap', 'l2', accessPoint)]
    raiseDueReturns()
}

const returned = () => rows(RETURN_LINES).map((line) => line.asset)
const marked = () => String(rows(ORDERS)[0]?.return_raised)

beforeEach(() => {
    platform.reset()
    platform.uniqueKeys = { x_daas_ham_job_lock: 'name' }
    platform.defaults = { [RETURNS]: () => ({ number: 'RET0001' }), [RETURN_LINES]: () => ({ status: 'awaiting' }) }
    platform.references = { 'alm_hardware.x_daas_ham_order_line': 'x_daas_ham_order_line', 'x_daas_ham_order_line.order': ORDERS, 'x_daas_ham_return_order_line.return_order': RETURNS }
    platform.tables[ORDERS] = [
        { sys_id: 'o1', number: 'ORD0001', order_type: 'temporary', return_raised: 'false', end_date: '2026-12-24', stage: 'installing', install_mode: 'self_install', customer: 'c1', site: 's1', agreement: 'ag1' },
    ]
    platform.tables.x_daas_ham_order_line = [
        { sys_id: 'l1', number: 'OL1', order: 'o1', quantity: '1', line_stage: 'installed' },
        { sys_id: 'l2', number: 'OL2', order: 'o1', quantity: '1', line_stage: 'shipped' },
    ]
})

describe('a temporary Order still being installed', () => {
    it('waits while a unit is still shipped and its end date has not passed', () => {
        runOn('2026-12-20', 'shipped')
        expect(rows(RETURNS)).toEqual([])
        expect(marked()).toBe('false')
    })

    it('brings every unit back once all are installed', () => {
        runOn('2026-12-20', 'pending_in_service')
        expect(returned().sort()).toEqual(['ap', 'switch'])
        expect(marked()).toBe('true')
    })

    it('brings the units still shipped back too once its end date has passed', () => {
        runOn('2026-12-25', 'shipped')
        expect(returned().sort()).toEqual(['ap', 'switch'])
        expect(marked()).toBe('true')
    })

    it('keeps a unit shipped when the end came on its line, which is not sourced again', () => {
        runOn('2026-12-25', 'shipped')
        const ap = findById('alm_hardware', 'ap')!
        expect(readStage(ap)).toBe('pending_return')
        onLineAssetMoved(ap, 'l2', 'shipped', readStage(ap))
        expect(rows('alm_hardware').find((asset) => asset.sys_id === 'ap')?.x_daas_ham_order_line).toBe('l2')
        expect(rows('x_daas_ham_order_line').find((line) => line.sys_id === 'l2')?.line_stage).not.toBe('awaiting_stock')
    })
})
