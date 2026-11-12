import { beforeEach, describe, expect, it, vi } from 'vitest'
import { JOB } from '../domain/chunked-job.ts'
import type { DeviceEvent } from '../domain/device-events.ts'
import { fieldsOf, type Stage } from '../domain/lifecycle.ts'
import { LOCK } from '../domain/lock-names.ts'
import { applyDeviceEvents, detectPendingInService } from './in-service.ts'
import { platform, type Row } from '../test-support/fake-glide.ts'

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)


const ASSETS = 'alm_hardware'
const LINES = 'x_daas_ham_subscription_line'
const EVENTS = 'x_daas_ham_device_event'
const LOCKS = 'x_daas_ham_job_lock'
const CURSORS = 'x_daas_ham_job_cursor'

const INSTALLED = '2025-11-08 10:00:00'
const SEEN = '2025-11-09 09:00:00'
const SEEN_MS = Date.parse('2025-11-09T09:00:00Z')

const rows = (table: string): Row[] => platform.tables[table] ?? []
const asset = (id = 'a1'): Row => rows(ASSETS).find((row) => row.sys_id === id) ?? {}
const line = (): Row => rows(LINES)[0] ?? {}

function stage(of: Stage): Row {
    const { installStatus, substatus } = fieldsOf(of)
    return { install_status: installStatus, substatus: substatus ?? '' }
}

function unit(of: Stage, fields: Row = {}): Row {
    return {
        sys_id: 'a1',
        serial_number: 'FOC111',
        x_daas_ham_fleet: 'true',
        x_daas_ham_site: 'site1',
        x_daas_ham_agreement: 'ag1',
        x_daas_ham_order_line: 'ol1',
        x_daas_ham_install_completed: INSTALLED,
        model: 'm1',
        ...stage(of),
        ...fields,
    }
}

function event(fields: Partial<DeviceEvent> = {}): DeviceEvent {
    return { identifier: 'FOC111', event: 'seen', observedAt: SEEN_MS, source: 'nms', ...fields }
}

beforeEach(() => {
    platform.reset()
    platform.uniqueKeys = { [LOCKS]: 'name', [CURSORS]: 'job' }
    platform.references = {
        [`${ASSETS}.x_daas_ham_order_line`]: 'x_daas_ham_order_line',
        'x_daas_ham_order_line.order': 'x_daas_ham_order',
        [`${ASSETS}.model`]: 'cmdb_model',
        [`${ASSETS}.ci`]: 'cmdb_ci',
    }
    platform.tables.cmdb_model = [{ sys_id: 'm1', x_daas_ham_device_class: 'switch' }]
    platform.tables.x_daas_ham_order = [{ sys_id: 'o1', order_type: 'site_rollout' }]
    platform.tables.x_daas_ham_order_line = [{ sys_id: 'ol1', order: 'o1' }]
    platform.tables.x_daas_ham_agreement = [{ sys_id: 'ag1', refresh_basis: 'cycle', refresh_cycle_months: '36' }]
    platform.tables[LINES] = [{ sys_id: 'sub1', agreement: 'ag1', line_type: 'device_class', device_class: 'switch', site: '', status: 'pending', start_date: '', description: 'Switches' }]
    platform.tables[ASSETS] = [unit('pending_in_service')]
})

