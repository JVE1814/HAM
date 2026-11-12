import type { GlideRecord } from '@servicenow/glide'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCK } from '../domain/lock-names.ts'
import { attachToSubscription } from './subscriptions.ts'
import { platform, recordOf, type Row } from '../test-support/fake-glide.ts'

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

const ASSETS = 'alm_hardware'
const LINES = 'x_daas_ham_subscription_line'
const LOCKS = 'x_daas_ham_job_lock'

const LIVE_AT = Date.parse('2025-11-09T09:00:00Z')

const lineRow = (id = 'sub1'): Row => (platform.tables[LINES] ?? []).find((row) => row.sys_id === id) ?? {}

function subscriptionLine(fields: Row = {}): Row {
    return { sys_id: 'sub1', agreement: 'ag1', line_type: 'device_class', device_class: 'switch', site: '', status: 'pending', start_date: '', end_date: '', description: 'Switches', ...fields }
}

function goingLive(): GlideRecord {
    return recordOf<GlideRecord>(ASSETS, { sys_id: 'a1', serial_number: 'FOC111', x_daas_ham_agreement: 'ag1', x_daas_ham_site: 'site1', model: 'm1' })
}

beforeEach(() => {
    platform.reset()
    platform.uniqueKeys = { [LOCKS]: 'name' }
    platform.references = { [`${ASSETS}.model`]: 'cmdb_model' }
    platform.tables.cmdb_model = [{ sys_id: 'm1', x_daas_ham_device_class: 'switch' }]
    platform.tables[LINES] = [subscriptionLine()]
})

describe('attaching an Asset going into service to its Subscription line', () => {
    it('starts a pending line from the day it went into service and links the Asset to it', () => {
        const asset = goingLive()

        expect(attachToSubscription(asset, LIVE_AT)).toBe(true)

        expect(asset.getValue('x_daas_ham_subscription_line')).toBe('sub1')
        expect(lineRow()).toMatchObject({ status: 'active', start_date: '2025-11-09' })
        expect(platform.tables[LOCKS]).toEqual([])
        expect(platform.logs).toEqual([])
    })

    it('joins an active line and keeps its start date', () => {
        platform.tables[LINES] = [subscriptionLine({ status: 'active', start_date: '2025-10-01' })]
        const asset = goingLive()

        expect(attachToSubscription(asset, LIVE_AT)).toBe(true)

        expect(asset.getValue('x_daas_ham_subscription_line')).toBe('sub1')
        expect(lineRow()).toMatchObject({ status: 'active', start_date: '2025-10-01' })
    })

    it('links the Asset to no line, and lets it go live, when none matches', () => {
        platform.tables[LINES] = [
            subscriptionLine({ sys_id: 'ended', status: 'ended' }),
            subscriptionLine({ sys_id: 'other-agreement', agreement: 'ag2' }),
            subscriptionLine({ sys_id: 'other-class', device_class: 'firewall' }),
            subscriptionLine({ sys_id: 'other-site', site: 'site2' }),
        ]
        const before = platform.tables[LINES].map((row) => ({ ...row }))
        const asset = goingLive()

        expect(attachToSubscription(asset, LIVE_AT)).toBe(true)

        expect(asset.getValue('x_daas_ham_subscription_line')).toBeNull()
        expect(platform.tables[LINES]).toEqual(before)
    })

    it("chooses the Site's package over a device-class line", () => {
        platform.tables[LINES] = [subscriptionLine(), subscriptionLine({ sys_id: 'pkg', line_type: 'site_package', device_class: '', site: 'site1' })]
        const asset = goingLive()

        attachToSubscription(asset, LIVE_AT)

        expect(asset.getValue('x_daas_ham_subscription_line')).toBe('pkg')
        expect(lineRow('pkg').status).toBe('active')
        expect(lineRow('sub1').status).toBe('pending')
    })
})

describe('a pending line that cannot be started', () => {
    it('keeps the Asset off it when the platform refuses the save', () => {
        platform.refuses = (table, _row, operation) => (table === LINES && operation === 'update' ? 'line locked by finance' : '')
        const asset = goingLive()

        expect(attachToSubscription(asset, LIVE_AT)).toBe(false)

        expect(asset.getValue('x_daas_ham_subscription_line')).toBeNull()
        expect(lineRow().status).toBe('pending')
        expect(platform.warnings).toEqual([expect.stringContaining('FOC111 stays pending in service, line not started: line locked by finance')])
        expect(platform.tables[LOCKS]).toEqual([])
    })

    it('keeps the Asset off it when another go-live holds its lock through every try', () => {
        platform.tables[LOCKS] = [{ sys_id: 'lock1', name: LOCK.subscriptionLine('sub1'), sys_created_on: '2025-11-09 12:00:00' }]
        const asset = goingLive()

        expect(attachToSubscription(asset, LIVE_AT)).toBe(false)

        expect(lineRow().status).toBe('pending')
        expect(platform.warnings).toEqual([expect.stringContaining('line not started: another go-live held its lock through every try')])
    })
})

describe('a pending line changed between the read and its lock', () => {
    /** Another transaction's write lands as this go-live takes the line's lock. */
    function asTheLockIsTaken(change: () => void): void {
        platform.onSave = (table, _row, operation) => {
            if (table === LOCKS && operation === 'insert') change()
        }
    }

    it('is joined with its start date kept when another go-live started it', () => {
        asTheLockIsTaken(() => Object.assign(lineRow(), { status: 'active', start_date: '2025-11-07' }))
        const asset = goingLive()

        expect(attachToSubscription(asset, LIVE_AT)).toBe(true)

        expect(asset.getValue('x_daas_ham_subscription_line')).toBe('sub1')
        expect(lineRow()).toMatchObject({ status: 'active', start_date: '2025-11-07' })
    })

    it('is not started again once ended by hand', () => {
        asTheLockIsTaken(() => Object.assign(lineRow(), { status: 'ended', end_date: '2025-11-08' }))
        const asset = goingLive()

        expect(attachToSubscription(asset, LIVE_AT)).toBe(false)

        expect(lineRow()).toMatchObject({ status: 'ended', start_date: '' })
        expect(platform.warnings).toEqual([expect.stringContaining('line not started: the line is ended now')])
    })

    it('keeps the Asset pending once it is gone', () => {
        asTheLockIsTaken(() => (platform.tables[LINES] = []))
        const asset = goingLive()

        expect(attachToSubscription(asset, LIVE_AT)).toBe(false)

        expect(platform.warnings).toEqual([expect.stringContaining('line not started: the line is gone')])
    })
})
