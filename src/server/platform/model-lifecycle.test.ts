import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EVENT } from './events.ts'
import { queueModelsReachingMilestone, readModelLifecycle, writeModelLifecycle, writingModelLifecycle } from './model-lifecycle.ts'

/*
 * The repository run against an in-memory stand-in for the platform's Model lifecycle table, which applies the
 * platform's own rules as read on the instance (module comment): a start date is required, and one Model has one
 * active row per lifecycle type, phase and source.
 */

type Row = Record<string, string>

const platform = vi.hoisted(() => ({
    rows: [] as Array<Record<string, string>>,
    /** OEM PID by Model sys_id: a Model without one is the Provider IT's. */
    pids: {} as Record<string, string>,
    events: [] as Array<{ name: string; row: string; parm1: string }>,
    /** Why an insert or update of a row is refused, beyond the platform's rules. */
    refuses: (() => '') as (row: Record<string, string>) => string,
    /** Called with each row as it is saved. */
    onSave: (() => undefined) as (row: Record<string, string>) => void,
}))

vi.mock('@servicenow/glide', () => {
    const PARENT = 'cmdb_model_lifecycle'
    const valueOf = (row: Row, field: string): string =>
        field === 'model.x_daas_ham_oem_pid' ? (platform.pids[row.model ?? ''] ?? '') : (row[field] ?? '')
    const holds = (row: Row, term: string): boolean => {
        const empty = /^([\w.]+)ISNOTEMPTY$/.exec(term)
        if (empty) return valueOf(row, empty[1] ?? '') !== ''
        const anyOf = /^([\w.]+)IN(.*)$/.exec(term)
        if (anyOf) return (anyOf[2] ?? '').split(',').includes(valueOf(row, anyOf[1] ?? ''))
        const [field, value] = term.split('=')
        return valueOf(row, field ?? '') === value
    }
    const refusal = (row: Row): string => {
        if (!row.start_date) return 'Phase start date is invalid or not provided'
        const twin = platform.rows.find(
            (other) =>
                other !== row &&
                other.sys_id !== row.sys_id &&
                row.active === 'true' &&
                ['model', 'lifecycle_type', 'lifecycle_phase', 'source', 'active'].every((field) => other[field] === row[field]),
        )
        return twin ? 'A record with the same combination already exists' : platform.refuses(row)
    }
    class GlideRecord {
        private terms: string[] = []
        private order = ''
        private found: Row[] = []
        private at = -1
        private row: Row = {}
        private error = ''
        constructor(private readonly table: string) {}
        addQuery(field: string, value: string): void {
            this.terms.push(`${field}=${value}`)
        }
        addEncodedQuery(query: string): void {
            this.terms.push(...query.split('^'))
        }
        orderBy(field: string): void {
            this.order = field
        }
        query(): void {
            this.found = platform.rows
                .filter((row) => (this.table === PARENT || row.sys_class_name === this.table) && this.terms.every((term) => holds(row, term)))
                .sort((a, b) => valueOf(a, this.order).localeCompare(valueOf(b, this.order)))
            this.at = -1
        }
        next(): boolean {
            this.at++
            const row = this.found[this.at]
            if (row) this.row = { ...row }
            return row !== undefined
        }
        get(sysId: string): boolean {
            this.addQuery('sys_id', sysId)
            this.query()
            return this.next()
        }
        initialize(): void {
            this.row = { sys_class_name: this.table }
        }
        getValue(field: string): string | null {
            return this.row[field] || null
        }
        setValue(field: string, value: string | boolean): void {
            this.row[field] = String(value)
        }
        getUniqueValue(): string {
            return this.row.sys_id ?? ''
        }
        getLastErrorMessage(): string {
            return this.error
        }
        insert(): string | null {
            this.row.sys_id = `row${platform.rows.length + 1}`
            return this.save(() => platform.rows.push({ ...this.row }))
        }
        update(): string | null {
            return this.save(() => Object.assign(platform.rows.find((row) => row.sys_id === this.row.sys_id) ?? {}, this.row))
        }
        private save(store: () => void): string | null {
            this.error = refusal(this.row)
            if (this.error) return null
            this.row.sys_updated_on = String(platform.rows.length + platform.events.length).padStart(6, '0')
            platform.onSave(this.row)
            store()
            return this.row.sys_id ?? null
        }
    }
    const gs = {
        eventQueue: (name: string, record: GlideRecord, parm1: string) => platform.events.push({ name, row: record.getUniqueValue(), parm1 }),
    }
    return { GlideRecord, gs }
})

const MODEL = 'model1'

