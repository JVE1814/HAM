import { GlideRecord } from '@servicenow/glide'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fieldsOf, type Stage } from '../domain/lifecycle.ts'
import { LOCK } from '../domain/lock-names.ts'
import { PROPERTY } from '../domain/properties.ts'
import { completeInstallOfWork, confirmInstall, shipOrder } from './delivery.ts'
import type { ForeignRecord } from './records.ts'
import { platform, recordOf, type Row } from '../test-support/fake-glide.ts'

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

const aggregator = { sent: [] as string[], answer: { status: 200, body: '' } }

vi.mock('@servicenow/glide/sn_ws', () => ({
    RESTMessageV2: class {
        private body = ''
        setStringParameterNoEscape(): void {}
        setRequestHeader(): void {}
        setRequestBody(body: string): void {
            this.body = body
        }
        execute() {
            aggregator.sent.push(this.body)
            return { getStatusCode: () => aggregator.answer.status, getBody: () => aggregator.answer.body, getErrorMessage: () => '' }
        }
    },
}))

const ASSETS = 'alm_hardware'
const ORDERS = 'x_daas_ham_order'
const LINES = 'x_daas_ham_order_line'
const SHIPMENTS = 'x_daas_ham_shipment'
const CHANGES = 'change_request'
const WORK_ORDERS = 'wm_order'
const RETURNS = 'x_daas_ham_return_order'
const RETURN_LINES = 'x_daas_ham_return_order_line'
const LOCKS = 'x_daas_ham_job_lock'

const rows = (table: string): Row[] => platform.tables[table] ?? []
const asset = (id: string): Row => rows(ASSETS).find((row) => row.sys_id === id) ?? {}
const order = (): Row => rows(ORDERS)[0] ?? {}

function stage(of: Stage): Row {
    const { installStatus, substatus } = fieldsOf(of)
    return { install_status: installStatus, substatus: substatus ?? '' }
}

function unit(id: string, of: Stage, fields: Row = {}): Row {
    return { sys_id: id, serial_number: `FOC-${id}`, x_daas_ham_fleet: 'true', x_daas_ham_agreement: 'ag1', x_daas_ham_order_line: 'ol1', ...stage(of), ...fields }
}

function orderRecord(): GlideRecord {
    const found = new GlideRecord(ORDERS)
    found.get('o1')
    return found
}

beforeEach(() => {
    platform.reset()
    aggregator.sent.length = 0
    aggregator.answer = { status: 200, body: '' }
    platform.clock = Date.parse('2026-11-10T09:00:00Z')
    platform.uniqueKeys = { [LOCKS]: 'name' }
    platform.references = {
        [`${ASSETS}.x_daas_ham_order_line`]: LINES,
        [`${ORDERS}.site`]: 'cmn_location',
        [`${ORDERS}.customer`]: 'core_company',
    }
    platform.defaults = { [CHANGES]: () => ({ number: 'CHG0001' }), [WORK_ORDERS]: () => ({ number: 'WO0001' }) }
    platform.tables[LOCKS] = []
    platform.tables.core_company = [{ sys_id: 'acme', name: 'Acme' }]
    platform.tables.cmn_location = [
        { sys_id: 'site1', name: 'Acme HQ', street: 'Storgata 1', city: 'Bergen', zip: '5003', country: 'NO', phone: '+47 55 00 00 00' },
        { sys_id: 'depot-location', name: 'Depot', street: 'Havnegata 2', city: 'Oslo', zip: '0150', country: 'NO' },
    ]
    platform.tables.alm_stockroom = [{ sys_id: 'depot', name: 'Central depot', location: 'depot-location' }]
    platform.tables[ORDERS] = [
        {
            sys_id: 'o1',
            number: 'ORD0001',
            customer: 'acme',
            site: 'site1',
            agreement: 'ag1',
            order_type: 'site_rollout',
            install_mode: 'fsm_engineer',
            stage: 'delivering',
            carrier: 'ups',
            tracking_number: 'TYPED-BY-HAND',
        },
    ]
    platform.tables[LINES] = [{ sys_id: 'ol1', number: 'OL0001', order: 'o1', line_stage: 'ready_to_ship', quantity: '2' }]
    platform.tables[ASSETS] = [unit('a1', 'staged'), unit('a2', 'staged')]
    platform.tables[SHIPMENTS] = []
    platform.tables[CHANGES] = []
    platform.tables[WORK_ORDERS] = []
})

