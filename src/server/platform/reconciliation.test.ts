import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PROPERTY } from '../domain/properties.ts'
import { reconcileInstalledBase } from './reconciliation.ts'
import { platform } from '../test-support/fake-glide.ts'

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

const EXCEPTIONS = 'x_daas_ham_recon_exception'

const statusOf = (sysId: string) => platform.tables[EXCEPTIONS].find((row) => row.sys_id === sysId)?.status

beforeEach(() => {
    platform.reset()
    platform.references = { [`${EXCEPTIONS}.asset`]: 'alm_hardware' }
    platform.properties = { [PROPERTY.unseenDays.name]: '7' }
    // Each last seen ten days before the clock's 2025-11-09.
    const lastSeen = '2025-10-30 12:00:00'
    platform.tables.alm_hardware = [
        { sys_id: 'serving', install_status: '1', substatus: '', x_daas_ham_fleet: 'true', x_daas_ham_last_seen: lastSeen },
        { sys_id: 'returning', install_status: '1', substatus: 'pending_return', x_daas_ham_fleet: 'true', x_daas_ham_last_seen: lastSeen },
        { sys_id: 'disposed', install_status: '7', substatus: 'disposed', x_daas_ham_fleet: 'true', x_daas_ham_last_seen: lastSeen },
    ]
    platform.tables[EXCEPTIONS] = ['serving', 'returning', 'disposed'].map((asset) => ({
        sys_id: `unseen-${asset}`,
        exception_type: 'unseen',
        asset,
        status: 'open',
    }))
})

describe('reconcileInstalledBase', () => {
    it('keeps the exception of a fleet asset in use that monitoring still misses, and resolves those of one that left service', () => {
        reconcileInstalledBase()
        expect(['unseen-serving', 'unseen-returning', 'unseen-disposed'].map(statusOf)).toEqual(['open', 'resolved', 'resolved'])
    })
})