/** A row another source keeps: active, a manufacturer's milestone of ServiceNow's content service unless said otherwise. */
function stored(row: Row): void {
    const sysId = `row${platform.rows.length + 1}`
    platform.rows.push({
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
    platform.rows.filter((row) => row.model === modelId).map((row) => `${row.lifecycle_phase} ${row.start_date} ${row.source} ${row.description ?? ''}`.trim())

beforeEach(() => {
    platform.rows = []
    platform.pids = { [MODEL]: 'C9300-48P-E' }
    platform.events = []
    platform.refuses = () => ''
    platform.onSave = () => undefined
})

describe('writeModelLifecycle', () => {
    it('stores each milestone given on a row of its own: a hardware lifecycle row of the manufacturer, active, with its provenance', () => {
        const written = writeModelLifecycle(MODEL, { endOfSale: '2028-10-31', endOfSupport: '2033-10-31' }, { source: 'cisco', reference: 'https://example.test/eol.html' })
        expect(written).toEqual({ inserted: 2, updated: 0, unchanged: 0, refused: [] })
        expect(platform.rows).toEqual([
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

    it('queues the recomputation once for all the milestones it saves, and marks the Model while it saves them', () => {
        const marked: boolean[] = []
        platform.onSave = () => marked.push(writingModelLifecycle(MODEL))
        writeModelLifecycle(MODEL, { endOfSale: '2028-10-31', endOfSupport: '2033-10-31', endOfLife: '2035-10-31' }, { source: 'csv' })
        expect(marked).toEqual([true, true, true])
        expect(writingModelLifecycle(MODEL)).toBe(false)
        expect(platform.events).toEqual([{ name: EVENT.lifecycleChanged, row: expect.stringMatching(/^row/), parm1: MODEL }])
    })

    it('leaves a milestone stored as given alone, and queues nothing', () => {
        writeModelLifecycle(MODEL, { endOfSale: '2028-10-31' }, { source: 'csv', reference: 'EOL-1' })
        platform.events = []
        const saves: Row[] = []
        platform.onSave = (row) => saves.push(row)
        expect(writeModelLifecycle(MODEL, { endOfSale: '2028-10-31' }, { source: 'csv', reference: 'EOL-1' })).toEqual({ inserted: 0, updated: 0, unchanged: 1, refused: [] })
        expect(saves).toEqual([])
        expect(platform.events).toEqual([])
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
        expect(platform.events).toHaveLength(1)
    })

    it('records a new provenance of an unchanged date without queueing the recomputation', () => {
        writeModelLifecycle(MODEL, { endOfSale: '2028-10-31' }, { source: 'csv', reference: 'EOL-1' })
        platform.events = []
        expect(writeModelLifecycle(MODEL, { endOfSale: '2028-10-31' }, { source: 'cisco' }).updated).toBe(1)
        expect(rowsOf(MODEL)).toEqual(['end_of_sale 2028-10-31 internal Cisco EoX API'])
        expect(platform.events).toEqual([])
    })

    it('updates the row kept by hand in the parent class rather than adding a second one the platform would refuse', () => {
        stored({ sys_class_name: 'cmdb_model_lifecycle', source: 'internal', lifecycle_phase: 'end_of_sale', start_date: '2028-01-01' })
        expect(writeModelLifecycle(MODEL, { endOfSale: '2028-10-31' }, { source: 'csv' })).toEqual({ inserted: 0, updated: 1, unchanged: 0, refused: [] })
        expect(rowsOf(MODEL)).toEqual(['end_of_sale 2028-10-31 internal CSV import'])
    })

    it('reports each milestone the platform refuses with its reason, and saves the others', () => {
        platform.refuses = (row) => (row.lifecycle_phase === 'end_of_support' ? 'aborted by a rule' : '')
        const written = writeModelLifecycle(MODEL, { endOfSale: '2028-10-31', endOfSupport: '2033-10-31' }, { source: 'csv' })
        expect(written).toEqual({ inserted: 1, updated: 0, unchanged: 0, refused: ['end of support: aborted by a rule'] })
        expect(rowsOf(MODEL)).toEqual(['end_of_sale 2028-10-31 internal CSV import'])
        expect(platform.events).toHaveLength(1)
    })

    it('writes nothing for a source that gives no milestone', () => {
        expect(writeModelLifecycle(MODEL, {}, { source: 'csv' })).toEqual({ inserted: 0, updated: 0, unchanged: 0, refused: [] })
        expect(platform.rows).toEqual([])
        expect(platform.events).toEqual([])
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
        platform.pids = { [MODEL]: 'C9300-48P-E', model2: 'FG-60F', laptop: '' }
        stored({ lifecycle_phase: 'end_of_sale', start_date: '2026-11-09' })
        stored({ lifecycle_phase: 'end_of_support', start_date: '2026-11-09', source: 'internal' })
        stored({ lifecycle_phase: 'end_of_life', start_date: '2026-11-09', model: 'model2', source: 'internal' })
        stored({ lifecycle_phase: 'end_of_sale', start_date: '2026-11-10', model: 'model2', source: 'internal' })
        stored({ lifecycle_phase: 'end_of_sale', start_date: '2026-11-09', model: 'laptop', source: 'internal' })
        stored({ lifecycle_phase: 'end_of_sale', start_date: '2026-11-09', model: 'model3', active: 'false' })
        queueModelsReachingMilestone('2026-11-09')
        expect(platform.events.map((event) => event.parm1).sort()).toEqual([MODEL, 'model2'])
        expect(platform.events.every((event) => event.name === EVENT.lifecycleChanged)).toBe(true)
    })
})
