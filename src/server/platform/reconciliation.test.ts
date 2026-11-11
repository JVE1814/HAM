import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reconcileInstalledBase } from './reconciliation.ts'
import { platform } from '../test-support/fake-glide.ts'

/*
 * The daily reconciliation's clean-up against in-memory tables. The comparison of each Asset in use is left out
 * (runTableJob does nothing here): what is tested is what becomes of the exceptions it no longer compares.
 */

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)
vi.mock('./chunked.ts', () => ({ runTableJob: () => undefined }))

const EXCEPTIONS = 'x_daas_ham_recon_exception'

const statusOf = (sysId: string) => platform.tables[EXCEPTIONS].find((row) => row.sys_id === sysId)?.status

beforeEach(() => {
    platform.reset()
    platform.references = { [`${EXCEPTIONS}.asset`]: 'alm_hardware' }
    platform.properties = { 'x_daas_ham.reconciliation.unseen_days': '7' }
    platform.tables.alm_hardware = [
        { sys_id: 'serving', install_status: '1', substatus: '', x_daas_ham_fleet: 'true' },
        { sys_id: 'returning', install_status: '1', substatus: 'pending_return', x_daas_ham_fleet: 'true' },
        { sys_id: 'disposed', install_status: '7', substatus: 'disposed', x_daas_ham_fleet: 'true' },
    ]
    platform.tables[EXCEPTIONS] = ['serving', 'returning', 'disposed'].map((asset) => ({
        sys_id: `unseen-${asset}`,
        exception_type: 'unseen',
        asset,
        status: 'open',
    }))
})

describe('reconcileInstalledBase', () => {
    it('resolves the monitoring exceptions of a fleet asset that has left service, and leaves one in use to the comparison', () => {
        reconcileInstalledBase()
        expect(['unseen-serving', 'unseen-returning', 'unseen-disposed'].map(statusOf)).toEqual(['open', 'resolved', 'resolved'])
    })
})
