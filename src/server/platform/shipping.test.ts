import { GlideRecord } from '@servicenow/glide'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EVENT } from '../domain/events.ts'
import { LOCK } from '../domain/lock-names.ts'
import { PROPERTY } from '../domain/properties.ts'
import { SHIPPING_MESSAGE, type TrackingEvent, type TrackingUpdate } from '../domain/shipping.ts'
import { withLock } from './locks.ts'
import { labelOrder, labelReturn, orderLabelBought, retryTracking, trackShipment, voidLabel } from './shipping.ts'
import { platform, type Row } from '../test-support/fake-glide.ts'

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

/** What the aggregator is sent, what it answers each call, and what happens on the platform while it is called. */
const aggregator = {
    sent: [] as Array<{ message: string; fn: string; body: string }>,
    answer: { status: 200, body: '' },
    whileCalled: (): void => undefined,
}

vi.mock('@servicenow/glide/sn_ws', () => ({
    RESTMessageV2: class {
        private body = ''
        constructor(
            private readonly message: string,
            private readonly fn: string,
        ) {}
        setStringParameterNoEscape(): void {}
        setRequestHeader(): void {}
        setRequestBody(body: string): void {
            this.body = body
        }
        execute() {
            aggregator.sent.push({ message: this.message, fn: this.fn, body: this.body })
            aggregator.whileCalled()
            return { getStatusCode: () => aggregator.answer.status, getBody: () => aggregator.answer.body, getErrorMessage: () => '' }
        }
    },
}))

const SHIPMENTS = 'x_daas_ham_shipment'
const SHIPMENT_EVENTS = 'x_daas_ham_shipment_event'
const ORDERS = 'x_daas_ham_order'
const RETURNS = 'x_daas_ham_return_order'
const RETURN_LINES = 'x_daas_ham_return_order_line'
const LOCKS = 'x_daas_ham_job_lock'

const rows = (table: string): Row[] => platform.tables[table] ?? []
const shipment = (id = 'shp1'): Row => rows(SHIPMENTS).find((row) => row.sys_id === id) ?? {}
const order = (): Row => rows(ORDERS)[0] ?? {}
const returnOrder = (): Row => rows(RETURNS)[0] ?? {}
const storedEvents = () => rows(SHIPMENT_EVENTS).map((row) => [row.shipment, row.occurred_at, row.status, row.description, row.location])

function record(table: string, id: string): GlideRecord {
    const found = new GlideRecord(table)
    found.get(id)
    return found
}

/** Another holder has the lock `name`: its row is stored, taken just now. */
function held(name: string): void {
    rows(LOCKS).push({ sys_id: `lock-${name}`, name, sys_created_on: '2026-11-10 09:00:00' })
}

const PICKED_UP: TrackingEvent = { occurredAt: '2026-11-10T08:00:00Z', status: 'in_transit', description: 'Picked up', location: 'Oslo, NO' }
const AT_HUB: TrackingEvent = { occurredAt: '2026-11-10T14:00:00Z', status: 'in_transit', description: 'Arrived at hub', location: 'Bergen, NO' }
const ON_VAN: TrackingEvent = { occurredAt: '2026-11-11T07:00:00Z', status: 'out_for_delivery', description: 'Out for delivery', location: 'Bergen, NO' }
const HANDED_OVER: TrackingEvent = { occurredAt: '2026-11-11T10:15:00Z', status: 'delivered', description: 'Delivered', location: 'Bergen, NO' }

function update(fields: Partial<TrackingUpdate> = {}): TrackingUpdate {
    return { trackingNumber: '1Z999', status: 'in_transit', description: 'Arrived at hub', estimatedDelivery: '2026-11-12', events: [PICKED_UP, AT_HUB], ...fields }
}

const OUT_FOR_DELIVERY = update({ status: 'out_for_delivery', description: 'Out for delivery', estimatedDelivery: '2026-11-11', events: [PICKED_UP, AT_HUB, ON_VAN] })
const DELIVERED = update({ status: 'delivered', description: 'Delivered', deliveredAt: '2026-11-11T10:15:00Z', events: [PICKED_UP, AT_HUB, ON_VAN, HANDED_OVER] })

