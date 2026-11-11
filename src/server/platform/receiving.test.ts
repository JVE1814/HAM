import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fieldsOf, stageOf, type Stage } from '../domain/lifecycle.ts'
import { receive } from './receiving.ts'
import { platform, type Row } from '../test-support/fake-glide.ts'

/*
 * A scan at the depot of a unit coming back from a Site, run against the in-memory stand-in for the platform, job
 * locks included: the unit is on Return order RET0001, due back on 1 November, and is scanned on 9 November.
 */

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

const ASSETS = 'alm_hardware'
const RETURN_LINES = 'x_daas_ham_return_order_line'
const FEES = 'x_daas_ham_fee_event'
const DAY_MS = 24 * 60 * 60 * 1000

const rows = (table: string): Row[] => platform.tables[table] ?? []
const unit = (): Row => rows(ASSETS)[0]
const returnLine = (): Row => rows(RETURN_LINES)[0]
const stageOfUnit = (): Stage | null => stageOf({ installStatus: unit().install_status, substatus: unit().substatus })

function inStage(stage: Stage): Row {
    const { installStatus, substatus } = fieldsOf(stage)
    return { install_status: installStatus, substatus: substatus ?? '' }
}

beforeEach(() => {
    platform.reset()
    platform.uniqueKeys = { x_daas_ham_job_lock: 'name' }
    platform.references = {
        [`${ASSETS}.model`]: 'cmdb_model',
        [`${ASSETS}.stockroom`]: 'alm_stockroom',
        [`${RETURN_LINES}.return_order`]: 'x_daas_ham_return_order',
    }
    platform.tables.alm_stockroom = [
        { sys_id: 'depot1', name: 'Central depot', x_daas_ham_stockroom_type: 'central_depot' },
        { sys_id: 'depot2', name: 'Second depot', x_daas_ham_stockroom_type: 'central_depot' },
    ]
    platform.tables.x_daas_ham_agreement = [{ sys_id: 'agr1', late_return_fee: '150' }]
    platform.tables.x_daas_ham_return_order = [{ sys_id: 'ret1', number: 'RET0001', customer: 'acme', due_back: '2025-11-01' }]
    platform.tables[RETURN_LINES] = [{ sys_id: 'retline1', return_order: 'ret1', asset: 'asset1', status: 'awaiting', sys_created_on: '2025-10-01 09:00:00' }]
    platform.tables[ASSETS] = [
        {
            sys_id: 'asset1',
            serial_number: 'FOC111',
            asset_tag: 'NAAS-0000001',
            x_daas_ham_fleet: 'true',
            x_daas_ham_legal_owner: 'provider',
            company: 'acme',
            x_daas_ham_agreement: 'agr1',
            x_daas_ham_site: 'site1',
            ...inStage('pending_return'),
        },
    ]
})

describe('receiving a unit that comes back from a Site', () => {
    it('takes it in to await evaluation, marks its return line received and charges the late return', () => {
        expect(receive({ code: 'FOC111' }, 'depot1')).toHaveProperty('asset')

        expect(stageOfUnit()).toBe('pending_evaluation')
        expect(unit()).toMatchObject({ stockroom: 'depot1', x_daas_ham_site: '' })
        expect(returnLine()).toMatchObject({ status: 'received', received_at: '2025-11-09 12:00:00' })
        expect(rows(FEES)).toEqual([
            expect.objectContaining({ fee_type: 'late_return', asset: 'asset1', return_order: 'ret1', customer: 'acme', agreement: 'agr1', amount: '150', occurred_on: '2025-11-09' }),
        ])
    })

    it('refuses a second scan of the unit: no second late fee, and the unit and its line stay as the first receipt left them', () => {
        receive({ code: 'FOC111' }, 'depot1')
        const received = { unit: { ...unit() }, line: { ...returnLine() }, fees: rows(FEES).map((fee) => ({ ...fee })) }
        platform.clock += DAY_MS

        expect(receive({ code: 'FOC111' }, 'depot2')).toEqual({ reason: 'conflict', why: 'Not awaiting receipt (pending_evaluation)' })

        expect(rows(FEES)).toEqual(received.fees)
        expect(returnLine()).toEqual(received.line)
        expect(unit()).toEqual(received.unit)
    })

    it('settles only a line that still awaits the unit: the line of an earlier return stays as it was, and nothing is charged for it', () => {
        Object.assign(returnLine(), { status: 'evaluated', received_at: '2025-10-20 08:00:00' })
        const earlier = { ...returnLine() }

        expect(receive({ code: 'FOC111' }, 'depot1')).toHaveProperty('asset')

        expect(stageOfUnit()).toBe('pending_evaluation')
        expect(returnLine()).toEqual(earlier)
        expect(rows(FEES)).toEqual([])
    })
})