describe('Ship, with the tracking number typed on the Order', () => {
    it('moves the staged Assets to shipped at the Site, and opens the on-site work and links it to the Order', () => {
        expect(shipOrder('o1')).toEqual({ problems: [], shipped: { units: 2, siteName: 'Acme HQ' } })

        expect(asset('a1')).toMatchObject({ ...stage('shipped'), x_daas_ham_site: 'site1', location: 'site1' })
        expect(asset('a2')).toMatchObject({ ...stage('shipped'), x_daas_ham_site: 'site1', location: 'site1' })
        expect(rows(CHANGES)).toEqual([
            expect.objectContaining({ type: 'normal', parent: 'o1', short_description: 'ORD0001: site_rollout at Acme HQ', company: 'acme', location: 'site1' }),
        ])
        expect(rows(WORK_ORDERS)).toEqual([
            expect.objectContaining({
                x_daas_ham_purpose: 'install',
                initiated_from: 'o1',
                parent: rows(CHANGES)[0]?.sys_id,
                short_description: 'ORD0001: site_rollout at Acme HQ',
                company: 'acme',
                location: 'site1',
            }),
        ])
        expect(rows(WORK_ORDERS)[0]?.work_notes ?? '').toBe('')
        expect(order()).toMatchObject({ change_request: rows(CHANGES)[0]?.sys_id, work_order: rows(WORK_ORDERS)[0]?.sys_id, tracking_number: 'TYPED-BY-HAND' })
        expect(aggregator.sent).toEqual([])
        expect(rows(SHIPMENTS)).toEqual([])
        expect(rows(LOCKS)).toEqual([])
        expect(platform.logs).toEqual([])
    })

    it('opens the on-site work once: a second Ship, of Assets staged since, opens none', () => {
        shipOrder('o1')
        rows(ASSETS).push(unit('a3', 'staged'))

        expect(shipOrder('o1')).toEqual({ problems: [], shipped: { units: 1, siteName: 'Acme HQ' } })

        expect(asset('a3')).toMatchObject(stage('shipped'))
        expect(rows(CHANGES)).toHaveLength(1)
        expect(rows(WORK_ORDERS)).toHaveLength(1)
    })

    it('moves the Order on to what its lines say once the units are shipped', () => {
        // The after rule on alm_hardware derives a line's stage from its Assets. The fake runs no rule, so the test does.
        platform.onSave = (table, row) => {
            if (table === ASSETS && row.install_status === stage('shipped').install_status) Object.assign(rows(LINES)[0] ?? {}, { line_stage: 'shipped' })
        }

        shipOrder('o1')

        expect(order().stage).toBe('installing')
    })

    it.each([
        ['device_replace', 'fsm_engineer', { type: 'standard' }, { x_daas_ham_purpose: 'swap' }],
        ['refresh', 'fsm_engineer', { type: 'normal' }, { x_daas_ham_purpose: 'swap' }],
        ['device_add', 'subcontractor', { type: 'normal' }, { x_daas_ham_purpose: 'install', work_notes: 'Dispatch to subcontractor / remote hands.' }],
    ])('opens the work a %s Order installed by %s needs', (orderType, installMode, change, workOrder) => {
        Object.assign(order(), { order_type: orderType, install_mode: installMode })

        shipOrder('o1')

        expect(rows(CHANGES)).toEqual([expect.objectContaining(change)])
        expect(rows(WORK_ORDERS)).toEqual([expect.objectContaining(workOrder)])
    })

    it('opens no on-site work for a self-install', () => {
        order().install_mode = 'self_install'

        expect(shipOrder('o1')).toEqual({ problems: [], shipped: { units: 2, siteName: 'Acme HQ' } })

        expect(rows(CHANGES)).toEqual([])
        expect(rows(WORK_ORDERS)).toEqual([])
        expect(order().work_order ?? '').toBe('')
    })

    it('hands a hot spare over as shipped, with the staged Assets', () => {
        rows(ASSETS).push(unit('h1', 'spare_pool'))

        expect(shipOrder('o1')).toEqual({ problems: [], shipped: { units: 3, siteName: 'Acme HQ' } })

        expect(asset('h1')).toMatchObject({ ...stage('shipped'), x_daas_ham_site: 'site1', location: 'site1' })
    })

    it('leaves the Assets of another Order, and those of this one in another stage, where they are', () => {
        platform.tables[LINES].push({ sys_id: 'ol9', order: 'o9', line_stage: 'ready_to_ship', quantity: '1' })
        rows(ASSETS).push(unit('other', 'staged', { x_daas_ham_order_line: 'ol9' }), unit('a3', 'staging'), unit('a4', 'pending_in_service', { x_daas_ham_site: 'site1' }))

        expect(shipOrder('o1').shipped).toEqual({ units: 2, siteName: 'Acme HQ' })

        expect(asset('other')).toMatchObject(stage('staged'))
        expect(asset('other').x_daas_ham_site ?? '').toBe('')
        expect(asset('a3')).toMatchObject(stage('staging'))
        expect(asset('a4')).toMatchObject(stage('pending_in_service'))
    })
})

