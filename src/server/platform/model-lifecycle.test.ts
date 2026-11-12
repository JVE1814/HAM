import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EVENT } from '../domain/events.ts'
import type { GlideRecord } from '@servicenow/glide'
import { onModelLifecycleChanged } from '../entry/models.ts'
import { importLifecycleRow, queueModelRefresh, queueModelsReachingMilestone, readModelLifecycle, writeModelLifecycle } from './model-lifecycle.ts'
import { platform, recordOf, type Row } from '../test-support/fake-glide.ts'

/*
 * The repository run against the in-memory stand-in for the platform, whose Model lifecycle table applies the
 * platform's own rules as read on the instance: a start date is required, and one Model has one
 * active row per lifecycle type, phase and source.
 */

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

const TABLE = 'cmdb_model_lifecycle'

function platformRules(row: Row, others: Row[]): string {
    if (!row.start_date) return 'Phase start date is invalid or not provided'
    const twin = others.find(
        (other) =>
            row.active === 'true' && ['model', 'lifecycle_type', 'lifecycle_phase', 'source', 'active'].every((field) => other[field] === row[field]),
    )
    return twin ? 'A record with the same combination already exists' : ''
}

/** The Models there are, by sys_id, each with its OEM PID: a Model without one is the Provider IT's. */
function models(pids: Record<string, string>): void {
    platform.tables.cmdb_model = Object.entries(pids).map(([sysId, pid]) => ({ sys_id: sysId, x_daas_ham_oem_pid: pid }))
}

const rows = (): Row[] => (platform.tables[TABLE] ??= [])

const queued = () => platform.events.map(({ name, record, parm1 }) => ({ name, row: record, parm1 }))

const MODEL = 'model1'

const lifecycleRule = (row: Row) => onModelLifecycleChanged(recordOf<GlideRecord>(TABLE, row), null)

function stored(row: Row): void {
    const sysId = `row${rows().length + 1}`
    rows().push({
        sys_id: sysId,
        sys_class_name: 'cmdb_hardware_model_lifecycle',
        model: MODEL,
        lifecycle_type: 'publisher',
        source: 'service_now',
        active: 'true',
        sys_updated_on: sysId,
        ...row,
    })
}

const rowsOf = (modelId: string) =>
    rows().filter((row) => row.model === modelId).map((row) => `${row.lifecycle_phase} ${row.start_date} ${row.source} ${row.description ?? ''}`.trim())

beforeEach(() => {
    platform.reset()
    platform.parents = { cmdb_hardware_model_lifecycle: [TABLE] }
    platform.references = { [`${TABLE}.model`]: 'cmdb_model' }
    platform.constraints[TABLE] = platformRules
    models({ [MODEL]: 'C9300-48P-E' })
})