describe('a seen event for a pending Asset', () => {
    it('puts it in service from the sighting and starts its pending line', () => {
        expect(applyDeviceEvents([event()])).toEqual({ unknown: [], busy: [] })

        expect(asset()).toMatchObject({
            ...stage('in_service'),
            x_daas_ham_last_seen: SEEN,
            x_daas_ham_seen_source: 'nms',
            x_daas_ham_in_service_date: SEEN,
            x_daas_ham_subscription_line: 'sub1',
            x_daas_ham_lifecycle_phase: 'available',
            x_daas_ham_refresh_due: '2028-11-09',
        })
        expect(line()).toMatchObject({ status: 'active', start_date: '2025-11-09' })
        expect(rows(EVENTS)).toEqual([expect.objectContaining({ asset: 'a1', identifier: 'FOC111', event: 'seen', source: 'nms', observed_at: SEEN })])
        expect(rows(LOCKS)).toEqual([])
        expect(platform.logs).toEqual([])
    })

    it('joins a line that is already active and keeps its start date', () => {
        Object.assign(line(), { status: 'active', start_date: '2025-10-01' })

        applyDeviceEvents([event()])

        expect(asset()).toMatchObject({ ...stage('in_service'), x_daas_ham_subscription_line: 'sub1' })
        expect(line()).toMatchObject({ status: 'active', start_date: '2025-10-01' })
    })

    it('goes into service on no line when none matches', () => {
        platform.tables[LINES] = []

        applyDeviceEvents([event()])

        expect(asset()).toMatchObject({ ...stage('in_service'), x_daas_ham_in_service_date: SEEN })
        expect(asset().x_daas_ham_subscription_line ?? '').toBe('')
    })

    it('becomes a temporary deployment on a temporary Order', () => {
        platform.tables.x_daas_ham_order = [{ sys_id: 'o1', order_type: 'temporary' }]

        applyDeviceEvents([event()])

        expect(asset()).toMatchObject(stage('temporary_deployment'))
    })

    it('stays pending when it was seen before its install was completed', () => {
        const early = Date.parse('2025-11-08T09:00:00Z')

        expect(applyDeviceEvents([event({ observedAt: early })])).toEqual({ unknown: [], busy: [] })

        expect(asset()).toMatchObject({ ...stage('pending_in_service'), x_daas_ham_last_seen: '2025-11-08 09:00:00' })
        expect(asset().x_daas_ham_in_service_date ?? '').toBe('')
        expect(line().status).toBe('pending')
        expect(rows(EVENTS)).toHaveLength(1)
    })

    it('stays pending, the sighting saved, when its line cannot be started, and goes live when the event is sent again', () => {
        platform.refuses = (table, _row, operation) => (table === LINES && operation === 'update' ? 'line locked by finance' : '')

        expect(applyDeviceEvents([event()])).toEqual({ unknown: [], busy: [] })

        expect(asset()).toMatchObject({ ...stage('pending_in_service'), x_daas_ham_last_seen: SEEN })
        expect(asset().x_daas_ham_subscription_line ?? '').toBe('')
        expect(line().status).toBe('pending')
        expect(platform.warnings).toEqual([expect.stringContaining('FOC111 stays pending in service, line not started: line locked by finance')])

        platform.refuses = () => ''
        applyDeviceEvents([event()])

        expect(asset()).toMatchObject({ ...stage('in_service'), x_daas_ham_in_service_date: SEEN, x_daas_ham_subscription_line: 'sub1' })
        expect(line()).toMatchObject({ status: 'active', start_date: '2025-11-09' })
    })

    it('is reported busy when its go-live save is refused, its line left active, and joins that line when sent again', () => {
        platform.refuses = (table, _row, operation) => (table === ASSETS && operation === 'update' ? 'stage rule said no' : '')

        expect(applyDeviceEvents([event()])).toEqual({ unknown: [], busy: ['FOC111'] })

        expect(asset()).toMatchObject(stage('pending_in_service'))
        expect(asset().x_daas_ham_last_seen ?? '').toBe('')
        expect(line()).toMatchObject({ status: 'active', start_date: '2025-11-09' })
        expect(platform.logs).toEqual([
            expect.stringMatching(/^warn .*in-service detection: FOC111 not moved to in_service: stage rule said no/),
            expect.stringMatching(/^error .*FOC111 stays pending in service, its Subscription line possibly active/),
        ])

        platform.refuses = () => ''
        const later = SEEN_MS + 86_400_000
        expect(applyDeviceEvents([event({ observedAt: later })])).toEqual({ unknown: [], busy: [] })

        expect(asset()).toMatchObject({ ...stage('in_service'), x_daas_ham_in_service_date: '2025-11-10 09:00:00', x_daas_ham_subscription_line: 'sub1' })
        expect(line()).toMatchObject({ status: 'active', start_date: '2025-11-09' })
    })
})

describe('a sighting of an Asset already in service', () => {
    beforeEach(() => {
        platform.tables[ASSETS] = [unit('in_service', { x_daas_ham_last_seen: SEEN, x_daas_ham_seen_source: 'discovery', x_daas_ham_in_service_date: SEEN, x_daas_ham_subscription_line: 'sub1' })]
        Object.assign(line(), { status: 'active', start_date: '2025-11-09' })
    })

    it('moves last seen forward and changes nothing else', () => {
        applyDeviceEvents([event({ observedAt: SEEN_MS + 3_600_000 })])

        expect(asset()).toMatchObject({ ...stage('in_service'), x_daas_ham_last_seen: '2025-11-09 10:00:00', x_daas_ham_seen_source: 'nms', x_daas_ham_in_service_date: SEEN })
        expect(line().start_date).toBe('2025-11-09')
    })

    it('does not move last seen back for an older sighting', () => {
        expect(applyDeviceEvents([event({ observedAt: SEEN_MS - 3_600_000 })])).toEqual({ unknown: [], busy: [] })

        expect(asset()).toMatchObject({ x_daas_ham_last_seen: SEEN, x_daas_ham_seen_source: 'discovery' })
    })
})

