import { beforeEach, describe, expect, it, vi } from 'vitest'
import { inCurrentPass, queuePass, runEventTableJob, runTableJob, visitInKeyOrder, type PassJob } from './chunked.ts'
import type { JobEvent } from './events.ts'
import { completePass, findJobCursor, isCurrentPass, JOB_STATUS, openJobCursor, retirePass, startPass } from './job-cursor.ts'

/*
 * The job-cursor repository and the event runner run against an in-memory stand-in for the platform: tables with the
 * unique indexes the two job tables have (job cursor by job, job lock by name), an event queue and a clock.
 */

type Row = Record<string, string>

const platform = vi.hoisted(() => ({
    tables: {} as Record<string, Array<Record<string, string>>>,
    events: [] as Array<{ name: string; record: string; parm1: string; parm2: string; delayed: boolean }>,
    logs: [] as string[],
    properties: {} as Record<string, string>,
    clock: 1762689600000,
    /** Why an insert or update of a row is refused, beyond the unique indexes ('' lets it through). */
    refuses: (() => '') as (table: string, row: Record<string, string>) => string,
    ids: 0,
}))

vi.mock('@servicenow/glide', () => {
    const UNIQUE: Record<string, string> = { x_daas_ham_job_cursor: 'job', x_daas_ham_job_lock: 'name' }
    const rowsOf = (table: string): Row[] => (platform.tables[table] ??= [])
    const holds = (row: Row, term: string): boolean => {
        const after = /^(\w+)>(.*)$/.exec(term)
        if (after) return (row[after[1] ?? ''] ?? '') > (after[2] ?? '')
        const before = /^(\w+)<(.*)$/.exec(term)
        if (before) return (row[before[1] ?? ''] ?? '') < (before[2] ?? '')
        const [field, value] = term.split('=')
        return (row[field ?? ''] ?? '') === value
    }
    const stamp = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
    class GlideRecord {
        private terms: string[] = []
        private order = ''
        private limit = Infinity
        private found: Row[] = []
        private at = -1
        private row: Row = {}
        private error = ''
        constructor(private readonly table: string) {}
        addQuery(field: string, operatorOrValue: string, value?: string): void {
            this.terms.push(value === undefined ? `${field}=${operatorOrValue}` : `${field}${operatorOrValue}${value}`)
        }
        addEncodedQuery(query: string): void {
            this.terms.push(...query.split('^').filter(Boolean))
        }
        orderBy(field: string): void {
            this.order = field
        }
        setLimit(limit: number): void {
            this.limit = limit
        }
        setWorkflow(): void {}
        query(): void {
            this.found = rowsOf(this.table)
                .filter((row) => this.terms.every((term) => holds(row, term)))
                .sort((a, b) => (a[this.order] ?? '').localeCompare(b[this.order] ?? ''))
                .slice(0, this.limit)
            this.at = -1
        }
        hasNext(): boolean {
            return this.at + 1 < this.found.length
        }
        next(): boolean {
            this.at++
            const row = this.found[this.at]
            if (row) this.row = { ...row }
            return row !== undefined
        }
        get(fieldOrId: string, value?: string): boolean {
            this.terms = [value === undefined ? `sys_id=${fieldOrId}` : `${fieldOrId}=${value}`]
            this.query()
            return this.next()
        }
        initialize(): void {
            this.row = {}
        }
        getValue(field: string): string | null {
            return this.row[field] || null
        }
        setValue(field: string, value: string | number): void {
            this.row[field] = String(value)
        }
        getUniqueValue(): string {
            return this.row.sys_id ?? ''
        }
        getLastErrorMessage(): string {
            return this.error
        }
        insert(): string | null {
            const rows = rowsOf(this.table)
            const key = UNIQUE[this.table]
            this.error = key && rows.some((row) => row[key] === this.row[key]) ? 'Unique Key violation detected by database' : platform.refuses(this.table, this.row)
            if (this.error) return null
            this.row.sys_id = `id${String(++platform.ids).padStart(4, '0')}`
            this.row.sys_created_on = stamp(platform.clock)
            rows.push({ ...this.row })
            return this.row.sys_id
        }
        update(): string | null {
            this.error = platform.refuses(this.table, this.row)
            if (this.error) return null
            Object.assign(rowsOf(this.table).find((row) => row.sys_id === this.row.sys_id) ?? {}, this.row)
            return this.row.sys_id ?? null
        }
        deleteRecord(): void {
            platform.tables[this.table] = rowsOf(this.table).filter((row) => row.sys_id !== this.row.sys_id)
        }
        deleteMultiple(): void {
            platform.tables[this.table] = rowsOf(this.table).filter((row) => !this.terms.every((term) => holds(row, term)))
        }
    }
    class GlideDateTime {
        private ms = platform.clock
        getNumericValue(): number {
            return this.ms
        }
        addSeconds(seconds: number): void {
            this.ms += seconds * 1000
        }
        getValue(): string {
            return stamp(this.ms)
        }
    }
    class GlideAggregate {}
    const queue = (delayed: boolean) => (name: string, record: GlideRecord, parm1: string, parm2: string) =>
        platform.events.push({ name, record: record.getUniqueValue(), parm1, parm2, delayed })
    const gs = {
        eventQueue: queue(false),
        eventQueueScheduled: queue(true),
        warn: (message: string) => platform.logs.push(`warn ${message}`),
        error: (message: string) => platform.logs.push(`error ${message}`),
        getProperty: (name: string, fallback: string) => platform.properties[name] ?? fallback,
    }
    return { GlideRecord, GlideDateTime, GlideAggregate, gs }
})