describe('writeModelLifecycle', () => {
    it('stores each milestone given on a row of its own: a hardware lifecycle row of the manufacturer, active, with its provenance', () => {
        const written = writeModelLifecycle(MODEL, { endOfSale: '2028-10-31', endOfSupport: '2033-10-31' }, { source: 'cisco', reference: 'https://example.test/eol.html' })
        expect(written).toEqual({ inserted: 2, updated: 0, unchanged: 0, refused: [] })
        expect(rows()).toEqual([
            expect.objectContaining({
                sys_class_name: 'cmdb_hardware_model_lifecycle',
                model: MODEL,
                lifecycle_type: 'publisher',
                source: 'internal',
                lifecycle_phase: 'end_of_sale',
                start_date: '2028-10-31',
                active: 'true',
                description: 'Cisco EoX API: https://example.test/eol.html',
            }),
            expect.objectContaining({ lifecycle_phase: 'end_of_support', start_date: '2033-10-31' }),
        ])
        expect(readModelLifecycle(MODEL)).toEqual({ endOfSale: '2028-10-31', endOfSupport: '2033-10-31' })
    })

    it('queues the recomputation once for all the milestones it saves, though the rule on the table runs on each save', () => {
        platform.onSave = (_table, row) => lifecycleRule(row)
        writeModelLifecycle(MODEL, { endOfSale: '2028-10-31', endOfSupport: '2033-10-31', endOfLife: '2035-10-31' }, { source: 'csv' })
        expect(queued()).toEqual([{ name: EVENT.lifecycleChanged, row: MODEL, parm1: MODEL }])

        platform.events = []
        stored({ lifecycle_phase: 'end_of_life', start_date: '2036-01-31', source: 'service_now' })
        lifecycleRule(rows().at(-1)!)
        expect(queued()).toEqual([{ name: EVENT.lifecycleChanged, row: MODEL, parm1: MODEL }])
    })

    it('leaves a milestone stored as given alone, and queues nothing', () => {
        writeModelLifecycle(MODEL, { endOfSale: '2028-10-31' }, { source: 'csv', reference: 'EOL-1' })
        platform.events = []
        const saves: Row[] = []
        platform.onSave = (_table, row) => saves.push(row)
        expect(writeModelLifecycle(MODEL, { endOfSale: '2028-10-31' }, { source: 'csv', reference: 'EOL-1' })).toEqual({ inserted: 0, updated: 0, unchanged: 1, refused: [] })
        expect(saves).toEqual([])
        expect(queued()).toEqual([])
    })

    it('replaces a date the source gives and keeps the milestones it does not give', () => {
        writeModelLifecycle(MODEL, { endOfSale: '2028-10-31', endOfLife: '2035-10-31' }, { source: 'csv', reference: 'EOL-1' })
        platform.events = []
        const written = writeModelLifecycle(MODEL, { endOfSale: '2029-01-31', endOfSupport: '2033-10-31' }, { source: 'cisco' })
        expect(written).toEqual({ inserted: 1, updated: 1, unchanged: 0, refused: [] })
        expect(rowsOf(MODEL)).toEqual([
            'end_of_sale 2029-01-31 internal Cisco EoX API',
            'end_of_life 2035-10-31 internal CSV import: EOL-1',
            'end_of_support 2033-10-31 internal Cisco EoX API',
        ])
        expect(queued()).toHaveLength(1)
    })

    it('records a new provenance of an unchanged date without queueing the recomputation', () => {
        writeModelLifecycle(MODEL, { endOfSale: '2028-10-31' }, { source: 'csv', reference: 'EOL-1' })
        platform.events = []
        expect(writeModelLifecycle(MODEL, { endOfSale: '2028-10-31' }, { source: 'cisco' }).updated).toBe(1)
        expect(rowsOf(MODEL)).toEqual(['end_of_sale 2028-10-31 internal Cisco EoX API'])
        expect(queued()).toEqual([])
    })

    it('updates the row kept by hand in the parent class rather than adding a second one the platform would refuse', () => {
        stored({ sys_class_name: 'cmdb_model_lifecycle', source: 'internal', lifecycle_phase: 'end_of_sale', start_date: '2028-01-01' })
        expect(writeModelLifecycle(MODEL, { endOfSale: '2028-10-31' }, { source: 'csv' })).toEqual({ inserted: 0, updated: 1, unchanged: 0, refused: [] })
        expect(rowsOf(MODEL)).toEqual(['end_of_sale 2028-10-31 internal CSV import'])
    })

    it('reports each milestone the platform refuses with its reason, and saves the others', () => {
        platform.refuses = (_table, row) => (row.lifecycle_phase === 'end_of_support' ? 'aborted by a rule' : '')
        const written = writeModelLifecycle(MODEL, { endOfSale: '2028-10-31', endOfSupport: '2033-10-31' }, { source: 'csv' })
        expect(written).toEqual({ inserted: 1, updated: 0, unchanged: 0, refused: ['end of support: aborted by a rule'] })
        expect(rowsOf(MODEL)).toEqual(['end_of_sale 2028-10-31 internal CSV import'])
        expect(queued()).toHaveLength(1)
    })

    it('writes nothing for a source that gives no milestone', () => {
        expect(writeModelLifecycle(MODEL, {}, { source: 'csv' })).toEqual({ inserted: 0, updated: 0, unchanged: 0, refused: [] })
        expect(rows()).toEqual([])
        expect(queued()).toEqual([])
    })
})

describe('readModelLifecycle', () => {
    it('gives no milestone for a Model with no row, or no Model', () => {
        expect(readModelLifecycle(MODEL)).toEqual({})
        expect(readModelLifecycle('')).toEqual({})
    })

    it('honours the milestones another source keeps, of either class', () => {
        stored({ lifecycle_phase: 'end_of_support', start_date: '2033-10-31' })
        stored({ sys_class_name: 'cmdb_model_lifecycle', source: 'internal', lifecycle_phase: 'end_of_life', start_date: '2035-10-31' })
        expect(readModelLifecycle(MODEL)).toEqual({ endOfSupport: '2033-10-31', endOfLife: '2035-10-31' })
    })

    it("lets the app's own source win where two rows give the same milestone, whichever was updated last", () => {
        writeModelLifecycle(MODEL, { endOfSupport: '2033-10-31' }, { source: 'csv' })
        stored({ lifecycle_phase: 'end_of_support', start_date: '2034-01-31', sys_updated_on: 'zzz' })
        stored({ lifecycle_phase: 'end_of_sale', start_date: '2028-10-31' })
        expect(readModelLifecycle(MODEL)).toEqual({ endOfSale: '2028-10-31', endOfSupport: '2033-10-31' })
    })

    it('reads active manufacturer milestones only: no inactive row, internal plan, general availability or other Model', () => {
        stored({ lifecycle_phase: 'end_of_sale', start_date: '2028-10-31', active: 'false' })
        stored({ lifecycle_phase: 'end_of_support', start_date: '2033-10-31', lifecycle_type: 'internal' })
        stored({ lifecycle_phase: 'availability', start_date: '2020-01-01' })
        stored({ lifecycle_phase: 'end_of_life', start_date: '2035-10-31', model: 'model2' })
        expect(readModelLifecycle(MODEL)).toEqual({})
    })
})