describe('a Ship that sends nothing', () => {
    function nothingShipped(): void {
        expect(asset('a1')).toMatchObject(stage('staged'))
        expect(asset('a1').x_daas_ham_site ?? '').toBe('')
        expect(rows(CHANGES)).toEqual([])
        expect(rows(WORK_ORDERS)).toEqual([])
        expect(rows(LOCKS).filter((lock) => lock.sys_id !== 'held')).toEqual([])
    }

    it("says another Ship is running while one holds the Order's Ship lock", () => {
        rows(LOCKS).push({ sys_id: 'held', name: LOCK.shipOrder('o1'), sys_created_on: '2026-11-10 09:00:00' })

        expect(shipOrder('o1')).toEqual({ problems: ['Another Ship of this Order is running: reload the Order to see what it shipped'], shipped: null })

        nothingShipped()
    })

    it('asks for the carrier and tracking number when the Order has none and the aggregator is off', () => {
        Object.assign(order(), { carrier: '', tracking_number: '' })

        expect(shipOrder('o1')).toEqual({ problems: ['Enter the carrier and tracking number before shipping'], shipped: null })

        nothingShipped()
    })

    it('asks for them again when the tracking number is a label an earlier Ship bought', () => {
        rows(SHIPMENTS).push({ sys_id: 'shp1', direction: 'to_site', order: 'o1', tracking_number: 'TYPED-BY-HAND', status: 'in_transit' })

        expect(shipOrder('o1')).toEqual({ problems: ['Enter the carrier and tracking number before shipping'], shipped: null })

        nothingShipped()
    })

    it('says nothing is staged when the Order has no staged Asset and no hot spare', () => {
        platform.tables[ASSETS] = [unit('a1', 'staging')]

        expect(shipOrder('o1')).toEqual({ problems: ['Nothing is staged for this order yet'], shipped: null })
    })

    it('says so when the Order is gone', () => {
        expect(shipOrder('no-such-order')).toEqual({ problems: ['Order not found'], shipped: null })

        expect(rows(LOCKS)).toEqual([])
    })

    it('says why when the lifecycle lets none of its Assets ship', () => {
        platform.tables[ASSETS] = [unit('a1', 'staged', { x_daas_ham_agreement: '' })]

        expect(shipOrder('o1')).toEqual({ problems: ['1 asset(s) cannot ship: An asset must belong to an agreement before it can be shipped'], shipped: null })

        nothingShipped()
    })
})

