import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fieldsOf, type Stage } from '../domain/lifecycle.ts'
import { closeServiceIntervals } from './service-intervals.ts'
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