describe('queueModelsReachingMilestone', () => {
    it('queues each NaaS Model with a milestone dated that day once, whatever its source', () => {
        models({ [MODEL]: 'C9300-48P-E', model2: 'FG-60F', laptop: '' })
        stored({ lifecycle_phase: 'end_of_sale', start_date: '2026-11-09' })
        stored({ lifecycle_phase: 'end_of_support', start_date: '2026-11-09', source: 'internal' })
        stored({ lifecycle_phase: 'end_of_life', start_date: '2026-11-09', model: 'model2', source: 'internal' })
        stored({ lifecycle_phase: 'end_of_sale', start_date: '2026-11-10', model: 'model2', source: 'internal' })
        stored({ lifecycle_phase: 'end_of_sale', start_date: '2026-11-09', model: 'laptop', source: 'internal' })
        stored({ lifecycle_phase: 'end_of_sale', start_date: '2026-11-09', model: 'model3', active: 'false' })
        queueModelsReachingMilestone('2026-11-09')
        expect(queued().map((event) => event.parm1).sort()).toEqual([MODEL, 'model2'])
        expect(queued().every((event) => event.name === EVENT.lifecycleChanged)).toBe(true)
    })
})

describe('queueModelRefresh', () => {
    it('queues the event on the Model, for a NaaS Model only', () => {
        models({ [MODEL]: 'C9300-48P-E', laptop: '' })
        queueModelRefresh(MODEL)
        queueModelRefresh('laptop')
        queueModelRefresh('gone')
        expect(queued()).toEqual([{ name: EVENT.lifecycleChanged, row: MODEL, parm1: MODEL }])
    })
})

function lifecycleRow(row: Row): GlideRecord {
    return recordOf<GlideRecord>('x_daas_ham_eox_import', { sys_id: 'row1', manufacturer: 'Cisco', ...row })
}

describe('importLifecycleRow', () => {
    it('refuses a milestone that goes backwards from the dates stored, and saves none of the row', () => {
        writeModelLifecycle(MODEL, { endOfSale: '2025-06-30', endOfSupport: '2030-06-30' }, { source: 'csv' })
        const outcome = importLifecycleRow(lifecycleRow({ pid: 'C9300-48P-E', end_of_support: '2024-01-31' }))
        expect(outcome).toEqual({ state: 'error', comment: expect.stringContaining('end of sale after end of support') })
        expect(readModelLifecycle(MODEL)).toEqual({ endOfSale: '2025-06-30', endOfSupport: '2030-06-30' })
    })

    it('keeps the milestones a row leaves blank and saves those it gives in order with them', () => {
        writeModelLifecycle(MODEL, { endOfSale: '2025-06-30' }, { source: 'csv' })
        expect(importLifecycleRow(lifecycleRow({ pid: 'C9300-48P-E', end_of_support: '2030-06-30' }))).toEqual({
            state: 'inserted',
            comment: 'Lifecycle for C9300-48P-E',
        })
        expect(readModelLifecycle(MODEL)).toEqual({ endOfSale: '2025-06-30', endOfSupport: '2030-06-30' })
    })

    it('marks a row with no date at all ignored, whatever its PID', () => {
        expect(importLifecycleRow(lifecycleRow({ pid: 'UNKNOWN-PID' }))).toMatchObject({ state: 'ignored' })
        expect(importLifecycleRow(lifecycleRow({ pid: '', manufacturer: '' }))).toMatchObject({ state: 'ignored' })
        expect(platform.tables.cmdb_model_lifecycle ?? []).toEqual([])
    })

    it('still refuses a row with a date and no PID, or a PID no Model has', () => {
        expect(importLifecycleRow(lifecycleRow({ pid: ' ', end_of_sale: '2025-06-30' }))).toEqual({ state: 'error', comment: 'PID is required' })
        expect(importLifecycleRow(lifecycleRow({ pid: 'UNKNOWN-PID', end_of_sale: '2025-06-30' }))).toEqual({
            state: 'error',
            comment: 'PID UNKNOWN-PID does not map to a model',
        })
    })
})