beforeEach(() => {
    platform.reset()
    aggregator.sent.length = 0
    aggregator.answer = { status: 200, body: '' }
    aggregator.whileCalled = () => undefined
    platform.clock = Date.parse('2026-11-10T09:00:00Z')
    platform.user = { ...platform.user, id: 'u1', name: 'Ada' }
    platform.uniqueKeys = { [LOCKS]: 'name' }
    platform.references = {
        [`${ORDERS}.site`]: 'cmn_location',
        [`${ORDERS}.customer`]: 'core_company',
        [`${RETURNS}.customer`]: 'core_company',
    }
    platform.tables[LOCKS] = []
    platform.tables.core_company = [{ sys_id: 'acme', name: 'Acme' }]
    platform.tables.cmn_location = [
        { sys_id: 'site1', name: 'Acme HQ', street: 'Storgata 1', city: 'Bergen', zip: '5003', country: 'NO', phone: '+47 55 00 00 00' },
        { sys_id: 'depot-location', name: 'Depot', street: 'Havnegata 2', city: 'Oslo', zip: '0150', country: 'Norway' },
    ]
    platform.tables.alm_stockroom = [{ sys_id: 'depot', name: 'Central depot', location: 'depot-location' }]
    platform.tables[ORDERS] = [{ sys_id: 'o1', number: 'ORD0001', customer: 'acme', site: 'site1', carrier: 'ups', tracking_number: '1Z999' }]
    platform.tables[SHIPMENTS] = [
        { sys_id: 'shp1', number: 'NSHP0001', direction: 'to_site', order: 'o1', customer: 'acme', site: 'site1', carrier: 'ups', tracking_number: '1Z999', status: 'label_created' },
    ]
    platform.tables[SHIPMENT_EVENTS] = []
})

describe('a tracking update for a stored Shipment', () => {
    it('sets its status, latest update and estimated delivery, and stores its events', () => {
        expect(trackShipment(update())).toEqual({ outcome: 'applied', status: 'in_transit' })

        expect(shipment()).toMatchObject({ status: 'in_transit', status_detail: 'Arrived at hub', estimated_delivery: '2026-11-12' })
        expect(shipment().delivered_at ?? '').toBe('')
        expect(storedEvents()).toEqual([
            ['shp1', '2026-11-10T08:00:00Z', 'in_transit', 'Picked up', 'Oslo, NO'],
            ['shp1', '2026-11-10T14:00:00Z', 'in_transit', 'Arrived at hub', 'Bergen, NO'],
        ])
        expect(order().work_notes ?? '').toBe('')
        expect(rows(LOCKS)).toEqual([])
        expect(platform.logs).toEqual([])
    })

    it('is unmatched, and writes nothing, when no Shipment has its tracking number', () => {
        expect(trackShipment(update({ trackingNumber: 'NOSUCH1' }))).toEqual({ outcome: 'unmatched' })

        expect(shipment().status).toBe('label_created')
        expect(storedEvents()).toEqual([])
    })

    it('stores no event twice when the same update is sent again', () => {
        trackShipment(update())

        expect(trackShipment(update())).toEqual({ outcome: 'applied', status: 'in_transit' })

        expect(storedEvents()).toHaveLength(2)
    })

    it('adds only the events not stored yet when the whole history is sent again', () => {
        trackShipment(update())

        expect(trackShipment(OUT_FOR_DELIVERY)).toEqual({ outcome: 'applied', status: 'out_for_delivery' })

        expect(shipment()).toMatchObject({ status: 'out_for_delivery', status_detail: 'Out for delivery', estimated_delivery: '2026-11-11' })
        expect(storedEvents().map(([, , , description]) => description)).toEqual(['Picked up', 'Arrived at hub', 'Out for delivery'])
    })

    it('stores an event once when one update lists it twice', () => {
        trackShipment(update({ events: [PICKED_UP, PICKED_UP] }))

        expect(storedEvents()).toHaveLength(1)
    })

    it('that is older than one already applied adds its events and leaves the status, latest update and estimate alone', () => {
        trackShipment(update({ status: 'out_for_delivery', description: 'Out for delivery', estimatedDelivery: '2026-11-11', events: [ON_VAN] }))

        expect(trackShipment(update())).toEqual({ outcome: 'applied', status: 'out_for_delivery' })

        expect(shipment()).toMatchObject({ status: 'out_for_delivery', status_detail: 'Out for delivery', estimated_delivery: '2026-11-11' })
        expect(storedEvents().map(([, , , description]) => description)).toEqual(['Out for delivery', 'Picked up', 'Arrived at hub'])
    })

    it('of unknown status keeps the status and the latest update, and stores its events', () => {
        trackShipment(update())

        expect(trackShipment(update({ status: 'unknown', description: 'No information', events: [PICKED_UP, AT_HUB, ON_VAN] }))).toEqual({ outcome: 'applied', status: 'in_transit' })

        expect(shipment()).toMatchObject({ status: 'in_transit', status_detail: 'Arrived at hub' })
        expect(storedEvents()).toHaveLength(3)
    })

    it('does not put a voided label back in use', () => {
        Object.assign(shipment(), { status: 'voided', status_detail: 'Voided with the carrier (marked by Ada)' })

        expect(trackShipment(update({ status: 'exception', description: 'Label cancelled' }))).toEqual({ outcome: 'applied', status: 'voided' })

        expect(shipment()).toMatchObject({ status: 'voided', status_detail: 'Voided with the carrier (marked by Ada)' })
    })
})