const CURSORS = 'x_daas_ham_job_cursor'
const LOCKS = 'x_daas_ham_job_lock'
const ITEMS = 'items'
const EVENT_NAME = 'x_daas_ham.test.job'
const SUBJECT = 'subject1'

const cursorRow = (job: string): Row | undefined => (platform.tables[CURSORS] ?? []).find((row) => row.job === job)

/** Items a, b, c… with sys_ids in that order. */
function items(...names: string[]): void {
    platform.tables[ITEMS] = names.map((name) => ({ sys_id: name, name }))
}

/** The record an event is queued on: only its sys_id matters here. */
const record = { getUniqueValue: () => 'rec1' } as unknown as JobEvent['record']

function queued(position: string): JobEvent {
    return { name: EVENT_NAME, record, subject: SUBJECT, position }
}

/** A job over the items that notes what it handled and flushed, and the hooks called under its lock. */
function job(pass?: PassJob, failOn: string[] = []) {
    const handled: string[] = []
    const flushed: Array<{ failed: number }> = []
    const spec = {
        pass,
        table: ITEMS,
        query: '',
        read: (item: JobEvent['record']) => String(item.getValue('name')),
        handle: (name: string) => {
            if (failOn.includes(name)) throw new Error(`boom ${name}`)
            handled.push(name)
        },
        flush: (failures: { failed: number }) => void flushed.push({ failed: failures.failed }),
    }
    return { spec, handled, flushed }
}

function lockedPass(jobName: string, onStart: () => void = () => undefined) {
    const calls: string[] = []
    const pass: PassJob = {
        job: jobName,
        underLock: {
            onStart: () => {
                calls.push('start')
                onStart()
            },
            complete: () => void calls.push('complete'),
            stopped: (error) => void calls.push(`stopped: ${error}`),
        },
    }
    return { pass, calls }
}

beforeEach(() => {
    platform.tables = {}
    platform.events = []
    platform.logs = []
    platform.properties = { 'x_daas_ham.job.batch_size': '2', 'x_daas_ham.job.budget_seconds': '120' }
    platform.clock = 1762689600000
    platform.refuses = () => ''
    platform.ids = 0
})

