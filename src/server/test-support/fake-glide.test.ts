import { beforeEach, describe, expect, it } from 'vitest'
import { conditionsOf, glide, platform, recordOf } from './fake-glide'

const { GlideRecord, GlideAggregate, GlideDateTime, gs } = glide

const LINES = 'x_daas_ham_order_line'
const ORDERS = 'x_daas_ham_order'

function find(table: string, sysId: string) {
    const record = new GlideRecord(table)
    expect(record.get(sysId), `${table} ${sysId}`).toBe(true)
    return record
}

function idsOf(record: InstanceType<typeof GlideRecord>): string[] {
    const ids: string[] = []
    record.query()
    while (record.next()) ids.push(record.getUniqueValue())
    return ids
}

beforeEach(() => {
    platform.reset()
    platform.references = { [`${LINES}.order`]: ORDERS }
    platform.tables[ORDERS] = [
        { sys_id: 'o1', number: 'ORD1', customer: 'acme', stage: 'sourcing' },
        { sys_id: 'o2', number: 'ORD2', customer: 'globex', stage: 'complete' },
    ]
    platform.tables[LINES] = [
        { sys_id: 'l1', order: 'o1', quantity: '2', line_stage: 'new' },
        { sys_id: 'l2', order: 'o1', quantity: '10', line_stage: 'awaiting_stock' },
        { sys_id: 'l3', order: 'o2', quantity: '1', line_stage: 'installed' },
        { sys_id: 'l4', order: '', quantity: '5', line_stage: 'new' },
    ]
})

describe('reading', () => {
    it('finds the rows every condition keeps, through the declared references', () => {
        const line = new GlideRecord(LINES)
        line.addQuery('order.customer', 'acme')
        line.addQuery('line_stage', 'IN', 'new,installed')
        expect(idsOf(line)).toEqual(['l1'])

        const either = new GlideRecord(LINES)
        either.addQuery('line_stage', 'installed').addOrCondition('quantity', '>=', 5)
        either.addNotNullQuery('order')
        expect(idsOf(either)).toEqual(['l2', 'l3'])
        expect(conditionsOf(either)).toEqual(['line_stage=installed^ORquantity>=5', 'orderISNOTEMPTY'])
    })

    it('orders by the fields named, numbers as numbers, and stops at the limit', () => {
        const line = new GlideRecord(LINES)
        line.orderByDesc('line_stage')
        line.orderBy('quantity')
        expect(idsOf(line)).toEqual(['l1', 'l4', 'l3', 'l2'])
        line.setLimit(2)
        expect(idsOf(line)).toEqual(['l1', 'l4'])
    })

    it('fails the test on an operator, a reference or a ^NQ combination it does not know', () => {
        const unknown = new GlideRecord(LINES)
        unknown.addEncodedQuery('line_stageENDSWITHstock')
        expect(() => unknown.query()).toThrow('unknown term')
        expect(() => new GlideRecord(LINES).addQuery('line_stage', 'BETWEEN', 'a@b')).toThrow('addQuery operator "BETWEEN"')

        const undeclared = new GlideRecord(LINES)
        undeclared.addQuery('model.name', 'C9300')
        expect(() => undeclared.query()).toThrow(`${LINES}.model is dot-walked but not declared`)

        const combined = new GlideRecord(LINES)
        combined.addEncodedQuery('line_stage=new^NQline_stage=installed')
        expect(idsOf(combined)).toEqual(['l1', 'l3', 'l4'])
        combined.addQuery('order', 'o1')
        expect(() => combined.query()).toThrow('^NQ')
    })

    it('gives null for a blank field and for a dotted name, which getElement walks', () => {
        const line = find(LINES, 'l4')
        expect(line.getValue('order')).toBeNull()
        expect(line.getValue('no_such_field')).toBeNull()
        expect(line.getValue('quantity')).toBe('5')
        expect(find(LINES, 'l1').getValue('order.customer')).toBeNull()
        expect(find(LINES, 'l1').getElement('order.customer').getValue()).toBe('acme')
        expect(line.getElement('order.customer').getValue()).toBeNull()
        expect(find(LINES, 'l1').getDisplayValue('order')).toBe('ORD1')
    })

    it('gets a record by sys_id or by a field, and none for a blank value', () => {
        const order = new GlideRecord(ORDERS)
        expect(order.get('number', 'ORD2')).toBe(true)
        expect(order.getUniqueValue()).toBe('o2')
        expect(order.get('o9')).toBe(false)
        expect(order.get('')).toBe(false)
    })

    it('counts and sums by group', () => {
        const byOrder = new GlideAggregate(LINES)
        byOrder.addEncodedQuery('orderISNOTEMPTY')
        byOrder.addAggregate('COUNT', '')
        byOrder.addAggregate('SUM', 'quantity')
        byOrder.groupBy('order.customer')
        byOrder.query()
        const groups: string[] = []
        while (byOrder.next()) groups.push(`${byOrder.getValue('order.customer')} ${byOrder.getAggregate('COUNT', '')} ${byOrder.getAggregate('SUM', 'quantity')}`)
        expect(groups).toEqual(['acme 2 12', 'globex 1 1'])

        const none = new GlideAggregate(LINES)
        none.addQuery('line_stage', 'cancelled')
        none.addAggregate('COUNT', '')
        none.query()
        expect(none.next()).toBe(true)
        expect(none.getAggregate('COUNT', '')).toBe('0')
        expect(() => none.addAggregate('STDDEV', 'quantity')).toThrow('aggregate "STDDEV"')
    })
})