describe('a delivery', () => {
    it("is saved with the carrier's delivery time and noted on the Shipment's Order", () => {
        expect(trackShipment(DELIVERED)).toEqual({ outcome: 'applied', status: 'delivered' })

        expect(shipment()).toMatchObject({ status: 'delivered', status_detail: 'Delivered', delivered_at: '2026-11-11 10:15:00' })
        expect(order().work_notes).toBe('Delivered to Acme HQ (ups 1Z999).')
        expect(storedEvents()).toHaveLength(4)
    })

    it('is noted once, however often the update is sent', () => {
        trackShipment(DELIVERED)
        // A journal field reads blank once its entry is saved.
        order().work_notes = ''

        expect(trackShipment(DELIVERED)).toEqual({ outcome: 'applied', status: 'delivered' })

        expect(order().work_notes).toBe('')
        expect(shipment().delivered_at).toBe('2026-11-11 10:15:00')
        expect(storedEvents()).toHaveLength(4)
    })

    it('takes the time now when the carrier gives no delivery time', () => {
        trackShipment(update({ status: 'delivered', description: 'Delivered', deliveredAt: undefined, events: [] }))

        expect(shipment().delivered_at).toBe('2026-11-10 09:00:00')
    })

    it('stays delivered when an older update arrives after it', () => {
        trackShipment(DELIVERED)

        expect(trackShipment(update())).toEqual({ outcome: 'applied', status: 'delivered' })

        expect(shipment()).toMatchObject({ status: 'delivered', status_detail: 'Delivered' })
    })

    it('is taken after a newer event is stored: a delivery is never older news', () => {
        const later: TrackingEvent = { occurredAt: '2026-11-12T08:00:00Z', status: 'unknown', description: 'Proof of delivery filed', location: '' }
        trackShipment(update({ status: 'unknown', description: '', events: [later] }))

        expect(trackShipment(DELIVERED)).toEqual({ outcome: 'applied', status: 'delivered' })

        expect(shipment().status).toBe('delivered')
    })

    it('becomes returned when the carrier sends it back', () => {
        trackShipment(DELIVERED)
        const sentBack: TrackingEvent = { occurredAt: '2026-11-13T08:00:00Z', status: 'returned', description: 'Returned to sender', location: '' }

        expect(trackShipment(update({ status: 'returned', description: 'Returned to sender', events: [sentBack] }))).toEqual({ outcome: 'applied', status: 'returned' })

        expect(shipment()).toMatchObject({ status: 'returned', status_detail: 'Returned to sender' })
    })

    it('stays on the Shipment, with a warning, when the platform refuses the note on the Order', () => {
        platform.refuses = (table) => (table === ORDERS ? 'order is read only' : '')

        expect(trackShipment(DELIVERED)).toEqual({ outcome: 'applied', status: 'delivered' })

        expect(shipment().status).toBe('delivered')
        expect(order().work_notes ?? '').toBe('')
        expect(platform.warnings).toEqual([expect.stringContaining('ORD0001 not noted as delivered (ups 1Z999): order is read only')])
    })

    it('of a return label notes no Order', () => {
        platform.tables[SHIPMENTS] = [{ sys_id: 'shp1', direction: 'return', return_order: 'ret1', carrier: 'ups', tracking_number: '1Z999', status: 'in_transit' }]

        expect(trackShipment(DELIVERED)).toEqual({ outcome: 'applied', status: 'delivered' })

        expect(order().work_notes ?? '').toBe('')
    })
})

