import type { GlideRecord } from '@servicenow/glide'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fieldsOf, stageOf, type Stage } from '../domain/lifecycle.ts'
import type { ClosedStagingTask } from '../domain/staging.ts'
import { completeStaging, openStagingTask, stagingClosureProblem } from './staging-tasks.ts'
import { platform, recordOf, type Row } from '../test-support/fake-glide.ts'

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

const ORDERS = 'x_daas_ham_order'
const LINES = 'x_daas_ham_order_line'
const ASSETS = 'alm_hardware'
const TASKS = 'x_daas_ham_staging_task'
const STEPS = 'x_daas_ham_staging_step'

const rows = (table: string): Row[] => platform.tables[table] ?? []
const unit = (): Row => rows(ASSETS)[0]
const stageOfUnit = (): Stage | null => stageOf({ installStatus: unit().install_status, substatus: unit().substatus })

function inStage(stage: Stage): Row {
    const { installStatus, substatus } = fieldsOf(stage)
    return { install_status: installStatus, substatus: substatus ?? '' }
}

const task: ClosedStagingTask = { number: 'NSTG0001', lineId: 'line1', failed: false }

function current(): GlideRecord {
    return recordOf<GlideRecord>(TASKS, rows(TASKS)[0])
}

beforeEach(() => {
    platform.reset()
    platform.references = { [`${ASSETS}.x_daas_ham_order_line`]: LINES, [`${LINES}.order`]: ORDERS }
    platform.tables[ORDERS] = [{ sys_id: 'order1', number: 'ORD0001', stage: 'preparing' }]
    platform.tables[LINES] = [{ sys_id: 'line1', number: 'ORL0001', order: 'order1', quantity: '1', line_stage: 'staging' }]
    platform.tables[ASSETS] = [{ sys_id: 'asset1', serial_number: 'FOC111', x_daas_ham_order_line: 'line1', x_daas_ham_agreement: 'agr1', ...inStage('staging') }]
    platform.tables[TASKS] = [
        { sys_id: 'task1', number: 'NSTG0001', asset: 'asset1', order_line: 'line1', active: 'true', sys_created_on: '2025-11-01 10:00:00' },
    ]
    platform.tables[STEPS] = [{ sys_id: 'step1', staging_task: 'task1', mandatory: 'true', done: 'false' }]
})

describe('closing a Staging task complete', () => {
    it('is refused while a mandatory step is open, unless the task failed', () => {
        expect(stagingClosureProblem(current(), task, 'complete')).toBe('1 mandatory staging step(s) are still open')
        expect(stagingClosureProblem(current(), { ...task, failed: true }, 'complete')).toBeNull()
        rows(STEPS)[0].done = 'true'
        expect(stagingClosureProblem(current(), task, 'complete')).toBeNull()
    })

    it('is refused while its unit is still in transfer to the staging centre, whatever its steps', () => {
        Object.assign(unit(), inStage('in_transfer'))
        rows(STEPS)[0].done = 'true'

        expect(stagingClosureProblem(current(), task, 'complete')).toBe(
            'FOC111 is still in transfer to the staging centre: close NSTG0001 once the staging centre receives it',
        )
    })

    it('is refused once the unit was sourced again under a newer open task, and not for an older or a closed one', () => {
        rows(STEPS)[0].done = 'true'
        const other = { sys_id: 'task2', number: 'NSTG0002', asset: 'asset1', order_line: 'line1', active: 'true', sys_created_on: '2025-11-03 09:00:00' }
        rows(TASKS).push(other)

        expect(stagingClosureProblem(current(), task, 'complete')).toBe(
            'FOC111 has a newer Staging task, NSTG0002: close NSTG0001 skipped and stage the unit under NSTG0002',
        )

        other.active = 'false'
        expect(stagingClosureProblem(current(), task, 'complete')).toBeNull()
        Object.assign(other, { active: 'true', sys_created_on: '2025-10-30 09:00:00' })
        expect(stagingClosureProblem(current(), task, 'complete')).toBeNull()
    })

    it('is refused when its Asset cannot be read', () => {
        rows(ASSETS).pop()

        expect(stagingClosureProblem(current(), task, 'complete')).toBe('The asset of NSTG0001 cannot be read: close NSTG0001 skipped')
    })
})