describe('saving', () => {
    it('inserts with a new sys_id, the time and what the platform fills in', () => {
        platform.defaults[ORDERS] = () => ({ number: 'ORD3', stage: 'draft' })
        const order = new GlideRecord(ORDERS)
        order.initialize()
        expect(order.isNewRecord()).toBe(true)
        order.setValue('customer', 'acme')
        order.setValue('stage', 'sourcing')
        order.setValue('expedite', true)
        const id = order.insert()
        expect(id).toBe(order.getUniqueValue())
        expect(order.isNewRecord()).toBe(false)
        expect(platform.tables[ORDERS].at(-1)).toEqual({
            sys_id: id,
            number: 'ORD3',
            customer: 'acme',
            stage: 'sourcing',
            expedite: 'true',
            sys_created_on: '2025-11-09 12:00:00',
            sys_updated_on: '2025-11-09 12:00:00',
        })
    })

    it('updates only what changed since the record was read, and nothing when nothing did', () => {
        const saves: string[] = []
        platform.onSave = (table, row, operation) => void saves.push(`${operation} ${table} ${row.sys_id}`)
        const mine = find(LINES, 'l1')
        const theirs = find(LINES, 'l1')
        theirs.setValue('quantity', 3)
        expect(theirs.update()).toBe('l1')
        mine.setValue('line_stage', 'awaiting_stock')
        expect(mine.update()).toBe('l1')
        expect(platform.tables[LINES][0]).toMatchObject({ quantity: '3', line_stage: 'awaiting_stock' })
        mine.setValue('line_stage', 'awaiting_stock')
        expect(mine.update()).toBe('l1')
        expect(saves).toEqual([`update ${LINES} l1`, `update ${LINES} l1`])
    })

    it('refuses what the test, a unique index or a table rule refuses, with why', () => {
        platform.uniqueKeys[ORDERS] = 'number'
        platform.constraints[ORDERS] = (row) => (row.customer ? '' : 'Customer is mandatory')
        const order = new GlideRecord(ORDERS)
        order.initialize()
        order.setValue('number', 'ORD1')
        order.setValue('customer', 'acme')
        expect(order.insert()).toBeNull()
        expect(order.getLastErrorMessage()).toBe('Unique Key violation detected by database')
        order.setValue('number', 'ORD9')
        order.setValue('customer', '')
        expect(order.insert()).toBeNull()
        expect(order.getLastErrorMessage()).toBe('Customer is mandatory')

        platform.refuses = (table, row, operation) => (table === ORDERS && row.stage === 'cancelled' ? `no ${operation}` : '')
        const stored = find(ORDERS, 'o1')
        stored.setValue('stage', 'cancelled')
        expect(stored.update()).toBeNull()
        expect(stored.getLastErrorMessage()).toBe('no update')
        expect(platform.tables[ORDERS][0].stage).toBe('sourcing')
        platform.tables[ORDERS][1].stage = 'cancelled'
        expect(find(ORDERS, 'o2').deleteRecord()).toBe(false)
        expect(platform.tables[ORDERS]).toHaveLength(2)
    })

    it('fails the test on an update of a record that is not stored', () => {
        const gone = find(LINES, 'l1')
        platform.tables[LINES] = []
        gone.setValue('quantity', 4)
        expect(() => gone.update()).toThrow('not stored')
        const unsaved = new GlideRecord(LINES)
        unsaved.initialize()
        unsaved.setValue('quantity', 4)
        expect(() => unsaved.update()).toThrow('not stored')
    })

    it('deletes one record, or every one a query matches', () => {
        expect(find(LINES, 'l3').deleteRecord()).toBe(true)
        const fresh = new GlideRecord(LINES)
        fresh.addQuery('line_stage', 'new')
        fresh.deleteMultiple()
        expect(platform.tables[LINES].map((row) => row.sys_id)).toEqual(['l2'])
    })

    it('keeps the rows of a table and of those that extend it together, each seen by its class', () => {
        platform.parents = { cmdb_hardware_model_lifecycle: ['cmdb_model_lifecycle'] }
        const hardware = new GlideRecord('cmdb_hardware_model_lifecycle')
        hardware.initialize()
        hardware.setValue('lifecycle_phase', 'end_of_sale')
        hardware.insert()
        platform.tables.cmdb_model_lifecycle.push({ sys_id: 'byhand', sys_class_name: 'cmdb_model_lifecycle', lifecycle_phase: 'end_of_life' })
        expect(idsOf(new GlideRecord('cmdb_model_lifecycle'))).toEqual([hardware.getUniqueValue(), 'byhand'])
        expect(idsOf(new GlideRecord('cmdb_hardware_model_lifecycle'))).toEqual([hardware.getUniqueValue()])
        expect(platform.tables.cmdb_model_lifecycle[0].sys_class_name).toBe('cmdb_hardware_model_lifecycle')
    })
})