describe('a tracking update the platform refuses', () => {
    it('is reported, with a warning and no event stored, when the Shipment is not saved', () => {
        platform.refuses = (table) => (table === SHIPMENTS ? 'shipment is read only' : '')

        expect(trackShipment(update())).toEqual({ outcome: 'shipment_refused' })

        expect(shipment().status).toBe('label_created')
        expect(storedEvents()).toEqual([])
        expect(platform.warnings).toEqual([expect.stringContaining('Tracking update of 1Z999 not saved: shipment is read only')])
        expect(rows(LOCKS)).toEqual([])
    })

    it('counts the events not stored, the status saved, and stores them when the update is sent again', () => {
        platform.refuses = (table, row) => (table === SHIPMENT_EVENTS && row.description === 'Arrived at hub' ? 'no room' : '')

        expect(trackShipment(update())).toEqual({ outcome: 'events_refused', count: 1 })

        expect(shipment().status).toBe('in_transit')
        expect(storedEvents().map(([, , , description]) => description)).toEqual(['Picked up'])
        expect(platform.warnings).toEqual([expect.stringContaining('Tracking event of 1Z999 at 2026-11-10T14:00:00Z not recorded: no room')])

        platform.refuses = () => ''
        expect(trackShipment(update())).toEqual({ outcome: 'applied', status: 'in_transit' })

        expect(storedEvents().map(([, , , description]) => description)).toEqual(['Picked up', 'Arrived at hub'])
    })
})

describe("a tracking update held off by the Shipment's tracking lock", () => {
    const queued = () => platform.events.filter((event) => event.name === EVENT.trackShipment)

    it('is queued to be applied in the background, and changes nothing yet', () => {
        held(LOCK.trackShipment('shp1'))

        expect(trackShipment(update())).toEqual({ outcome: 'queued' })

        expect(shipment().status).toBe('label_created')
        expect(storedEvents()).toEqual([])
        expect(queued()).toEqual([expect.objectContaining({ record: 'shp1', parm2: '0', delayed: false })])
        expect(platform.logs).toEqual([expect.stringMatching(/^info .*Tracking update of Shipment NSHP0001 \(1Z999\) queued in 1 event\(s\): another update held its lock/)])
    })

    it('is applied by its queued retry once the lock is free', () => {
        held(LOCK.trackShipment('shp1'))
        trackShipment(update())
        platform.tables[LOCKS] = []
        const [event] = queued()

        retryTracking(record(SHIPMENTS, 'shp1'), event?.parm1 ?? '', 0)

        expect(shipment()).toMatchObject({ status: 'in_transit', status_detail: 'Arrived at hub', estimated_delivery: '2026-11-12' })
        expect(storedEvents()).toHaveLength(2)
        expect(platform.events).toHaveLength(1)
    })

    it('is busy, with a warning, when an event is too long to queue', () => {
        held(LOCK.trackShipment('shp1'))
        const endless: TrackingEvent = { ...PICKED_UP, occurredAt: 'x'.repeat(4001) }

        expect(trackShipment(update({ events: [endless] }))).toEqual({ outcome: 'busy' })

        expect(platform.events).toEqual([])
        expect(platform.warnings).toEqual([expect.stringContaining('Tracking update of Shipment NSHP0001 (1Z999) not queued: an event is too long to queue')])
    })
})

describe('a queued tracking retry', () => {
    const PARAM = JSON.stringify({ trackingNumber: '1Z999', status: 'in_transit', description: 'Arrived at hub', newestAt: AT_HUB.occurredAt, events: [PICKED_UP, AT_HUB] })
    const retry = (param: string, tries: number) => retryTracking(record(SHIPMENTS, 'shp1'), param, tries)

    it('still held off is queued again a minute later, counted', () => {
        held(LOCK.trackShipment('shp1'))

        retry(PARAM, 3)

        expect(platform.events).toEqual([{ name: EVENT.trackShipment, record: 'shp1', parm1: PARAM, parm2: '4', delayed: true }])
        expect(platform.logs).toEqual([expect.stringMatching(/^info .*tried again in 60 s: another update held its lock/)])
        expect(shipment().status).toBe('label_created')
    })

    it('is dropped with a warning once it was queued again 15 times', () => {
        held(LOCK.trackShipment('shp1'))

        retry(PARAM, 15)

        expect(platform.events).toEqual([])
        expect(platform.warnings).toEqual([
            expect.stringContaining('Tracking update of Shipment NSHP0001 (1Z999) dropped after 15 tries (another update held its lock): check the Shipment with the carrier'),
        ])
    })

    it('is queued again when the platform refuses the Shipment', () => {
        platform.refuses = (table) => (table === SHIPMENTS ? 'shipment is read only' : '')

        retry(PARAM, 0)

        expect(platform.events).toEqual([expect.objectContaining({ parm1: PARAM, parm2: '1', delayed: true })])
        expect(platform.logs).toContainEqual(expect.stringMatching(/^info .*tried again in 60 s: the platform refused the Shipment/))
    })

    it('whose status is older than an event stored since adds its events only', () => {
        trackShipment(update({ status: 'out_for_delivery', description: 'Out for delivery', estimatedDelivery: '2026-11-11', events: [ON_VAN] }))

        retry(PARAM, 0)

        expect(shipment()).toMatchObject({ status: 'out_for_delivery', status_detail: 'Out for delivery' })
        expect(storedEvents()).toHaveLength(3)
        expect(platform.events).toEqual([])
    })

    it('that is not an update is dropped with a warning', () => {
        retry('not json', 0)

        expect(platform.events).toEqual([])
        expect(platform.warnings).toEqual([expect.stringContaining('Tracking retry of Shipment NSHP0001 (1Z999) dropped: parm1 is not an update')])
    })
})