describe('a Ship that sends part of the Order', () => {
    it('ships the Assets the lifecycle lets ship, and reports the others', () => {
        asset('a2').x_daas_ham_agreement = ''

        expect(shipOrder('o1')).toEqual({
            problems: ['1 asset(s) cannot ship: An asset must belong to an agreement before it can be shipped'],
            shipped: { units: 1, siteName: 'Acme HQ' },
        })

        expect(asset('a1')).toMatchObject(stage('shipped'))
        expect(asset('a2')).toMatchObject(stage('staged'))
        expect(asset('a2').x_daas_ham_site ?? '').toBe('')
        expect(rows(WORK_ORDERS)).toHaveLength(1)
    })

    it('does not count an Asset the platform refuses to save as shipped, and logs it', () => {
        platform.refuses = (table, row) => (table === ASSETS && row.sys_id === 'a2' ? 'stage rule said no' : '')

        expect(shipOrder('o1')).toEqual({ problems: [], shipped: { units: 1, siteName: 'Acme HQ' } })

        expect(asset('a1')).toMatchObject(stage('shipped'))
        expect(asset('a2')).toMatchObject(stage('staged'))
        expect(platform.warnings).toEqual([expect.stringContaining('ship ORD0001: FOC-a2 not moved to shipped: stage rule said no')])
    })

    it('ships a hot spare without a carrier: it is at the Site already', () => {
        Object.assign(order(), { carrier: '', tracking_number: '' })
        platform.tables[ASSETS] = [unit('h1', 'spare_pool')]

        expect(shipOrder('o1')).toEqual({ problems: [], shipped: { units: 1, siteName: 'Acme HQ' } })

        expect(asset('h1')).toMatchObject(stage('shipped'))
    })

    it('ships to data-centre remote hands without a carrier', () => {
        Object.assign(order(), { carrier: '', tracking_number: '', install_mode: 'remote_hands' })

        expect(shipOrder('o1')).toEqual({ problems: [], shipped: { units: 2, siteName: 'Acme HQ' } })

        expect(rows(WORK_ORDERS)).toEqual([expect.objectContaining({ work_notes: 'Dispatch to subcontractor / remote hands.' })])
    })
})

describe('on-site work the platform refuses', () => {
    const UNOPENED = 'On-site work not opened (see the system log): open it by hand'

    it('is reported when the change is refused, the units shipped all the same', () => {
        platform.refuses = (table) => (table === CHANGES ? 'change freeze' : '')

        expect(shipOrder('o1')).toEqual({ problems: [UNOPENED], shipped: { units: 2, siteName: 'Acme HQ' } })

        expect(asset('a1')).toMatchObject(stage('shipped'))
        expect(rows(WORK_ORDERS)).toEqual([])
        expect(order().work_order ?? '').toBe('')
        expect(platform.warnings).toEqual([expect.stringContaining('No change for ORD0001: site_rollout at Acme HQ: change freeze')])
    })

    it('is reported when the work order is refused, and its change is named to be cancelled', () => {
        platform.refuses = (table) => (table === WORK_ORDERS ? 'no dispatch group' : '')

        expect(shipOrder('o1')).toEqual({ problems: [UNOPENED], shipped: { units: 2, siteName: 'Acme HQ' } })

        expect(rows(CHANGES)).toHaveLength(1)
        expect(order().change_request ?? '').toBe('')
        expect(platform.warnings).toEqual([expect.stringContaining('No work order for ORD0001: site_rollout at Acme HQ (CHG0001 has none, cancel it): no dispatch group')])
    })

    it('is reported as not linked when the Order is refused, and the next Ship opens it again', () => {
        platform.refuses = (table) => (table === ORDERS ? 'order is read only' : '')

        expect(shipOrder('o1')).toEqual({
            problems: ['On-site work opened but not linked to the Order: order is read only'],
            shipped: { units: 2, siteName: 'Acme HQ' },
        })

        expect(rows(WORK_ORDERS)).toHaveLength(1)
        expect(order().work_order ?? '').toBe('')

        platform.refuses = () => ''
        rows(ASSETS).push(unit('a3', 'staged'))
        shipOrder('o1')

        expect(rows(WORK_ORDERS)).toHaveLength(2)
        expect(order().work_order).toBe(rows(WORK_ORDERS)[1]?.sys_id)
    })
})