describe('the device events stored', () => {
    it('are the state changes only: a sighting after a stored sighting adds none', () => {
        const at = (hours: number) => SEEN_MS + hours * 3_600_000

        applyDeviceEvents([event(), event({ observedAt: at(1) }), event({ event: 'down', observedAt: at(2) }), event({ observedAt: at(3) })])

        expect(rows(EVENTS).map((row) => [row.event, row.observed_at])).toEqual([
            ['seen', '2025-11-09 09:00:00'],
            ['down', '2025-11-09 11:00:00'],
            ['seen', '2025-11-09 12:00:00'],
        ])
        expect(asset().x_daas_ham_last_seen).toBe('2025-11-09 12:00:00')
    })

    it('include a down event, which changes nothing on the Asset', () => {
        const before = { ...asset() }

        expect(applyDeviceEvents([event({ event: 'down' })])).toEqual({ unknown: [], busy: [] })

        expect(rows(EVENTS)).toEqual([expect.objectContaining({ asset: 'a1', event: 'down', observed_at: SEEN })])
        expect(asset()).toEqual(before)
        expect(line().status).toBe('pending')
    })

    it('report a down event the platform refuses to store as busy', () => {
        platform.refuses = (table) => (table === EVENTS ? 'no room' : '')

        expect(applyDeviceEvents([event({ event: 'down' })])).toEqual({ unknown: [], busy: ['FOC111'] })

        expect(rows(EVENTS)).toEqual([])
        expect(platform.logs).toEqual([expect.stringMatching(/^error .*down event of FOC111 not stored: no room/)])
    })

    it('report a sighting the platform refuses to store as busy, the Asset put in service all the same', () => {
        platform.refuses = (table) => (table === EVENTS ? 'no room' : '')

        expect(applyDeviceEvents([event()])).toEqual({ unknown: [], busy: ['FOC111'] })

        expect(asset()).toMatchObject(stage('in_service'))
    })
})

describe('the identifier of an event', () => {
    it('names a fleet asset by its Provider tag, however it is typed', () => {
        platform.tables[ASSETS] = [unit('pending_in_service', { asset_tag: 'NAAS0000001' })]

        expect(applyDeviceEvents([event({ identifier: ' naas0000001 ' })])).toEqual({ unknown: [], busy: [] })

        expect(asset()).toMatchObject(stage('in_service'))
        expect(rows(EVENTS)[0]?.identifier).toBe(' naas0000001 ')
    })

    it('is unknown when no fleet asset carries it, and stores no event', () => {
        expect(applyDeviceEvents([event({ identifier: 'NOPE' })])).toEqual({ unknown: ['NOPE'], busy: [] })

        expect(rows(EVENTS)).toEqual([])
        expect(asset()).toMatchObject(stage('pending_in_service'))
    })

    it("is unknown when only one of the Provider IT's assets carries it", () => {
        platform.tables[ASSETS] = [unit('pending_in_service', { x_daas_ham_fleet: '' })]

        expect(applyDeviceEvents([event()])).toEqual({ unknown: ['FOC111'], busy: [] })

        expect(asset()).toMatchObject(stage('pending_in_service'))
    })

    it('is unknown, with a warning, when two fleet assets carry it as their Customer tag', () => {
        platform.tables[ASSETS] = [
            unit('pending_in_service', { x_daas_ham_customer_tag: 'SW-01' }),
            unit('pending_in_service', { sys_id: 'a2', serial_number: 'FOC222', x_daas_ham_customer_tag: 'SW-01' }),
        ]

        expect(applyDeviceEvents([event({ identifier: 'SW-01' })])).toEqual({ unknown: ['SW-01'], busy: [] })

        expect(platform.warnings).toEqual([expect.stringContaining('Identifier SW-01 refused: More than one asset has Customer tag SW-01')])
        expect(asset('a1')).toMatchObject(stage('pending_in_service'))
        expect(asset('a2')).toMatchObject(stage('pending_in_service'))
        expect(rows(EVENTS)).toEqual([])
    })
})

describe("an Asset's sighting lock", () => {
    it('held by another sighting through every try leaves the event busy and unapplied', () => {
        platform.tables[LOCKS] = [{ sys_id: 'lock1', name: LOCK.seenAsset('a1'), sys_created_on: '2025-11-09 12:00:00' }]

        expect(applyDeviceEvents([event()])).toEqual({ unknown: [], busy: ['FOC111'] })

        expect(asset()).toMatchObject(stage('pending_in_service'))
        expect(asset().x_daas_ham_last_seen ?? '').toBe('')
        expect(rows(EVENTS)).toEqual([])
        expect(line().status).toBe('pending')
    })

    it('lost before the Asset is saved leaves the event busy, the Asset and its line untouched', () => {
        // Another sighting takes the lock over as abandoned while this one stores its event.
        platform.onSave = (table) => {
            if (table === EVENTS) platform.tables[LOCKS] = []
        }

        expect(applyDeviceEvents([event()])).toEqual({ unknown: [], busy: ['FOC111'] })

        expect(asset()).toMatchObject(stage('pending_in_service'))
        expect(asset().x_daas_ham_last_seen ?? '').toBe('')
        expect(line().status).toBe('pending')
        expect(rows(EVENTS)).toHaveLength(1)
    })
})