describe('marking an outbound label voided', () => {
    const NOTE =
        'Shipping label ups 1Z999 was voided with the carrier, so its tracking number and carrier were cleared from this Order; its units stay shipped. ' +
        'Buy the replacement label with the carrier, then type its carrier and tracking number on the Order.'

    it("voids the Shipment and clears the Order's tracking number and carrier, with a work note", () => {
        expect(voidLabel('shp1', '1Z999')).toEqual({
            voided: true,
            message: 'Label 1Z999 marked voided and cleared from ORD0001: buy the replacement with the carrier and type its tracking number on the Order',
            leftUndone: false,
        })

        expect(shipment()).toMatchObject({ status: 'voided', status_detail: 'Voided with the carrier (marked by Ada)' })
        expect(order()).toMatchObject({ tracking_number: '', carrier: '', work_notes: NOTE })
        expect(rows(LOCKS)).toEqual([])
        expect(platform.logs).toEqual([])
    })

    it('voids a label stuck in an exception too', () => {
        shipment().status = 'exception'

        expect(voidLabel('shp1', '1Z999')).toMatchObject({ voided: true, leftUndone: false })

        expect(shipment().status).toBe('voided')
    })

    it('leaves an Order that tracks another label as it is', () => {
        Object.assign(order(), { tracking_number: '1Z777' })

        expect(voidLabel('shp1', '1Z999')).toEqual({ voided: true, message: 'Label 1Z999 marked voided', leftUndone: false })

        expect(shipment().status).toBe('voided')
        expect(order()).toMatchObject({ tracking_number: '1Z777', carrier: 'ups' })
        expect(order().work_notes ?? '').toBe('')
    })

    it("changes nothing while a Ship of its Order holds the Order's Ship lock", () => {
        held(LOCK.shipOrder('o1'))

        expect(voidLabel('shp1', '1Z999')).toEqual({
            voided: false,
            why: 'Label 1Z999 not marked voided: a Ship of its Order, or a void of one of its labels, is running. Try again once it has finished',
        })

        expect(shipment().status).toBe('label_created')
        expect(order()).toMatchObject({ tracking_number: '1Z999', carrier: 'ups' })
    })

    it('changes nothing while a tracking update holds its tracking lock through every try', () => {
        held(LOCK.trackShipment('shp1'))

        expect(voidLabel('shp1', '1Z999')).toEqual({ voided: false, why: 'Label 1Z999 not marked voided: a tracking update of it is being saved. Try again' })

        expect(shipment().status).toBe('label_created')
        expect(order().tracking_number).toBe('1Z999')
        expect(rows(LOCKS).map((lock) => lock.name)).toEqual([LOCK.trackShipment('shp1')])
    })

    it.each(['in_transit', 'out_for_delivery', 'delivered', 'returned', 'unknown', 'voided'])('refuses a label that is %s', (status) => {
        shipment().status = status

        expect(voidLabel('shp1', '1Z999')).toEqual({ voided: false, why: expect.stringMatching(/^Label 1Z999 is .*, so it cannot be marked voided$/) })

        expect(shipment().status).toBe(status)
        expect(order().tracking_number).toBe('1Z999')
    })

    it('says so when the Shipment is gone', () => {
        expect(voidLabel('no-such-shipment', '1Z999')).toEqual({ voided: false, why: 'Label 1Z999 no longer exists' })
    })

    it("leaves the label open, and the Order as it is, when the platform refuses the Shipment's save", () => {
        platform.refuses = (table) => (table === SHIPMENTS ? 'shipment is read only' : '')

        expect(voidLabel('shp1', '1Z999')).toEqual({ voided: false, why: 'Label 1Z999 not marked voided: shipment is read only' })

        expect(shipment().status).toBe('label_created')
        expect(order().tracking_number).toBe('1Z999')
    })

    it('says what to clear by hand when the platform refuses to save the Order', () => {
        platform.refuses = (table) => (table === ORDERS ? 'order is read only' : '')

        expect(voidLabel('shp1', '1Z999')).toEqual({
            voided: true,
            message: 'Label 1Z999 marked voided, but ORD0001 still names it (order is read only): clear its tracking number and carrier by hand',
            leftUndone: true,
        })

        expect(shipment().status).toBe('voided')
        expect(order()).toMatchObject({ tracking_number: '1Z999', carrier: 'ups' })
    })
})