describe('Ship, with the shipping aggregator on', () => {
    const LABEL = JSON.stringify({ label_id: 'se-456', tracking_number: '1ZNEW02', carrier_code: 'ups', label_download: { pdf: 'https://labels.example/se-456.pdf' }, shipment_cost: { amount: 30, currency: 'NOK' } })

    beforeEach(() => {
        aggregator.answer = { status: 200, body: LABEL }
        platform.properties = {
            [PROPERTY.shippingEnabled.name]: 'true',
            [PROPERTY.shippingCarrierId.name]: 'se-carrier',
            [PROPERTY.stagingStockroom.name]: 'depot',
            [PROPERTY.shippingSenderPhone.name]: '+47 22 00 00 00',
        }
        Object.assign(order(), { carrier: '', tracking_number: '' })
    })

    it('buys one label, a box per staged Asset, saves its tracking number on the Order and ships the Assets', () => {
        rows(ASSETS).push(unit('h1', 'spare_pool'))

        expect(shipOrder('o1')).toEqual({ problems: [], shipped: { units: 3, siteName: 'Acme HQ' } })

        expect(aggregator.sent).toHaveLength(1)
        expect((JSON.parse(aggregator.sent[0] ?? '{}') as { shipment: { packages: unknown[] } }).shipment.packages).toHaveLength(2)
        expect(rows(SHIPMENTS)).toEqual([expect.objectContaining({ direction: 'to_site', order: 'o1', packages: '2', tracking_number: '1ZNEW02', status: 'label_created' })])
        expect(order()).toMatchObject({ carrier: 'ups', tracking_number: '1ZNEW02' })
        expect(asset('a1')).toMatchObject(stage('shipped'))
        expect(rows(LOCKS)).toEqual([])
    })

    it('buys a new label for Assets staged after an earlier Ship bought one', () => {
        shipOrder('o1')
        rows(ASSETS).push(unit('a3', 'staged'))
        aggregator.answer = { status: 200, body: LABEL.replace('1ZNEW02', '1ZNEW03') }

        expect(shipOrder('o1')).toEqual({ problems: [], shipped: { units: 1, siteName: 'Acme HQ' } })

        expect(rows(SHIPMENTS).map((shipment) => [shipment.tracking_number, shipment.packages])).toEqual([
            ['1ZNEW02', '2'],
            ['1ZNEW03', '1'],
        ])
        expect(order().tracking_number).toBe('1ZNEW03')
    })

    it('buys none when the tracking number was typed by hand', () => {
        Object.assign(order(), { carrier: 'dhl', tracking_number: 'TYPED-BY-HAND' })

        expect(shipOrder('o1')).toEqual({ problems: [], shipped: { units: 2, siteName: 'Acme HQ' } })

        expect(aggregator.sent).toEqual([])
        expect(order().tracking_number).toBe('TYPED-BY-HAND')
    })

    it('ships nothing, and opens no work, when no label is bought', () => {
        aggregator.answer = { status: 400, body: JSON.stringify({ errors: [{ message: 'carrier account suspended' }] }) }

        expect(shipOrder('o1')).toEqual({ problems: ['No shipping label: HTTP 400: carrier account suspended'], shipped: null })

        expect(asset('a1')).toMatchObject(stage('staged'))
        expect(rows(SHIPMENTS)).toEqual([])
        expect(rows(WORK_ORDERS)).toEqual([])
    })

    it('leaves alone an Asset that moved on while the label was bought', () => {
        // Another transaction puts a2 in the Spare pool as the label's Shipment is saved.
        platform.onSave = (table) => {
            if (table === SHIPMENTS) Object.assign(asset('a2'), stage('spare_pool'))
        }

        expect(shipOrder('o1')).toEqual({ problems: [], shipped: { units: 1, siteName: 'Acme HQ' } })

        expect(asset('a1')).toMatchObject(stage('shipped'))
        expect(asset('a2')).toMatchObject(stage('spare_pool'))
        expect(asset('a2').x_daas_ham_site ?? '').toBe('')
        expect(platform.logs).toEqual([])
    })

    it('ships the units, and reports each save of the Order the platform refuses', () => {
        platform.refuses = (table) => (table === ORDERS ? 'order is read only' : '')

        expect(shipOrder('o1')).toEqual({
            problems: ['Tracking number 1ZNEW02 not saved on the Order: order is read only', 'On-site work opened but not linked to the Order: order is read only'],
            shipped: { units: 2, siteName: 'Acme HQ' },
        })

        expect(rows(SHIPMENTS)).toHaveLength(1)
        expect(order().tracking_number).toBe('')
        expect(asset('a1')).toMatchObject(stage('shipped'))
        expect(asset('a2')).toMatchObject(stage('shipped'))
    })

    it('leaves a refused tracking number off the Order when the save that links the on-site work is accepted', () => {
        let refusedOnce = false
        platform.refuses = (table) => {
            if (table !== ORDERS || refusedOnce) return ''
            refusedOnce = true
            return 'try again later'
        }

        expect(shipOrder('o1')).toEqual({
            problems: ['Tracking number 1ZNEW02 not saved on the Order: try again later'],
            shipped: { units: 2, siteName: 'Acme HQ' },
        })

        expect(order()).toMatchObject({ carrier: '', tracking_number: '', change_request: rows(CHANGES)[0]?.sys_id, work_order: rows(WORK_ORDERS)[0]?.sys_id })
        expect(rows(SHIPMENTS)).toEqual([expect.objectContaining({ order: 'o1', tracking_number: '1ZNEW02' })])
    })

    it('links the on-site work to an Order whose tracking number alone the platform refuses', () => {
        platform.refuses = (table, row) => (table === ORDERS && row.tracking_number ? 'tracking numbers are locked' : '')

        expect(shipOrder('o1')).toEqual({
            problems: ['Tracking number 1ZNEW02 not saved on the Order: tracking numbers are locked'],
            shipped: { units: 2, siteName: 'Acme HQ' },
        })

        expect(order()).toMatchObject({ carrier: '', tracking_number: '', work_order: rows(WORK_ORDERS)[0]?.sys_id })

        rows(ASSETS).push(unit('a3', 'staged'))
        shipOrder('o1')

        expect(rows(WORK_ORDERS)).toHaveLength(1)
    })
})