describe('closing a Staging task skipped (or incomplete)', () => {
    it('is refused while its unit, in staging on its open line, still needs it', () => {
        expect(stagingClosureProblem(current(), task, 'skipped')).toBe(
            'FOC111 is in staging for its order line, which needs NSTG0001: close NSTG0001 complete, or failed to send the unit for evaluation',
        )
    })

    it("passes once the unit's Order was cancelled, as the cancel's own skip of the task does", () => {
        rows(ORDERS)[0].stage = 'cancelled'

        expect(stagingClosureProblem(current(), task, 'skipped')).toBeNull()
    })
})

describe('a Staging task closed complete', () => {
    it('stages its unit', () => {
        expect(completeStaging('asset1', task)).toBeNull()

        expect(stageOfUnit()).toBe('staged')
    })

    it('moves nothing for a unit that left the line between the closure check and the move, and says so', () => {
        unit().x_daas_ham_order_line = ''
        Object.assign(unit(), inStage('available'))

        expect(completeStaging('asset1', task)).toBe(
            'NSTG0001 is closed but moved nothing (reopen it to close it again): FOC111 is no longer on the order line NSTG0001 stages for: close NSTG0001 skipped',
        )

        expect(stageOfUnit()).toBe('available')
    })
})

describe('opening a Staging task', () => {
    const TEMPLATES = 'x_daas_ham_staging_template'
    const ITEMS = 'x_daas_ham_staging_tmpl_item'

    function templateFor(vendor: string): GlideRecord {
        platform.references = { ...platform.references, [`${ASSETS}.model`]: 'cmdb_model' }
        platform.tables.cmdb_model = [{ sys_id: 'model1', x_daas_ham_oem_source: vendor }]
        platform.tables[TEMPLATES] = [{ sys_id: 'tmpl1', name: 'Firewall', active: 'true', customer: '', manufacturer: '', device_class: '', staging_source: 'in_house' }]
        platform.tables[ITEMS] = [
            { sys_id: 'item1', template: 'tmpl1', label: 'Claim into the cloud', order: '100', mandatory: 'true', automation: 'oem_claim' },
            { sys_id: 'item2', template: 'tmpl1', label: 'Zero-touch', order: '200', mandatory: 'true', automation: 'oem_ztp' },
        ]
        platform.tables[STEPS] = []
        unit().model = 'model1'
        return recordOf<GlideRecord>(ASSETS, unit())
    }

    const steps = () => rows(STEPS).map(({ label, automation, automation_status }) => ({ label, automation: automation ?? '', status: automation_status ?? '' }))

    it("keeps a step's automation only for an action its vendor can do, so no step waits on one never sent", () => {
        expect(openStagingTask(templateFor('checkpoint'), 'line1')).not.toBeNull()

        expect(steps()).toEqual([
            { label: 'Claim into the cloud', automation: '', status: '' },
            { label: 'Zero-touch', automation: 'oem_ztp', status: 'pending' },
        ])
    })

    it('leaves every step of a Cisco unit to do by hand', () => {
        expect(openStagingTask(templateFor('cisco'), 'line1')).not.toBeNull()

        expect(steps().map(({ automation }) => automation)).toEqual(['', ''])
    })

    it('copies both automations for a vendor that can do both, the zero-touch step waiting for the claim', () => {
        expect(openStagingTask(templateFor('fortinet'), 'line1')).not.toBeNull()

        expect(steps().map(({ automation, status }) => `${automation} ${status}`)).toEqual(['oem_claim pending', 'oem_ztp waiting'])
    })
})