describe('a Return order and its prepaid label', () => {
    const LABEL = JSON.stringify({
        label_id: 'se-123',
        tracking_number: '1ZRET01',
        carrier_code: 'ups',
        label_download: { pdf: 'https://labels.example/se-123.pdf' },
        shipment_cost: { amount: 12.5, currency: 'nok' },
    })
    const returnLabel = (fields: Row = {}): Row => ({ sys_id: 'shp2', direction: 'return', return_order: 'ret1', carrier: 'ups', tracking_number: '1ZOLD', status: 'label_created', ...fields })
    const requestLabel = () => labelReturn(record(RETURNS, 'ret1'))

    beforeEach(() => {
        aggregator.answer = { status: 200, body: LABEL }
        platform.properties = { [PROPERTY.shippingCarrierId.name]: 'se-carrier', [PROPERTY.stagingStockroom.name]: 'depot', [PROPERTY.shippingSenderPhone.name]: '+47 22 00 00 00' }
        platform.tables[RETURNS] = [{ sys_id: 'ret1', number: 'RET0001', customer: 'acme', site: 'site1' }]
        platform.tables[RETURN_LINES] = [
            { sys_id: 'line1', return_order: 'ret1', asset: 'a1', status: 'awaiting' },
            { sys_id: 'line2', return_order: 'ret1', asset: 'a2', status: 'awaiting' },
            { sys_id: 'line3', return_order: 'ret1', asset: 'a3', status: 'received' },
        ]
    })

    it('gets one label from the Site to the depot, a box per unit still awaited, recorded as a Shipment and noted on it', () => {
        expect(requestLabel()).toEqual({ bought: true, trackingNumber: '1ZRET01' })

        expect(aggregator.sent).toHaveLength(1)
        expect(aggregator.sent[0]).toMatchObject({ message: SHIPPING_MESSAGE.name, fn: SHIPPING_MESSAGE.fn.createLabel })
        const sent = JSON.parse(aggregator.sent[0]?.body ?? '{}') as { shipment: { carrier_id: string; ship_from: Row; ship_to: Row; packages: unknown[] } }
        expect(sent.shipment.carrier_id).toBe('se-carrier')
        expect(sent.shipment.ship_from).toMatchObject({ name: 'Acme HQ', company_name: 'Acme', city_locality: 'Bergen', country_code: 'NO' })
        expect(sent.shipment.ship_to).toMatchObject({ name: 'Central depot', city_locality: 'Oslo', country_code: 'NO' })
        expect(sent.shipment.packages).toHaveLength(2)
        expect(rows(SHIPMENTS).find((row) => row.return_order === 'ret1')).toMatchObject({
            direction: 'return',
            customer: 'acme',
            site: 'site1',
            stockroom: 'depot',
            carrier: 'ups',
            service_code: 'ups_standard',
            packages: '2',
            tracking_number: '1ZRET01',
            label_id: 'se-123',
            label_url: 'https://labels.example/se-123.pdf',
            cost: '12.5',
            currency: 'NOK',
            status: 'label_created',
        })
        expect(returnOrder().work_notes).toBe('Return label 1ZRET01 (ups): https://labels.example/se-123.pdf')
        expect(rows(LOCKS)).toEqual([])
        expect(platform.logs).toEqual([])
    })

    it('gets none when nothing on it is still awaited', () => {
        platform.tables[RETURN_LINES] = [{ sys_id: 'line3', return_order: 'ret1', asset: 'a3', status: 'received' }]

        expect(requestLabel()).toEqual({ bought: false, why: 'Nothing on this return is still awaited' })

        expect(aggregator.sent).toEqual([])
    })

    it.each([
        ['label_created', 'Return label 1ZOLD is still open; void it with the carrier, then use Mark label voided on its Shipment, before buying another'],
        ['exception', 'Return label 1ZOLD is still open; void it with the carrier, then use Mark label voided on its Shipment, before buying another'],
        ['in_transit', 'Return label 1ZOLD is already under way with the carrier; no other label is needed'],
        ['out_for_delivery', 'Return label 1ZOLD is already under way with the carrier; no other label is needed'],
        ['unknown', 'Return label 1ZOLD is still open and its status is unknown; check it with the carrier before buying another'],
    ])('gets no second label while one is open (%s), and nothing is bought', (status, why) => {
        rows(SHIPMENTS).push(returnLabel({ status }))

        expect(requestLabel()).toEqual({ bought: false, why })

        expect(aggregator.sent).toEqual([])
        expect(rows(SHIPMENTS)).toHaveLength(2)
    })

    it.each(['voided', 'delivered', 'returned'])('gets a new label once its last one is %s', (status) => {
        rows(SHIPMENTS).push(returnLabel({ status }))

        expect(requestLabel()).toEqual({ bought: true, trackingNumber: '1ZRET01' })

        expect(aggregator.sent).toHaveLength(1)
    })

    it('gets none while another request holds its label lock, and nothing is bought', () => {
        held(LOCK.returnLabel('ret1'))

        expect(requestLabel()).toEqual({ bought: false, why: 'A return label is already being bought for this return: reload it to see it' })

        expect(aggregator.sent).toEqual([])
        expect(rows(SHIPMENTS)).toHaveLength(1)
    })

    it('gets none, and nothing is sent, while no carrier account is set', () => {
        delete platform.properties[PROPERTY.shippingCarrierId.name]

        expect(requestLabel()).toEqual({ bought: false, why: 'No label: set x_daas_ham.shipping.carrier_id to the ShipEngine carrier account (se-...) billed for labels' })

        expect(aggregator.sent).toEqual([])
    })

    it('gets none, and nothing is sent, while the Site has no address a carrier takes', () => {
        Object.assign(rows('cmn_location')[0] ?? {}, { street: '', zip: '' })

        expect(requestLabel()).toEqual({ bought: false, why: 'No label: from address missing line1, postalCode' })

        expect(aggregator.sent).toEqual([])
    })

    it('says why when the aggregator refuses, and records no Shipment', () => {
        aggregator.answer = { status: 400, body: JSON.stringify({ errors: [{ message: 'carrier account suspended' }] }) }

        expect(requestLabel()).toEqual({ bought: false, why: 'No label: HTTP 400: carrier account suspended' })

        expect(rows(SHIPMENTS)).toHaveLength(1)
        expect(returnOrder().work_notes ?? '').toBe('')
    })

    it('names the label bought, to be voided, when the platform refuses its Shipment', () => {
        platform.refuses = (table) => (table === SHIPMENTS ? 'shipment table is locked' : '')

        expect(requestLabel()).toEqual({
            bought: false,
            why: 'No label: the label bought (ups 1ZRET01, label se-123) was not recorded: shipment table is locked. Void it with the carrier',
        })

        expect(rows(SHIPMENTS)).toHaveLength(1)
        expect(platform.warnings).toEqual([
            expect.stringContaining('Label bought for RET0001 but no Shipment saved (ups 1ZRET01, label se-123): shipment table is locked'),
        ])
    })

    it('warns that a second label may have been bought when its lock was lost during the purchase', () => {
        // Another request takes the lock over as abandoned while the aggregator is called.
        aggregator.whileCalled = () => void (platform.tables[LOCKS] = [])

        expect(requestLabel()).toEqual({ bought: true, trackingNumber: '1ZRET01' })

        expect(rows(SHIPMENTS)).toHaveLength(2)
        expect(platform.warnings).toEqual([
            expect.stringContaining('Label ups 1ZRET01, label se-123 bought for RET0001 after its lock return_label_ret1 was lost: void any second label bought for it meanwhile'),
        ])
    })

    it('says where the label link is when the platform refuses the note on it', () => {
        platform.refuses = (table) => (table === RETURNS ? 'return is read only' : '')

        expect(requestLabel()).toEqual({
            bought: true,
            trackingNumber: '1ZRET01',
            unnoted: 'Return label 1ZRET01 created, but its work note was not saved (return is read only): its link is on the Shipment (https://labels.example/se-123.pdf)',
        })

        expect(rows(SHIPMENTS)).toHaveLength(2)
    })

    describe('whose label is marked voided', () => {
        beforeEach(() => {
            rows(SHIPMENTS).push(returnLabel())
        })

        it('is told not to ship on it, and can get a new label', () => {
            expect(voidLabel('shp2', '1ZOLD')).toEqual({ voided: true, message: 'Label 1ZOLD marked voided', leftUndone: false })

            expect(shipment('shp2')).toMatchObject({ status: 'voided', status_detail: 'Voided with the carrier (marked by Ada)' })
            expect(returnOrder().work_notes).toBe('Return label 1ZOLD voided with the carrier: do not ship on it.')
            expect(order()).toMatchObject({ tracking_number: '1Z999', carrier: 'ups' })
            expect(requestLabel()).toEqual({ bought: true, trackingNumber: '1ZRET01' })
        })

        it('is voided all the same when the platform refuses the note on it', () => {
            platform.refuses = (table) => (table === RETURNS ? 'return is read only' : '')

            expect(voidLabel('shp2', '1ZOLD')).toEqual({
                voided: true,
                message: 'Label 1ZOLD marked voided, but RET0001 was not noted (return is read only): tell the Site not to ship on it',
                leftUndone: true,
            })

            expect(shipment('shp2').status).toBe('voided')
        })
    })
})