describe('the rest of the instance', () => {
    it('holds a record handed to a rule without storing it', () => {
        const current = recordOf<InstanceType<typeof GlideRecord>>(LINES, { sys_id: 'l9', order: 'o2' })
        expect(current.getElement('order.stage').getValue()).toBe('complete')
        expect(current.isNewRecord()).toBe(false)
        expect(recordOf<InstanceType<typeof GlideRecord>>(LINES, {}, { fresh: true }).isNewRecord()).toBe(true)
        expect(platform.tables[LINES]).toHaveLength(4)
    })

    it('queues events, logs and reads the clock, the user and the properties the test set', () => {
        platform.user = { id: 'u1', name: 'Ada', company: 'acme', roles: ['x_daas_ham.noc'], interactive: true }
        platform.properties.batch = '5'
        gs.eventQueue('x_daas_ham.order.source', find(ORDERS, 'o1'), 'o1')
        gs.eventQueueScheduled('x_daas_ham.order.source', find(ORDERS, 'o2'), 'o2', '1')
        gs.warn('careful')
        gs.error('broken')
        expect(platform.events).toEqual([
            { name: 'x_daas_ham.order.source', record: 'o1', parm1: 'o1', parm2: '', delayed: false },
            { name: 'x_daas_ham.order.source', record: 'o2', parm1: 'o2', parm2: '1', delayed: true },
        ])
        expect(platform.logs).toEqual(['warn careful', 'error broken'])
        expect(platform.warnings).toEqual(['careful'])
        expect([gs.getUserID(), gs.getUser().getCompanyID(), gs.hasRole('x_daas_ham.noc'), gs.hasRole('admin')]).toEqual(['u1', 'acme', true, false])
        expect([gs.getProperty('batch', '2'), gs.getProperty('budget', '120')]).toEqual(['5', '120'])

        platform.clock += 90000
        const now = new GlideDateTime()
        now.addSeconds(-30)
        expect(now.getValue()).toBe('2025-11-09 12:01:00')
        const ended = new GlideRecord(LINES)
        ended.addEncodedQuery('ends<javascript:gs.beginningOfToday()')
        platform.tables[LINES] = [{ sys_id: 'old', ends: '2025-11-08 23:59:59' }, { sys_id: 'today', ends: '2025-11-09 00:00:00' }]
        expect(idsOf(ended)).toEqual(['old'])
    })
})