describe('the job cursor repository', () => {
    it('creates a job row on first use and finds it from then on', () => {
        expect(findJobCursor('job1')).toBeNull()
        expect(openJobCursor('job1').cursor).toBe('')
        expect(openJobCursor('job1').save({ cursor: 'k1', status: JOB_STATUS.paused, processed: 3, ranNow: true })).toBeNull()
        expect(platform.tables[CURSORS]).toEqual([
            expect.objectContaining({ job: 'job1', cursor: 'k1', last_status: 'paused (time budget)', processed_total: '3', last_run: '2025-11-09 12:00:00' }),
        ])
        expect(findJobCursor('job1')).toMatchObject({ cursor: 'k1', lastRun: '2025-11-09 12:00:00' })
    })

    it('goes on from the row another run inserted first', () => {
        // The other run's insert lands between this run's read and its own insert.
        platform.refuses = (table, row) => {
            if (table !== CURSORS || cursorRow(row.job ?? '')) return ''
            platform.tables[CURSORS] = [{ sys_id: 'theirs', job: row.job ?? '', cursor: 'k9' }]
            return 'Unique Key violation detected by database'
        }
        expect(openJobCursor('job1').cursor).toBe('k9')
        expect(platform.tables[CURSORS]).toHaveLength(1)
    })

    it('says why when a row can be neither created nor found', () => {
        platform.refuses = () => 'no rights'
        expect(() => openJobCursor('job1')).toThrow('job cursor job1 could not be created: no rights')
    })

    it('leaves what a save does not name as it is', () => {
        openJobCursor('job1').save({ cursor: '41', status: 'x', ranNow: true })
        platform.clock += 60000
        expect(openJobCursor('job1').save({ cursor: '42' })).toBeNull()
        expect(cursorRow('job1')).toMatchObject({ cursor: '42', last_status: 'x', last_run: '2025-11-09 12:00:00' })
    })

    it('reports a refused save with why', () => {
        const row = openJobCursor('job1')
        platform.refuses = () => 'read only'
        expect(row.save({ cursor: 'k1' })).toBe('read only')
    })
})

describe('passes on a job cursor', () => {
    it('makes each new pass the current one, and the one before it stale', () => {
        const first = startPass('job1', JOB_STATUS.running)
        expect(cursorRow('job1')).toMatchObject({ cursor: first, last_status: 'running', last_run: '2025-11-09 12:00:00' })
        expect(isCurrentPass('job1', first)).toBe(true)
        platform.clock += 1000
        const second = startPass('job1', JOB_STATUS.passStarted)
        expect(second).not.toBe(first)
        expect(isCurrentPass('job1', first)).toBe(false)
        expect(isCurrentPass('job1', second)).toBe(true)
        expect(cursorRow('job1')).toMatchObject({ last_status: 'pass started' })
    })

    it('has no current pass for a job without a row, or for an event that names none', () => {
        expect(isCurrentPass('job1', '1762689600000')).toBe(false)
        startPass('job1', JOB_STATUS.running)
        expect(isCurrentPass('job1', '')).toBe(false)
    })

    it('does not start a pass whose token is refused', () => {
        openJobCursor('job1')
        platform.refuses = () => 'read only'
        expect(() => startPass('job1', JOB_STATUS.running)).toThrow('job cursor job1 not saved: read only')
    })

    it('retires a pass by hand without touching its last run', () => {
        const token = startPass('job1', JOB_STATUS.passStarted)
        platform.clock += 60000
        const row = findJobCursor('job1')
        expect(row && retirePass(row)).toBeNull()
        expect(isCurrentPass('job1', token)).toBe(false)
        expect(cursorRow('job1')).toMatchObject({ cursor: '', last_status: 'reset by hand', last_run: '2025-11-09 12:00:00' })
    })

    it('marks a pass complete, keeping its token', () => {
        const token = startPass('job1', JOB_STATUS.running)
        platform.clock += 60000
        completePass('job1')
        expect(cursorRow('job1')).toMatchObject({ cursor: token, last_status: 'complete', last_run: '2025-11-09 12:01:00' })
    })
})

describe('runTableJob', () => {
    it('resumes after the stored cursor and resets it at the end of the pass', () => {
        items('a', 'b', 'c')
        openJobCursor('scan').save({ cursor: 'a' })
        const { spec, handled } = job()
        expect(runTableJob({ ...spec, job: 'scan' })).toMatchObject({ processed: 2, done: true })
        expect(handled).toEqual(['b', 'c'])
        expect(cursorRow('scan')).toMatchObject({ cursor: '', last_status: 'complete', processed_total: '2' })
    })

    it('pauses on its time budget and keeps where it stopped', () => {
        items('a', 'b', 'c')
        platform.properties['x_daas_ham.job.budget_seconds'] = '0'
        const { spec, handled } = job()
        runTableJob({ ...spec, job: 'scan' })
        expect(handled).toEqual(['a'])
        expect(cursorRow('scan')).toMatchObject({ cursor: 'a', last_status: 'paused (time budget)', processed_total: '1' })
    })

    it('does not run without a cursor row, and says why', () => {
        items('a')
        platform.refuses = (table) => (table === CURSORS ? 'no rights' : '')
        const { spec, handled } = job()
        expect(runTableJob({ ...spec, job: 'scan' })).toMatchObject({ processed: 0, done: false, lastError: 'job cursor scan could not be created: no rights' })
        expect(handled).toEqual([])
        expect(platform.logs).toEqual(['error [x_daas_ham] scan: not run: job cursor scan could not be created: no rights'])
    })
})