describe('a sighting that does not put the Asset in service', () => {
    it('is reported busy, and logged, when the platform refuses to save it', () => {
        platform.tables[ASSETS] = [unit('in_service', { x_daas_ham_last_seen: SEEN })]
        platform.refuses = (table, _row, operation) => (table === ASSETS && operation === 'update' ? 'read only' : '')

        expect(applyDeviceEvents([event({ observedAt: SEEN_MS + 3_600_000 })])).toEqual({ unknown: [], busy: ['FOC111'] })

        expect(asset().x_daas_ham_last_seen).toBe(SEEN)
        expect(platform.logs).toEqual([expect.stringMatching(/^error .*in-service detection: sighting of FOC111 not saved: read only/)])
    })
})

describe('the in-service detection job', () => {
    const discovered = (fields: Row = {}): Row => ({ sys_id: 'ci1', last_discovered: SEEN, discovery_source: 'ServiceNow', ...fields })

    beforeEach(() => {
        platform.tables[ASSETS] = [unit('pending_in_service', { ci: 'ci1' })]
        platform.tables.cmdb_ci = [discovered()]
    })

    it('puts a pending Asset in service from what Discovery last saw of its CI', () => {
        detectPendingInService()

        expect(asset()).toMatchObject({
            ...stage('in_service'),
            x_daas_ham_last_seen: SEEN,
            x_daas_ham_seen_source: 'discovery',
            x_daas_ham_in_service_date: SEEN,
            x_daas_ham_subscription_line: 'sub1',
        })
        expect(line()).toMatchObject({ status: 'active', start_date: '2025-11-09' })
        expect(rows(EVENTS)).toEqual([])
        expect(rows(LOCKS)).toEqual([])
        expect(rows(CURSORS)).toEqual([expect.objectContaining({ job: JOB.inServiceDetection, last_status: 'complete', processed_total: '1', failed_total: '0' })])
    })

    it('reads any other discovery source as a connector', () => {
        platform.tables.cmdb_ci = [discovered({ discovery_source: 'SG-Meraki' })]

        detectPendingInService()

        expect(asset()).toMatchObject({ ...stage('in_service'), x_daas_ham_seen_source: 'connector' })
    })

    it('leaves an Asset pending whose CI was last discovered before its install was completed', () => {
        platform.tables.cmdb_ci = [discovered({ last_discovered: '2025-11-08 09:00:00' })]

        detectPendingInService()

        expect(asset()).toMatchObject({ ...stage('pending_in_service'), x_daas_ham_last_seen: '2025-11-08 09:00:00', x_daas_ham_seen_source: 'discovery' })
        expect(line().status).toBe('pending')
    })

    it('leaves an Asset pending whose CI was never discovered, or that has no CI', () => {
        platform.tables.cmdb_ci = [discovered({ last_discovered: '' })]
        platform.tables[ASSETS].push(unit('pending_in_service', { sys_id: 'a2', serial_number: 'FOC222', ci: '' }))
        const before = [{ ...asset('a1') }, { ...asset('a2') }]

        detectPendingInService()

        expect([asset('a1'), asset('a2')]).toEqual(before)
    })

    it("visits pending fleet assets only: not one in another stage, nor the Provider IT's", () => {
        platform.tables[ASSETS] = [
            unit('shipped', { ci: 'ci1' }),
            unit('pending_in_service', { sys_id: 'a2', serial_number: 'FOC222', ci: 'ci1', x_daas_ham_fleet: '' }),
        ]
        const before = [{ ...asset('a1') }, { ...asset('a2') }]

        detectPendingInService()

        expect([asset('a1'), asset('a2')]).toEqual(before)
        expect(rows(CURSORS)[0]).toMatchObject({ processed_total: '0', last_status: 'complete' })
    })

    it('leaves an Asset whose sighting lock an NMS event holds to the next run, without failing', () => {
        platform.tables[LOCKS] = [{ sys_id: 'lock1', name: LOCK.seenAsset('a1'), sys_created_on: '2025-11-09 12:00:00' }]

        detectPendingInService()

        expect(asset()).toMatchObject(stage('pending_in_service'))
        expect(rows(CURSORS)[0]).toMatchObject({ failed_total: '0', last_status: 'complete' })
    })
})
