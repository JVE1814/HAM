import { beforeEach, describe, expect, it, vi } from 'vitest'
import { JOB } from '../domain/chunked-job.ts'
import { fieldsOf, type Stage } from '../domain/lifecycle.ts'
import { RETURN_LINE_STATUS } from '../domain/vocabulary.ts'
import { readStage } from './assets.ts'
import { onLineAssetMoved } from './fulfilment.ts'
import { findById } from './records.ts'
import { raiseDueReturns } from './scheduled-returns.ts'
import { platform, type Row } from '../test-support/fake-glide.ts'

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
    platform.defaults = { [RETURNS]: () => ({ number: 'RET0001' }), [RETURN_LINES]: () => ({ status: RETURN_LINE_STATUS.awaiting }) }
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
        expect(rows('x_daas_ham_order_line').find((line) => line.sys_id === 'l2')?.line_stage).toBe('shipped')
        expect(platform.events).toEqual([])
    })
})

describe('more records left for a later run than one run reads', () => {
    const CURSORS = 'x_daas_ham_job_cursor'
    const AGREEMENTS = 'x_daas_ham_agreement'
    const nth = (prefix: string, n: number) => `${prefix}${String(n).padStart(2, '0')}`
    const cursorOf = (job: string) => rows(CURSORS).find((cursor) => cursor.job === job)?.cursor ?? ''

    beforeEach(() => {
        platform.uniqueKeys = { x_daas_ham_job_lock: 'name', [CURSORS]: 'job' }
        platform.clock = Date.parse('2026-12-20T06:00:00Z')
        platform.tables[ORDERS] = []
        platform.tables.x_daas_ham_order_line = []
    })

    it('reaches a temporary Order behind 50 still being installed, on the next run', () => {
        const order = (sysId: string, fields: Row): Row => ({ sys_id: sysId, number: sysId.toUpperCase(), order_type: 'temporary', return_raised: 'false', install_mode: 'self_install', customer: 'c1', site: 's1', agreement: 'ag1', ...fields })
        const installing = Array.from({ length: 50 }, (_, n) => order(nth('o', n + 1), { stage: 'installing', end_date: '2026-12-21' }))
        platform.tables[ORDERS] = [...installing, order('o99', { stage: 'complete', end_date: '2026-12-24' })]
        platform.tables.x_daas_ham_order_line = [{ sys_id: 'l99', number: 'OL99', order: 'o99', quantity: '1', line_stage: 'installed' }]
        platform.tables.alm_hardware = [unit('switch', 'l99', 'temporary_deployment')]

        raiseDueReturns()

        expect(rows(RETURNS)).toEqual([])
        expect(cursorOf(JOB.temporaryOrderReturns)).toBe('o50')
        expect(platform.warnings).toEqual([expect.stringContaining(`${JOB.temporaryOrderReturns}: each of the 50 records read was left for a later run`)])

        raiseDueReturns()

        expect(returned()).toEqual(['switch'])
        expect(rows(ORDERS).find((stored) => stored.sys_id === 'o99')?.return_raised).toBe('true')
        expect(cursorOf(JOB.temporaryOrderReturns)).toBe('')
    })

    it('reaches an ended Agreement behind 50 whose Return is refused, on the next run', () => {
        const agreement = (sysId: string): Row => ({ sys_id: sysId, number: sysId.toUpperCase(), customer: 'c1', ends: '2026-11-30', end_return_raised: 'false' })
        const refusedOnes = Array.from({ length: 50 }, (_, n) => agreement(nth('ag', n + 1)))
        platform.tables[AGREEMENTS] = [...refusedOnes, agreement('ag99')]
        platform.tables.alm_hardware = [...refusedOnes, agreement('ag99')].map((ended) => ({ ...unit(`unit-${ended.sys_id}`, '', 'in_service'), x_daas_ham_agreement: ended.sys_id ?? '' }))
        platform.refuses = (table, row, operation) => (table === RETURNS && operation === 'insert' && row.agreement !== 'ag99' ? 'refused for this test' : '')

        raiseDueReturns()

        expect(rows(RETURNS)).toEqual([])
        expect(cursorOf(JOB.endedAgreementReturns)).toBe('ag50')
        expect(platform.warnings).toContainEqual(expect.stringContaining(`${JOB.endedAgreementReturns}: each of the 50 records read was left for a later run`))

        raiseDueReturns()

        expect(rows(RETURNS).map((raised) => raised.agreement)).toEqual(['ag99'])
        expect(returned()).toEqual(['unit-ag99'])
        expect(rows(AGREEMENTS).find((stored) => stored.sys_id === 'ag99')?.end_return_raised).toBe('true')
        expect(cursorOf(JOB.endedAgreementReturns)).toBe('')
    })

    it('starts over once it has read to the end, so a record left earlier gets its turn again', () => {
        const agreement = (sysId: string): Row => ({ sys_id: sysId, number: sysId.toUpperCase(), customer: 'c1', ends: '2026-11-30', end_return_raised: 'false' })
        platform.tables[AGREEMENTS] = [agreement('ag01'), agreement('ag99')]
        platform.tables.alm_hardware = [{ ...unit('unit-ag01', '', 'in_service'), x_daas_ham_agreement: 'ag01' }]
        platform.tables[CURSORS] = [{ sys_id: 'cur1', job: JOB.endedAgreementReturns, cursor: 'ag99' }]

        raiseDueReturns()

        expect(returned()).toEqual(['unit-ag01'])
        expect(rows(AGREEMENTS).map((stored) => stored.end_return_raised)).toEqual(['true', 'true'])
        expect(cursorOf(JOB.endedAgreementReturns)).toBe('')
    })
})
