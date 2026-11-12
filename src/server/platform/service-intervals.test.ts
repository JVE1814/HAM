import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fieldsOf, type Stage } from '../domain/lifecycle.ts'
import { LOCK } from '../domain/lock-names.ts'
import { closeServiceIntervals, moveServiceInterval } from './service-intervals.ts'
import { platform, type Row } from '../test-support/fake-glide.ts'

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

const ASSETS = 'alm_hardware'
const INTERVALS = 'x_daas_ham_service_interval'

const interval = (): Row => (platform.tables[INTERVALS] ?? [])[0]

function assetIn(stage: Stage): Row {
    const { installStatus, substatus } = fieldsOf(stage)
    return { sys_id: 'asset1', serial_number: 'FOC111', install_status: installStatus, substatus: substatus ?? '' }
}

beforeEach(() => {
    platform.reset()
    platform.uniqueKeys = { x_daas_ham_job_lock: 'name' }
    platform.references = { [`${INTERVALS}.asset`]: ASSETS }
    platform.tables[INTERVALS] = [{ sys_id: 'int1', asset: 'asset1', subscription_line: 'sub1', start_date: '2025-10-01', end_date: '' }]
})

describe('stopping billing for an Asset', () => {
    it('closes its open interval on the day it left service', () => {
        platform.tables[ASSETS] = [assetIn('pending_return')]

        closeServiceIntervals('asset1', '2025-11-09')

        expect(interval().end_date).toBe('2025-11-09')
    })

    it('keeps the interval open of an Asset a later save put back in service', () => {
        platform.tables[ASSETS] = [assetIn('in_service')]

        closeServiceIntervals('asset1', '2025-11-09')

        expect(interval().end_date).toBe('')
    })
})

describe('moving the billing of an Asset in service', () => {
    const LOCKS = 'x_daas_ham_job_lock'
    const TODAY = '2025-11-09'
    const TOMORROW = '2025-11-10'

    /** The Asset in service, as stored after the save that changed its line or Site. */
    const inService = (fields: Row = {}): Row => ({ ...assetIn('in_service'), company: 'acme', x_daas_ham_subscription_line: 'sub1', x_daas_ham_site: 'site1', ...fields })
    const stored = (id: string, lineId: string, start: string, end: string, siteId = 'site1'): Row => ({ sys_id: id, asset: 'asset1', subscription_line: lineId, site: siteId, start_date: start, end_date: end })
    /** Each interval as [Subscription line, Site, first day, last day], in the order stored. */
    const billed = () => (platform.tables[INTERVALS] ?? []).map((row) => [row.subscription_line, row.site, row.start_date, row.end_date ?? ''])

    beforeEach(() => {
        platform.tables[INTERVALS] = [stored('int1', 'sub1', '2025-10-01', '')]
    })

    it('ends the interval on the old line today and starts one on the new line tomorrow, so the day is billed once', () => {
        platform.tables[ASSETS] = [inService({ x_daas_ham_subscription_line: 'sub2' })]

        moveServiceInterval('asset1', TODAY)

        expect(billed()).toEqual([
            ['sub1', 'site1', '2025-10-01', TODAY],
            ['sub2', 'site1', TOMORROW, ''],
        ])
        expect(platform.tables[INTERVALS]?.[1]).toMatchObject({ asset: 'asset1', customer: 'acme' })
        expect(platform.tables[LOCKS]).toEqual([])
    })

    it('does the same for an Asset moved to another Site on its line', () => {
        platform.tables[ASSETS] = [inService({ x_daas_ham_site: 'site2' })]

        moveServiceInterval('asset1', TODAY)

        expect(billed()).toEqual([
            ['sub1', 'site1', '2025-10-01', TODAY],
            ['sub1', 'site2', TOMORROW, ''],
        ])
    })

    it('starts an interval today for an Asset given its first line while in service', () => {
        platform.tables[INTERVALS] = []
        platform.tables[ASSETS] = [inService()]

        moveServiceInterval('asset1', TODAY)

        expect(billed()).toEqual([['sub1', 'site1', TODAY, '']])
    })

    it('ends the interval of an Asset left without a line, and starts none', () => {
        platform.tables[ASSETS] = [inService({ x_daas_ham_subscription_line: '' })]

        moveServiceInterval('asset1', TODAY)

        expect(billed()).toEqual([['sub1', 'site1', '2025-10-01', TODAY]])
    })

    it('leaves the interval of an Asset already billed where it is alone, however often it runs', () => {
        platform.tables[ASSETS] = [inService({ x_daas_ham_subscription_line: 'sub2' })]

        moveServiceInterval('asset1', TODAY)
        moveServiceInterval('asset1', TODAY)

        expect(billed()).toEqual([
            ['sub1', 'site1', '2025-10-01', TODAY],
            ['sub2', 'site1', TOMORROW, ''],
        ])
    })

    it('takes back a move made earlier the same day: the interval not yet started is removed and the old one reopened', () => {
        platform.tables[INTERVALS] = [stored('int1', 'sub1', '2025-10-01', TODAY), stored('int2', 'sub2', TOMORROW, '')]
        platform.tables[ASSETS] = [inService()]

        moveServiceInterval('asset1', TODAY)

        expect(billed()).toEqual([['sub1', 'site1', '2025-10-01', '']])
    })

    it('bills no day on a line the Asset was moved to and off again the same day', () => {
        platform.tables[INTERVALS] = [stored('int1', 'sub1', '2025-10-01', TODAY), stored('int2', 'sub2', TOMORROW, '')]
        platform.tables[ASSETS] = [inService({ x_daas_ham_subscription_line: 'sub3' })]

        moveServiceInterval('asset1', TODAY)

        expect(billed()).toEqual([
            ['sub1', 'site1', '2025-10-01', TODAY],
            ['sub3', 'site1', TOMORROW, ''],
        ])
    })

    it('closes what is open for an Asset that has left service since, and starts nothing', () => {
        platform.tables[ASSETS] = [{ ...inService({ x_daas_ham_subscription_line: 'sub2' }), ...assetIn('pending_return') }]

        moveServiceInterval('asset1', TODAY)

        expect(billed()).toEqual([['sub1', 'site1', '2025-10-01', TODAY]])
    })

    it('starts no second interval when the platform refuses to end the old one, and says so', () => {
        platform.tables[ASSETS] = [inService({ x_daas_ham_subscription_line: 'sub2' })]
        platform.refuses = (table, _row, operation) => (table === INTERVALS && operation === 'update' ? 'no' : '')

        moveServiceInterval('asset1', TODAY)

        expect(billed()).toEqual([['sub1', 'site1', '2025-10-01', '']])
        expect(platform.warnings).toEqual([`[x_daas_ham] FOC111 changed its Subscription line or Site on ${TODAY}, its Service interval not moved: no`])
    })

    it('logs an interval left on the old line when another save holds its lock through every try', () => {
        platform.tables[ASSETS] = [inService({ x_daas_ham_subscription_line: 'sub2' })]
        platform.tables[LOCKS] = [{ sys_id: 'held', name: LOCK.serviceInterval('asset1'), sys_created_on: '2025-11-09 12:00:00' }]

        moveServiceInterval('asset1', TODAY)

        expect(billed()).toEqual([['sub1', 'site1', '2025-10-01', '']])
        expect(platform.logs).toContainEqual(
            `error [x_daas_ham] FOC111 changed its Subscription line or Site on ${TODAY}, its Service interval not moved: left to another save holding its lock, which has not finished; move it by hand if it is still on the old one`,
        )
    })
})