describe('an event job', () => {
    it("carries its cursor in parm2 and queues its event again on the subject until the pass is done", () => {
        items('a', 'b', 'c')
        platform.properties['x_daas_ham.job.budget_seconds'] = '0'
        const first = job()
        expect(runEventTableJob(queued(''), first.spec)).toMatchObject({ done: false, superseded: false })
        expect(first.handled).toEqual(['a'])
        expect(platform.events).toEqual([{ name: EVENT_NAME, record: 'rec1', parm1: SUBJECT, parm2: 'a', delayed: false }])

        platform.properties['x_daas_ham.job.budget_seconds'] = '120'
        const second = job()
        expect(runEventTableJob(queued('a'), second.spec)).toMatchObject({ done: true })
        expect(second.handled).toEqual(['b', 'c'])
        expect(platform.events).toHaveLength(1)
        expect(platform.tables[CURSORS]).toBeUndefined()
    })
})

describe('an event job whose passes are started where they are triggered', () => {
    const PASS: PassJob = { job: 'generate_p1' }

    function oneChunk(position: string, failOn: string[] = []) {
        platform.properties['x_daas_ham.job.budget_seconds'] = '0'
        const run = job(PASS, failOn)
        return { ...run, result: runEventTableJob(queued(position), run.spec) }
    }

    it('queues the first chunk with the new pass and no cursor', () => {
        queuePass(EVENT_NAME, record, SUBJECT, PASS.job)
        const token = cursorRow(PASS.job)?.cursor
        expect(token).toBe('1762689600000')
        expect(cursorRow(PASS.job)).toMatchObject({ last_status: 'pass started' })
        expect(platform.events).toEqual([{ name: EVENT_NAME, record: 'rec1', parm1: SUBJECT, parm2: '1762689600000:', delayed: false }])
    })

    it('queues nothing for a pass that cannot be recorded', () => {
        platform.refuses = () => 'no rights'
        expect(() => queuePass(EVENT_NAME, record, SUBJECT, PASS.job)).toThrow('job cursor generate_p1 could not be created: no rights')
        expect(platform.events).toEqual([])
    })

    it('flushes each chunk and queues the next with the pass and where it got to, taking no lock', () => {
        items('a', 'b')
        queuePass(EVENT_NAME, record, SUBJECT, PASS.job)
        const first = oneChunk(platform.events[0]?.parm2 ?? '')
        expect(first.handled).toEqual(['a'])
        expect(first.flushed).toEqual([{ failed: 0 }])
        expect(first.result).toMatchObject({ done: false, superseded: false })
        expect(platform.events[1]).toMatchObject({ parm1: SUBJECT, parm2: '1762689600000:a' })

        platform.properties['x_daas_ham.job.budget_seconds'] = '120'
        const last = job(PASS)
        expect(runEventTableJob(queued('1762689600000:a'), last.spec)).toMatchObject({ done: true, superseded: false })
        expect(last.handled).toEqual(['b'])
        expect(platform.events).toHaveLength(2)
        // Nothing marks the row as the pass ends: the caller completes it.
        expect(cursorRow(PASS.job)).toMatchObject({ last_status: 'pass started' })
        expect(platform.tables[LOCKS]).toBeUndefined()
    })

    it('drops a chunk of a pass replaced since: nothing handled, flushed or queued', () => {
        items('a', 'b')
        queuePass(EVENT_NAME, record, SUBJECT, PASS.job)
        platform.clock += 1000
        queuePass(EVENT_NAME, record, SUBJECT, PASS.job)
        const stale = oneChunk('1762689600000:')
        expect(stale.result).toMatchObject({ superseded: true, done: false, processed: 0 })
        expect(stale.handled).toEqual([])
        expect(stale.flushed).toEqual([])
        expect(platform.events).toHaveLength(2)
        expect(inCurrentPass(queued('1762689600000:'), PASS.job)).toBe(false)
        expect(inCurrentPass(queued('1762689601000:'), PASS.job)).toBe(true)
    })

    it('neither flushes nor queues for a pass retired while its chunk ran', () => {
        items('a', 'b')
        queuePass(EVENT_NAME, record, SUBJECT, PASS.job)
        const run = job(PASS)
        const retiring = {
            ...run.spec,
            handle: (name: string) => {
                run.spec.handle(name)
                const row = findJobCursor(PASS.job)
                if (row) retirePass(row)
            },
        }
        expect(runEventTableJob(queued('1762689600000:'), retiring)).toMatchObject({ superseded: true, done: false })
        expect(run.flushed).toEqual([])
        expect(platform.events).toHaveLength(1)
    })

    it.each(['', 'a', ':a'])('drops an event that names no pass (parm2 %j) instead of starting one', (position) => {
        items('a')
        queuePass(EVENT_NAME, record, SUBJECT, PASS.job)
        const run = oneChunk(position)
        expect(run.result.superseded).toBe(true)
        expect(run.handled).toEqual([])
        expect(cursorRow(PASS.job)?.cursor).toBe('1762689600000')
    })

    it('lets what a flush throws escape, with the pass still current', () => {
        items('a')
        queuePass(EVENT_NAME, record, SUBJECT, PASS.job)
        const run = job(PASS)
        const failing = { ...run.spec, flush: () => { throw new Error('count refused') } }
        expect(() => runEventTableJob(queued('1762689600000:'), failing)).toThrow('count refused')
        expect(inCurrentPass(queued('1762689600000:'), PASS.job)).toBe(true)
        expect(platform.events).toHaveLength(1)
    })
})

