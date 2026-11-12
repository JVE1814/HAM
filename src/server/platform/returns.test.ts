import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fieldsOf, type Stage } from '../domain/lifecycle.ts'
import { LOCK } from '../domain/lock-names.ts'
import { FEE_STATUS, RETURN_LINE_STATUS } from '../domain/vocabulary.ts'
import { chaseOverdue, raiseReturn, requestReturn } from './returns.ts'
import { platform, type Row } from '../test-support/fake-glide.ts'

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

const RETURNS = 'x_daas_ham_return_order'
const RETURN_LINES = 'x_daas_ham_return_order_line'
const FEES = 'x_daas_ham_fee_event'
const LOCKS = 'x_daas_ham_job_lock'

const rows = (table: string): Row[] => platform.tables[table] ?? []

function unit(stage: Stage): Row {
    const { installStatus, substatus } = fieldsOf(stage)
    return { sys_id: 'a1', serial_number: 'FOC111', x_daas_ham_fleet: 'true', x_daas_ham_site: 'site1', x_daas_ham_agreement: 'ag1', install_status: installStatus, substatus: substatus ?? '' }
}

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
    platform.tables.alm_hardware = [unit('in_service')]
})

describe('a unit whose return lock is held through every try', () => {
    beforeEach(() => {
        // Another Return holds the unit's return lock, taken just now.
        platform.tables[LOCKS] = [{ sys_id: 'lock1', name: LOCK.returnAsset('a1'), sys_created_on: '2025-11-09 12:00:00' }]
    })

    it('is left to the Return that took it, when it awaits that one by now', () => {
        platform.tables[RETURN_LINES] = [{ sys_id: 'line1', return_order: 'ret1', asset: 'a1', status: 'awaiting' }]
        expect(raise()).toEqual({ number: 'RET0002', lines: 0 })
        expect(rows(RETURN_LINES)).toHaveLength(1)
        expect(platform.warnings).toEqual([])
        expect(rows(RETURNS)[0]?.work_notes).toBe('No equipment to bring back.')
    })

    it('is warned about and counted as refused when it awaits no return: its holder never put it on one', () => {
        expect(raise()).toEqual({ number: 'RET0002', lines: 0 })
        expect(rows(RETURN_LINES)).toEqual([])
        expect(platform.warnings).toEqual([expect.stringContaining('a1')])
        expect(rows(RETURNS)[0]?.work_notes).toBe('No unit could be added (see the system log).')
    })
})

describe("a Customer admin's device removal", () => {
    beforeEach(() => {
        platform.user = { id: 'u1', name: 'Ada', company: 'acme', roles: ['x_daas_ham.customer_admin'], interactive: true }
        platform.creatable = () => true
        platform.defaults[RETURN_LINES] = () => ({ status: RETURN_LINE_STATUS.awaiting })
        platform.defaults[FEES] = () => ({ status: FEE_STATUS.open })
        platform.references = { [`${RETURN_LINES}.return_order`]: RETURNS, [`${RETURNS}.agreement`]: 'x_daas_ham_agreement' }
        platform.clock = Date.parse('2026-11-11T06:00:00Z')
        platform.tables.cmn_location = [{ sys_id: 'site1', name: 'HQ', company: 'acme', x_daas_ham_is_site: 'true' }]
        platform.tables.x_daas_ham_agreement = [{ sys_id: 'ag1', lost_asset_fee: '500', overdue_return_days: '10' }]
    })

    const removeA1 = () => requestReturn({ customerId: 'acme', siteId: 'site1', decommission: false, listedAssetIds: ['a1'], method: 'ship_back', describe: (site) => `Return from ${site}` })

    it('takes a unit still shipped to the Site', () => {
        platform.tables.alm_hardware = [unit('shipped')]
        expect(removeA1()).toEqual({ raised: true, number: 'RET0002', lines: 1 })
    })

    it('names a unit pending return as already on a return', () => {
        platform.tables.alm_hardware = [unit('pending_return')]
        platform.tables[RETURN_LINES] = [{ sys_id: 'lineA', return_order: 'retA', asset: 'a1', status: 'awaiting' }]
        expect(removeA1()).toMatchObject({ raised: false, reason: 'awaited' })
    })

    it('ignores a unit already declared missing, so its lost fee is charged once', () => {
        platform.tables.alm_hardware = [unit('missing')]
        platform.tables[RETURNS] = [{ sys_id: 'retA', number: 'RET0001', state: '3', due_back: '2026-09-01' }]
        platform.tables[RETURN_LINES] = [{ sys_id: 'lineA', return_order: 'retA', asset: 'a1', status: 'missing' }]
        platform.tables[FEES] = [{ sys_id: 'fee1', fee_type: 'lost', asset: 'a1', return_order: 'retA', status: 'open', amount: '500' }]
        expect(removeA1()).toMatchObject({ raised: false, reason: 'nothing' })
        platform.clock = Date.parse('2026-12-31T06:00:00Z')
        chaseOverdue()
        expect(rows(FEES).filter((fee) => fee.fee_type === 'lost' && fee.asset === 'a1')).toHaveLength(1)
    })
})

describe("a Customer admin's site decommission", () => {
    beforeEach(() => {
        platform.user = { id: 'u1', name: 'Ada', company: 'acme', roles: ['x_daas_ham.customer_admin'], interactive: true }
        platform.creatable = () => true
        platform.defaults[RETURN_LINES] = () => ({ status: RETURN_LINE_STATUS.awaiting })
        platform.references = { [`${RETURN_LINES}.return_order`]: RETURNS, [`${RETURNS}.agreement`]: 'x_daas_ham_agreement' }
        platform.tables.cmn_location = [{ sys_id: 'site1', name: 'HQ', company: 'acme', x_daas_ham_is_site: 'true' }]
        platform.tables.x_daas_ham_agreement = [{ sys_id: 'ag1', overdue_return_days: '10' }]
    })

    const decommission = () => requestReturn({ customerId: 'acme', siteId: 'site1', decommission: true, listedAssetIds: [], method: 'ship_back', describe: (site) => `Decommission of ${site}` })
    const returning = (): string[] => rows(RETURN_LINES).map((line) => line.asset)

    it("takes back the Customer's own units at the Site, in every stage it recovers", () => {
        platform.tables.alm_hardware = [
            { ...unit('in_service'), sys_id: 'a1', company: 'acme' },
            { ...unit('shipped'), sys_id: 'a2', company: 'acme' },
        ]
        expect(decommission()).toEqual({ raised: true, number: 'RET0002', lines: 2 })
        expect(returning().sort()).toEqual(['a1', 'a2'])
    })

    it("leaves a unit at the Site that is another Customer's, or no Customer's, off the Return, whatever its stage", () => {
        platform.tables.alm_hardware = [
            { ...unit('in_service'), sys_id: 'a1', company: 'acme' },
            { ...unit('shipped'), sys_id: 'b1', company: 'other' },
            { ...unit('in_service'), sys_id: 'b2', company: 'other' },
            { ...unit('in_service'), sys_id: 'b3', company: '' },
        ]
        expect(decommission()).toEqual({ raised: true, number: 'RET0002', lines: 1 })
        expect(returning()).toEqual(['a1'])
    })
})
