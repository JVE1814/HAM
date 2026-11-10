import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fieldsOf } from '../domain/lifecycle.ts'
import { raiseReturn } from './returns.ts'
import { platform, type Row } from '../test-support/fake-glide.ts'

/*
 * A Return raised for a unit whose return lock another Return holds through every try, run against the in-memory
 * stand-in for the platform, job locks included.
 */

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

const RETURNS = 'x_daas_ham_return_order'
const RETURN_LINES = 'x_daas_ham_return_order_line'
const LOCKS = 'x_daas_ham_job_lock'

const rows = (table: string): Row[] => platform.tables[table] ?? []

/** Raise a Return for the unit, as a device removal the Site ships back. */
function raise() {
    return raiseReturn({
        trigger: 'device_removal',
        customerId: 'acme',
        siteId: 'site1',
        agreementId: '',
        method: 'ship_back',
        assetIds: ['a1'],
        description: 'Return of a1',
    })
}

beforeEach(() => {
    platform.reset()
    platform.uniqueKeys = { [LOCKS]: 'name' }
    platform.defaults = { [RETURNS]: () => ({ number: 'RET0002' }) }
    const { installStatus, substatus } = fieldsOf('in_service')
    platform.tables.alm_hardware = [{ sys_id: 'a1', serial_number: 'FOC111', x_daas_ham_fleet: 'true', install_status: installStatus, substatus: substatus ?? '' }]
    // Another Return holds the unit's return lock, taken just now.
    platform.tables[LOCKS] = [{ sys_id: 'lock1', name: 'return_asset_a1', sys_created_on: '2025-11-09 12:00:00' }]
})

describe('a unit whose return lock is held through every try', () => {
    it('is left to the Return that took it, when it awaits that one by now', () => {
        platform.tables[RETURN_LINES] = [{ sys_id: 'line1', return_order: 'ret1', asset: 'a1', status: 'awaiting' }]
        expect(raise()).toEqual({ number: 'RET0002', lines: 0 })
        expect(rows(RETURN_LINES)).toHaveLength(1)
        expect(platform.logs).toEqual(['info [x_daas_ham] Asset a1 left off return RET0002: another return held its lock and took it'])
        expect(rows(RETURNS)[0]?.work_notes).toBe('No equipment to bring back.')
    })

    it('is warned about and counted as refused when it awaits no return: its holder never put it on one', () => {
        expect(raise()).toEqual({ number: 'RET0002', lines: 0 })
        expect(rows(RETURN_LINES)).toEqual([])
        expect(platform.logs).toEqual([
            'warn [x_daas_ham] Asset a1 left off return RET0002: its return lock was held through every try, yet it awaits no return: put it on one by hand if it is due back',
        ])
        expect(rows(RETURNS)[0]?.work_notes).toBe('No unit could be added (see the system log).')
    })
})