describe('on-site work opened for an Order that is gone by then', () => {
    it('is reported as not linked', () => {
        // Another transaction deletes the Order as the work order is saved.
        platform.onSave = (table) => {
            if (table === WORK_ORDERS) platform.tables[ORDERS] = []
        }

        expect(shipOrder('o1')).toEqual({
            problems: ['On-site work opened but not linked to the Order: the Order can no longer be read'],
            shipped: { units: 2, siteName: 'Acme HQ' },
        })

        expect(rows(WORK_ORDERS)).toHaveLength(1)
    })
})

describe('confirming an install', () => {
    beforeEach(() => {
        order().stage = 'installing'
        platform.tables[ASSETS] = [unit('a1', 'shipped', { x_daas_ham_site: 'site1' }), unit('a2', 'shipped', { x_daas_ham_site: 'site1' })]
    })

    const INSTALLED = { ...stage('pending_in_service'), x_daas_ham_install_completed: '2026-11-10 09:00:00', x_daas_ham_site: 'site1' }

    it("moves the shipped units to pending in service, stamped with the time and the Order's Site", () => {
        asset('a2').x_daas_ham_site = 'old-site'

        expect(confirmInstall(orderRecord(), 'staff')).toEqual({ confirmed: true, refused: 0 })

        expect(asset('a1')).toMatchObject(INSTALLED)
        expect(asset('a2')).toMatchObject(INSTALLED)
        expect(platform.logs).toEqual([])
    })

    it('moves only the shipped units of an Order held back by a line filled again', () => {
        order().stage = 'delivering'
        rows(ASSETS).push(unit('a3', 'staged'), unit('h1', 'spare_pool'))

        expect(confirmInstall(orderRecord(), 'staff')).toEqual({ confirmed: true, refused: 0 })

        expect(asset('a1')).toMatchObject(INSTALLED)
        expect(asset('a3')).toMatchObject(stage('staged'))
        expect(asset('h1')).toMatchObject(stage('spare_pool'))
    })

    it('counts a unit the platform refuses to move, which stays shipped, and logs it', () => {
        platform.refuses = (table, row) => (table === ASSETS && row.sys_id === 'a2' ? 'stage rule said no' : '')

        expect(confirmInstall(orderRecord(), 'staff')).toEqual({ confirmed: true, refused: 1 })

        expect(asset('a1')).toMatchObject(INSTALLED)
        expect(asset('a2')).toMatchObject(stage('shipped'))
        expect(asset('a2').x_daas_ham_install_completed ?? '').toBe('')
        expect(platform.warnings).toEqual([expect.stringContaining('install ORD0001: FOC-a2 not moved to pending_in_service: stage rule said no')])
    })

    it('is refused when nothing waits to be installed', () => {
        order().stage = 'preparing'
        platform.tables[ASSETS] = [unit('a1', 'staged')]

        expect(confirmInstall(orderRecord(), 'staff')).toEqual({ confirmed: false, why: 'nothing_waiting' })

        expect(asset('a1')).toMatchObject(stage('staged'))
    })

    it("is the Customer's to give for a self-install only", () => {
        expect(confirmInstall(orderRecord(), 'customer')).toEqual({ confirmed: false, why: 'not_self_install' })
        expect(asset('a1')).toMatchObject(stage('shipped'))

        order().install_mode = 'self_install'

        expect(confirmInstall(orderRecord(), 'customer')).toEqual({ confirmed: true, refused: 0 })
        expect(asset('a1')).toMatchObject(INSTALLED)
    })

    it('records nothing when the form it was asked from is not saved', () => {
        expect(confirmInstall(orderRecord(), 'staff', () => false)).toEqual({ confirmed: false, why: 'unsaved' })

        expect(asset('a1')).toMatchObject(stage('shipped'))
    })

    it('moves the Order on to what its lines say', () => {
        // The after rule on alm_hardware derives a line's stage from its Assets. The fake runs no rule, so the test does.
        platform.onSave = (table) => {
            if (table === ASSETS) Object.assign(rows(LINES)[0] ?? {}, { line_stage: 'in_service' })
        }

        confirmInstall(orderRecord(), 'staff')

        expect(order()).toMatchObject({ stage: 'complete' })
    })
})