describe('an event job whose passes supersede each other under its lock (ADR 0013)', () => {
    const JOB = 'margin_p1'

    it('starts a pass from an event that carries none, then queues the next chunk with its token', () => {
        items('a', 'b', 'c')
        platform.properties['x_daas_ham.job.budget_seconds'] = '0'
        const { pass, calls } = lockedPass(JOB, () => expect(platform.tables[LOCKS]).toEqual([expect.objectContaining({ name: JOB })]))
        const run = job(pass)
        expect(runEventTableJob(queued(''), run.spec)).toMatchObject({ done: false, superseded: false })
        expect(calls).toEqual(['start'])
        expect(run.handled).toEqual(['a'])
        expect(run.flushed).toEqual([{ failed: 0 }])
        expect(cursorRow(JOB)).toMatchObject({ cursor: '1762689600000', last_status: 'running' })
        expect(platform.events).toEqual([{ name: EVENT_NAME, record: 'rec1', parm1: SUBJECT, parm2: '1762689600000:a', delayed: false }])
        expect(platform.tables[LOCKS]).toEqual([])
    })

    it('completes the pass after its last chunk and marks it complete', () => {
        items('a', 'b')
        const token = startPass(JOB, JOB_STATUS.running)
        const { pass, calls } = lockedPass(JOB)
        const run = job(pass)
        expect(runEventTableJob(queued(`${token}:a`), run.spec)).toMatchObject({ done: true, superseded: false })
        expect(run.handled).toEqual(['b'])
        expect(calls).toEqual(['complete'])
        expect(cursorRow(JOB)).toMatchObject({ cursor: token, last_status: 'complete' })
        expect(platform.events).toEqual([])
    })

    it('writes nothing for a chunk of a pass a fresh one superseded', () => {
        items('a', 'b')
        const stale = startPass(JOB, JOB_STATUS.running)
        platform.clock += 1000
        startPass(JOB, JOB_STATUS.running)
        const { pass, calls } = lockedPass(JOB)
        const run = job(pass)
        expect(runEventTableJob(queued(`${stale}:`), run.spec)).toMatchObject({ superseded: true, done: false })
        expect(run.handled).toEqual([])
        expect(run.flushed).toEqual([])
        expect(calls).toEqual([])
        expect(platform.events).toEqual([])
    })

    it('neither flushes, queues nor completes for a pass superseded while its chunk ran', () => {
        items('a')
        const token = startPass(JOB, JOB_STATUS.running)
        const { pass, calls } = lockedPass(JOB)
        const run = job(pass)
        const superseded = {
            ...run.spec,
            handle: () => {
                platform.clock += 1000
                startPass(JOB, JOB_STATUS.running)
            },
        }
        expect(runEventTableJob(queued(`${token}:`), superseded)).toMatchObject({ superseded: true })
        expect(run.flushed).toEqual([])
        expect(calls).toEqual([])
        expect(platform.events).toEqual([])
    })

    it('runs a chunk that finds the lock held again later, from the same pass and cursor, having handled nothing', () => {
        items('a', 'b')
        const token = startPass(JOB, JOB_STATUS.running)
        platform.tables[LOCKS] = [{ sys_id: 'held', name: JOB, sys_created_on: '2025-11-09 11:59:00' }]
        const { pass } = lockedPass(JOB)
        const run = job(pass)
        expect(runEventTableJob(queued(`${token}:a`), run.spec)).toMatchObject({ done: false, superseded: false, lastError: 'job locked: retried later' })
        expect(run.handled).toEqual([])
        expect(platform.events).toEqual([{ name: EVENT_NAME, record: 'rec1', parm1: SUBJECT, parm2: `${token}:a`, delayed: true }])
    })

    it('asks again for a fresh pass when a start finds the lock held', () => {
        items('a')
        platform.tables[LOCKS] = [{ sys_id: 'held', name: JOB, sys_created_on: '2025-11-09 11:59:00' }]
        const { pass, calls } = lockedPass(JOB)
        runEventTableJob(queued(''), job(pass).spec)
        expect(calls).toEqual([])
        expect(findJobCursor(JOB)).toBeNull()
        expect(platform.events).toEqual([{ name: EVENT_NAME, record: 'rec1', parm1: SUBJECT, parm2: '', delayed: true }])
    })

    it('tells a current pass that a chunk of it threw, under the lock, and throws on', () => {
        items('a')
        const token = startPass(JOB, JOB_STATUS.running)
        const { pass, calls } = lockedPass(JOB)
        const run = job(pass)
        const failing = { ...run.spec, flush: () => { throw new Error('cost fact refused') } }
        expect(() => runEventTableJob(queued(`${token}:`), failing)).toThrow('cost fact refused')
        expect(calls).toEqual(['stopped: cost fact refused'])
        expect(platform.events).toEqual([])
        expect(platform.tables[LOCKS]).toEqual([])
    })

    it('does not start a pass whose token is refused, and clears nothing for it', () => {
        items('a')
        platform.refuses = (table) => (table === CURSORS ? 'no rights' : '')
        const { pass, calls } = lockedPass(JOB)
        const run = job(pass)
        expect(() => runEventTableJob(queued(''), run.spec)).toThrow('job cursor margin_p1 could not be created: no rights')
        expect(calls).toEqual([])
        expect(run.handled).toEqual([])
    })

    it('starts a fresh pass at once when a flush lost the lock', () => {
        items('a')
        const token = startPass(JOB, JOB_STATUS.running)
        const { pass, calls } = lockedPass(JOB)
        const run = job(pass)
        // A taker that judged the lock abandoned clears it while the flush runs.
        const overrun = { ...run.spec, flush: () => void (platform.tables[LOCKS] = []) }
        expect(runEventTableJob(queued(`${token}:`), overrun)).toMatchObject({ done: false, lastError: 'job lock lost: pass restarted' })
        expect(calls).toEqual([])
        expect(platform.events).toEqual([{ name: EVENT_NAME, record: 'rec1', parm1: SUBJECT, parm2: '', delayed: false }])
    })
})

describe('visitInKeyOrder', () => {
    it('visits every matching record once, a batch at a time, in sys_id order', () => {
        items('c', 'a', 'e', 'b', 'd')
        const seen: string[] = []
        visitInKeyOrder(ITEMS, '', (item) => void seen.push(item.getUniqueValue()))
        expect(seen).toEqual(['a', 'b', 'c', 'd', 'e'])
    })

    it('ends when visiting takes a record out of the query, or leaves it in', () => {
        platform.tables[ITEMS] = ['a', 'b', 'c', 'd'].map((name) => ({ sys_id: name, state: 'open' }))
        const seen: string[] = []
        visitInKeyOrder(ITEMS, 'state=open', (item) => {
            seen.push(item.getUniqueValue())
            if (item.getUniqueValue() === 'c') return
            item.setValue('state', 'done')
            item.update()
        })
        expect(seen).toEqual(['a', 'b', 'c', 'd'])
    })
})
