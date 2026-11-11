import { beforeEach, describe, expect, it, vi } from 'vitest'
import { inCurrentPass, queuePass, runEventTableJob, runSupersedingChunk, runTableJob, runTriggeredChunk, visitInKeyOrder } from './chunked.ts'
import type { JobEvent } from './events.ts'
import { completePass, findJobCursor, isCurrentPass, JOB_STATUS, openJobCursor, retirePass, startPass } from './job-cursor.ts'
import { withLock } from './locks.ts'
import { platform, type Row } from '../test-support/fake-glide.ts'

/*
 * The job-cursor repository and the event runner run against the in-memory stand-in for the platform, with the unique
 * indexes the two job tables have (job cursor by job, job lock by name), an event queue and a clock.
 */

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

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
function job<P extends object = object>(pass: P = {} as P, failOn: string[] = []) {
    const handled: string[] = []
    const flushed: Array<{ failed: number }> = []
    const spec = {
        ...pass,
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
    const pass = {
        job: jobName,
        onStart: () => {
            calls.push('start')
            onStart()
        },
        complete: () => void calls.push('complete'),
        stopped: (error: string) => void calls.push(`stopped: ${error}`),
    }
    return { pass, calls }
}

beforeEach(() => {
    platform.reset()
    platform.uniqueKeys = { [CURSORS]: 'job', [LOCKS]: 'name' }
    platform.properties = { 'x_daas_ham.job.batch_size': '2', 'x_daas_ham.job.budget_seconds': '120' }
    platform.clock = 1762689600000
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
        expect(isCurrentPass('job1', 'some-pass')).toBe(false)
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

    it('logs a completion the platform refuses instead of throwing: the pass itself is complete', () => {
        const token = startPass('job1', JOB_STATUS.running)
        platform.refuses = () => 'read only'
        expect(() => completePass('job1')).not.toThrow()
        expect(cursorRow('job1')).toMatchObject({ cursor: token, last_status: 'running' })
        expect(platform.logs).toEqual(['warn [x_daas_ham] job1: the pass completed, but its job cursor still reads running (as if stalled): read only'])
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

    it("counts a run's failed records on the cursor and logs them, and does not read complete", () => {
        items('a', 'b', 'c')
        const { spec, handled } = job(undefined, ['b'])
        expect(runTableJob({ ...spec, job: 'scan' })).toMatchObject({ processed: 2, failed: 1, done: true })
        expect(handled).toEqual(['a', 'c'])
        expect(cursorRow('scan')).toMatchObject({ last_status: 'complete with 1 failed record(s)', processed_total: '2', failed_total: '1', last_error: 'b: boom b' })
        expect(openJobCursor('scan').cursor).toBe('')
        expect(platform.logs).toEqual(['error [x_daas_ham] scan: in this run: 1 record(s) failed, the last: b: boom b'])
    })

    it("keeps a pass's failures over its runs, and drops them once a run starts a fresh pass", () => {
        items('a', 'b', 'c')
        platform.properties['x_daas_ham.job.budget_seconds'] = '0'
        runTableJob({ ...job(undefined, ['a']).spec, job: 'scan' })
        expect(cursorRow('scan')).toMatchObject({ cursor: 'a', last_status: 'paused (time budget), 1 failed record(s) so far', failed_total: '1', last_error: 'a: boom a' })

        platform.properties['x_daas_ham.job.budget_seconds'] = '120'
        runTableJob({ ...job().spec, job: 'scan' })
        expect(cursorRow('scan')).toMatchObject({ cursor: '', last_status: 'complete with 1 failed record(s)', failed_total: '1', last_error: 'a: boom a' })

        runTableJob({ ...job().spec, job: 'scan' })
        expect(cursorRow('scan')).toMatchObject({ cursor: '', last_status: 'complete', failed_total: '0', last_error: '' })
        expect(platform.logs).toEqual(['error [x_daas_ham] scan: in this run: 1 record(s) failed, the last: a: boom a'])
    })

    it('does not run without a cursor row, and says why', () => {
        items('a')
        platform.refuses = (table) => (table === CURSORS ? 'no rights' : '')
        const { spec, handled } = job()
        expect(runTableJob({ ...spec, job: 'scan' })).toMatchObject({ processed: 0, done: false, lastError: 'job cursor scan could not be created: no rights' })
        expect(handled).toEqual([])
        // One error in the log, naming the job and why it did not run.
        expect(platform.logs).toEqual([expect.stringMatching(/^error .*\bscan\b.*no rights/)])
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

    it("logs a chunk's failed records, and hands them to its flush", () => {
        items('a', 'b')
        const run = job(undefined, ['b'])
        expect(runEventTableJob(queued(''), run.spec)).toMatchObject({ processed: 1, failed: 1, done: true })
        expect(run.flushed).toEqual([{ failed: 1 }])
        expect(platform.logs).toEqual([`error [x_daas_ham] ${EVENT_NAME} ${SUBJECT}: in this chunk: 1 record(s) failed, the last: b: boom b`])
    })

    it('runs nothing for an event that names no subject', () => {
        items('a')
        const run = job()
        expect(runEventTableJob({ ...queued(''), subject: '' }, run.spec)).toMatchObject({ processed: 0, done: false })
        expect(run.handled).toEqual([])
        expect(run.flushed).toEqual([])
        expect(platform.events).toEqual([])
    })
})

describe('an event job whose passes are started where they are triggered', () => {
    const PASS = { job: 'generate_p1' }

    function oneChunk(position: string, failOn: string[] = []) {
        platform.properties['x_daas_ham.job.budget_seconds'] = '0'
        const run = job(PASS, failOn)
        return { ...run, result: runTriggeredChunk(queued(position), run.spec) }
    }

    /** Queue a pass and give its token: the job's cursor row holds the current pass's. */
    function queueNewPass(): string {
        queuePass(EVENT_NAME, record, SUBJECT, PASS.job)
        return cursorRow(PASS.job)?.cursor ?? ''
    }

    it('queues the first chunk with the new pass and no cursor', () => {
        const token = queueNewPass()
        expect(token).not.toBe('')
        expect(cursorRow(PASS.job)).toMatchObject({ last_status: 'pass started' })
        expect(platform.events).toEqual([{ name: EVENT_NAME, record: 'rec1', parm1: SUBJECT, parm2: `${token}:`, delayed: false }])
        expect(inCurrentPass(queued(`${token}:`), PASS.job)).toBe(true)
    })

    it('queues nothing for a pass that cannot be recorded', () => {
        platform.refuses = () => 'no rights'
        expect(() => queuePass(EVENT_NAME, record, SUBJECT, PASS.job)).toThrow('job cursor generate_p1 could not be created: no rights')
        expect(platform.events).toEqual([])
    })

    it('flushes each chunk and queues the next with the pass and where it got to, taking no lock', () => {
        items('a', 'b')
        const token = queueNewPass()
        const first = oneChunk(platform.events[0]?.parm2 ?? '')
        expect(first.handled).toEqual(['a'])
        expect(first.flushed).toEqual([{ failed: 0 }])
        expect(first.result).toMatchObject({ done: false, superseded: false })
        expect(platform.events[1]).toMatchObject({ parm1: SUBJECT, parm2: `${token}:a` })

        platform.properties['x_daas_ham.job.budget_seconds'] = '120'
        const last = job(PASS)
        expect(runTriggeredChunk(queued(platform.events[1]?.parm2 ?? ''), last.spec)).toMatchObject({ done: true, superseded: false })
        expect(last.handled).toEqual(['b'])
        expect(platform.events).toHaveLength(2)
        // Nothing marks the row as the pass ends: the caller completes it.
        expect(cursorRow(PASS.job)).toMatchObject({ last_status: 'pass started' })
        expect(platform.tables[LOCKS]).toBeUndefined()
    })

    it('drops a chunk of a pass replaced since: nothing handled, flushed or queued', () => {
        items('a', 'b')
        const replaced = queueNewPass()
        platform.clock += 1000
        const current = queueNewPass()
        const stale = oneChunk(`${replaced}:`)
        expect(stale.result).toMatchObject({ superseded: true, done: false, processed: 0 })
        expect(stale.handled).toEqual([])
        expect(stale.flushed).toEqual([])
        expect(platform.events).toHaveLength(2)
        expect(inCurrentPass(queued(`${replaced}:`), PASS.job)).toBe(false)
        expect(inCurrentPass(queued(`${current}:`), PASS.job)).toBe(true)
    })

    it('neither flushes nor queues for a pass retired while its chunk ran', () => {
        items('a', 'b')
        const token = queueNewPass()
        const run = job(PASS)
        const retiring = {
            ...run.spec,
            handle: (name: string) => {
                run.spec.handle(name)
                const row = findJobCursor(PASS.job)
                if (row) retirePass(row)
            },
        }
        expect(runTriggeredChunk(queued(`${token}:`), retiring)).toMatchObject({ superseded: true, done: false })
        expect(run.flushed).toEqual([])
        expect(platform.events).toHaveLength(1)
    })

    it.each(['', 'a', ':a'])('drops an event that names no pass (parm2 %j) instead of starting one', (position) => {
        items('a')
        const token = queueNewPass()
        const run = oneChunk(position)
        expect(run.result.superseded).toBe(true)
        expect(run.handled).toEqual([])
        expect(cursorRow(PASS.job)?.cursor).toBe(token)
    })

    it('lets what a flush throws escape, with the pass still current', () => {
        items('a')
        const token = queueNewPass()
        const run = job(PASS)
        const failing = { ...run.spec, flush: () => { throw new Error('count refused') } }
        expect(() => runTriggeredChunk(queued(`${token}:`), failing)).toThrow('count refused')
        expect(inCurrentPass(queued(`${token}:`), PASS.job)).toBe(true)
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
        expect(runSupersedingChunk(queued(''), run.spec)).toMatchObject({ done: false, superseded: false })
        expect(calls).toEqual(['start'])
        expect(run.handled).toEqual(['a'])
        expect(run.flushed).toEqual([{ failed: 0 }])
        const token = cursorRow(JOB)?.cursor ?? ''
        expect(isCurrentPass(JOB, token)).toBe(true)
        expect(cursorRow(JOB)).toMatchObject({ last_status: 'running' })
        expect(platform.events).toEqual([{ name: EVENT_NAME, record: 'rec1', parm1: SUBJECT, parm2: `${token}:a`, delayed: false }])
        expect(platform.tables[LOCKS]).toEqual([])
    })

    it('completes the pass after its last chunk and marks it complete', () => {
        items('a', 'b')
        const token = startPass(JOB, JOB_STATUS.running)
        const { pass, calls } = lockedPass(JOB)
        const run = job(pass)
        expect(runSupersedingChunk(queued(`${token}:a`), run.spec)).toMatchObject({ done: true, superseded: false })
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
        expect(runSupersedingChunk(queued(`${stale}:`), run.spec)).toMatchObject({ superseded: true, done: false })
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
        expect(runSupersedingChunk(queued(`${token}:`), superseded)).toMatchObject({ superseded: true })
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
        expect(runSupersedingChunk(queued(`${token}:a`), run.spec)).toMatchObject({ done: false, superseded: false, lastError: 'job locked: retried later' })
        expect(run.handled).toEqual([])
        expect(platform.events).toEqual([{ name: EVENT_NAME, record: 'rec1', parm1: SUBJECT, parm2: `${token}:a`, delayed: true }])
    })

    it('runs a chunk past an abandoned lock, clearing it as it writes', () => {
        items('a', 'b')
        const token = startPass(JOB, JOB_STATUS.running)
        platform.tables[LOCKS] = [{ sys_id: 'dead', name: JOB, sys_created_on: '2025-11-09 10:00:00' }]
        const { pass, calls } = lockedPass(JOB)
        const run = job(pass)
        expect(runSupersedingChunk(queued(`${token}:`), run.spec)).toMatchObject({ done: true, superseded: false, lastError: '' })
        expect(run.handled).toEqual(['a', 'b'])
        expect(calls).toEqual(['complete'])
        expect(platform.tables[LOCKS]).toEqual([])
    })

    it('asks again for a fresh pass when a start finds the lock held', () => {
        items('a')
        platform.tables[LOCKS] = [{ sys_id: 'held', name: JOB, sys_created_on: '2025-11-09 11:59:00' }]
        const { pass, calls } = lockedPass(JOB)
        runSupersedingChunk(queued(''), job(pass).spec)
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
        expect(() => runSupersedingChunk(queued(`${token}:`), failing)).toThrow('cost fact refused')
        expect(calls).toEqual(['stopped: cost fact refused'])
        expect(platform.events).toEqual([])
        expect(platform.tables[LOCKS]).toEqual([])
    })

    it('does not start a pass whose token is refused, and clears nothing for it', () => {
        items('a')
        platform.refuses = (table) => (table === CURSORS ? 'no rights' : '')
        const { pass, calls } = lockedPass(JOB)
        const run = job(pass)
        expect(() => runSupersedingChunk(queued(''), run.spec)).toThrow('job cursor margin_p1 could not be created: no rights')
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
        expect(runSupersedingChunk(queued(`${token}:`), overrun)).toMatchObject({ done: false, lastError: 'job lock lost: pass restarted' })
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

describe('a job lock the platform refuses to delete', () => {
    it('is logged when it is released: it stays held until it is taken as abandoned', () => {
        platform.refuses = (table, _row, operation) => (table === LOCKS && operation === 'delete' ? 'no rights' : '')
        expect(withLock('lock1', () => 'done')).toEqual({ ran: true, value: 'done' })
        expect(platform.tables[LOCKS]).toHaveLength(1)
        expect(platform.logs).toEqual([
            'warn [x_daas_ham] Job lock lock1 not released: no rights; held until taken as abandoned, 10 minutes after it was taken',
        ])
    })
})