describe('an install that replaces an Asset', () => {
    beforeEach(() => {
        platform.defaults = { ...platform.defaults, [RETURNS]: () => ({ number: 'RET0001' }), [RETURN_LINES]: () => ({ status: 'awaiting' }) }
        platform.tables.x_daas_ham_agreement = [{ sys_id: 'ag1', overdue_return_days: '10' }]
        Object.assign(order(), { stage: 'installing', order_type: 'device_replace' })
        Object.assign(rows(LINES)[0] ?? {}, { line_stage: 'shipped', quantity: '1', replaces_asset: 'old1' })
        platform.tables[ASSETS] = [
            unit('a1', 'shipped', { x_daas_ham_site: 'site1' }),
            unit('old1', 'in_service', { x_daas_ham_order_line: '', x_daas_ham_site: 'site1', company: 'acme' }),
        ]
    })

    it('puts the Asset replaced on a Return order from the Order once its replacement is installed', () => {
        expect(confirmInstall(orderRecord(), 'staff')).toEqual({ confirmed: true, refused: 0 })

        expect(rows(RETURNS)).toEqual([expect.objectContaining({ number: 'RET0001', customer: 'acme', site: 'site1' })])
        expect(rows(RETURN_LINES).map((line) => [line.return_order, line.asset])).toEqual([[rows(RETURNS)[0]?.sys_id, 'old1']])
    })

    it('leaves the Asset replaced in service while its replacement is still shipped', () => {
        platform.refuses = (table, row) => (table === ASSETS && row.sys_id === 'a1' ? 'stage rule said no' : '')

        expect(confirmInstall(orderRecord(), 'staff')).toEqual({ confirmed: true, refused: 1 })

        expect(rows(RETURNS)).toEqual([])
        expect(asset('old1')).toMatchObject(stage('in_service'))
    })
})

describe('a work order closed complete', () => {
    const closed = (fields: Row): ForeignRecord => recordOf<ForeignRecord>(WORK_ORDERS, { sys_id: 'wo1', initiated_from: 'o1', x_daas_ham_purpose: 'install', ...fields })

    beforeEach(() => {
        order().stage = 'installing'
        platform.tables[ASSETS] = [unit('a1', 'shipped', { x_daas_ham_site: 'site1' })]
    })

    it.each(['install', 'swap'])('completes the install of the Order it was initiated from when its purpose is %s', (purpose) => {
        completeInstallOfWork(closed({ x_daas_ham_purpose: purpose }))

        expect(asset('a1')).toMatchObject({ ...stage('pending_in_service'), x_daas_ham_install_completed: '2026-11-10 09:00:00' })
    })

    it.each([
        ['a de-install job', { x_daas_ham_purpose: 'de_install' }],
        ['a site audit', { x_daas_ham_purpose: 'site_audit' }],
        ['work with no purpose', { x_daas_ham_purpose: '' }],
        ['work initiated from no Order', { initiated_from: '' }],
        ['work initiated from another record', { initiated_from: 'ret1' }],
    ])('completes nothing for %s', (_what, fields) => {
        completeInstallOfWork(closed(fields))

        expect(asset('a1')).toMatchObject(stage('shipped'))
    })
})