describe("an Order's outbound label", () => {
    const LABEL = JSON.stringify({ label_id: 'se-456', tracking_number: '1ZNEW02', carrier_code: 'ups', label_download: { href: 'https://labels.example/se-456' }, shipment_cost: { amount: 30 } })

    /** The label bought as a Ship buys it: holding the Order's Ship lock. */
    function buy(packages: number) {
        const bought = withLock(LOCK.shipOrder('o1'), (lock) => labelOrder(record(ORDERS, 'o1'), packages, lock))
        return bought.ran ? bought.value : null
    }

    beforeEach(() => {
        aggregator.answer = { status: 200, body: LABEL }
        platform.properties = { [PROPERTY.shippingCarrierId.name]: 'se-carrier', [PROPERTY.stagingStockroom.name]: 'depot', [PROPERTY.shippingSenderPhone.name]: '+47 22 00 00 00' }
        platform.tables[SHIPMENTS] = []
        Object.assign(order(), { carrier: '', tracking_number: '' })
    })

    it('is bought from the depot to the Site, recorded as a Shipment, and its carrier and tracking number saved on the Order', () => {
        expect(buy(3)).toEqual({ ok: true, trackingNumber: '1ZNEW02', orderRefusal: '' })

        const sent = JSON.parse(aggregator.sent[0]?.body ?? '{}') as { shipment: { ship_from: Row; ship_to: Row; packages: Array<{ label_messages: Row }> } }
        expect(sent.shipment.ship_from).toMatchObject({ name: 'Central depot', phone: '+47 22 00 00 00', city_locality: 'Oslo' })
        expect(sent.shipment.ship_to).toMatchObject({ name: 'Acme HQ', company_name: 'Acme', city_locality: 'Bergen' })
        expect(sent.shipment.packages.map((box) => box.label_messages.reference1)).toEqual(['ORD0001', 'ORD0001', 'ORD0001'])
        expect(rows(SHIPMENTS)).toEqual([
            expect.objectContaining({ direction: 'to_site', order: 'o1', customer: 'acme', site: 'site1', packages: '3', tracking_number: '1ZNEW02', label_url: 'https://labels.example/se-456', cost: '30', currency: '', status: 'label_created' }),
        ])
        expect(order()).toMatchObject({ carrier: 'ups', tracking_number: '1ZNEW02' })
    })

    it('stands, and is reported, when the platform refuses to save it on the Order', () => {
        platform.refuses = (table) => (table === ORDERS ? 'order is read only' : '')

        expect(buy(1)).toEqual({ ok: true, trackingNumber: '1ZNEW02', orderRefusal: 'order is read only' })

        expect(rows(SHIPMENTS)).toHaveLength(1)
        expect(order().tracking_number).toBe('')
    })

    it('is not bought for more boxes than one label covers', () => {
        expect(buy(21)).toEqual({ ok: false, error: '21 packages is more than one label covers (20); enter the carrier and tracking number by hand' })

        expect(aggregator.sent).toEqual([])
        expect(rows(SHIPMENTS)).toEqual([])
    })

    it('is not bought while no depot is set', () => {
        delete platform.properties[PROPERTY.stagingStockroom.name]

        expect(buy(1)).toEqual({ ok: false, error: 'set x_daas_ham.staging.default_stockroom to the depot that ships' })

        expect(aggregator.sent).toEqual([])
    })

    it('is known as bought by its tracking number, unlike a number typed by hand', () => {
        buy(1)

        expect(orderLabelBought('o1', '1ZNEW02')).toBe(true)
        expect(orderLabelBought('o1', 'TYPED-BY-HAND')).toBe(false)
        expect(orderLabelBought('o2', '1ZNEW02')).toBe(false)
    })
})
