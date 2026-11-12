import { describe, expect, it } from 'vitest'
import {
    cursorReport,
    isCurrentPass,
    JOB,
    lockLostIn,
    passParm,
    readPassParm,
    runChunked,
    usableBatchSize,
    writeChunkUnderLock,
    type ChunkedJobPorts,
    type LockedChunkPorts,
} from './chunked-job'

function fakePorts(keys: string[], opts: { cursor?: string; tickMs?: number; failOn?: string[] } = {}) {
    let clock = 0
    const handled: string[] = []
    const fetched: number[] = []
    const saved: Array<{ cursor: string; processed: number; done: boolean; failed?: number }> = []
    const ports: ChunkedJobPorts<string> = {
        loadCursor: () => opts.cursor ?? '',
        fetchBatch: (after, size) => {
            // A runner that never reaches the end fails here instead of hanging the test run.
            if (fetched.push(size) > 100) throw new Error('runaway')
            return keys.filter((k) => k > after).slice(0, size)
        },
        keyOf: (k) => k,
        handle: (k) => {
            clock += opts.tickMs ?? 1
            if (opts.failOn?.includes(k)) throw new Error(`boom ${k}`)
            handled.push(k)
        },
        saveCursor: (cursor, processed, done, failures) => saved.push({ cursor, processed, done, ...(failures.failed > 0 ? { failed: failures.failed } : {}) }),
        now: () => clock,
    }
    return { ports, handled, fetched, saved }
}

describe('runChunked', () => {
    it('processes every record in key order across batches and resets the cursor when done', () => {
        const { ports, handled, saved } = fakePorts(['a', 'b', 'c', 'd', 'e'])
        const result = runChunked(ports, { batchSize: 2, budgetMs: 1000 })
        expect(handled).toEqual(['a', 'b', 'c', 'd', 'e'])
        expect(result).toEqual({ processed: 5, failed: 0, done: true, cursor: '', lastError: '' })
        expect(saved.at(-1)).toEqual({ cursor: '', processed: 5, done: true })
    })

    it('stops when the time budget runs out and remembers where it stopped', () => {
        const { ports, handled } = fakePorts(['a', 'b', 'c', 'd'], { tickMs: 10 })
        const result = runChunked(ports, { batchSize: 10, budgetMs: 25 })
        expect(handled).toEqual(['a', 'b', 'c'])
        expect(result.done).toBe(false)
        expect(result.cursor).toBe('c')
    })

    it('resumes after the saved cursor', () => {
        const { ports, handled } = fakePorts(['a', 'b', 'c'], { cursor: 'a' })
        runChunked(ports, { batchSize: 10, budgetMs: 100 })
        expect(handled).toEqual(['b', 'c'])
    })

    it('keeps going past a failing record and reports it', () => {
        const { ports, handled } = fakePorts(['a', 'b', 'c'], { failOn: ['b'] })
        const result = runChunked(ports, { batchSize: 10, budgetMs: 100 })
        expect(handled).toEqual(['a', 'c'])
        expect(result.failed).toBe(1)
        expect(result.lastError).toBe('b: boom b')
    })

    it('moves on past a batch whose every record fails', () => {
        const { ports, handled, saved } = fakePorts(['a', 'b', 'c', 'd'], { failOn: ['a', 'b'] })
        const result = runChunked(ports, { batchSize: 2, budgetMs: 100 })
        expect(handled).toEqual(['c', 'd'])
        expect(result).toEqual({ processed: 2, failed: 2, done: true, cursor: '', lastError: 'b: boom b' })
        expect(saved).toEqual([{ cursor: '', processed: 2, done: true, failed: 2 }])
    })

    it('tells saveCursor how many records of the run failed and the last error', () => {
        const failures: Array<{ failed: number; lastError: string }> = []
        const { ports } = fakePorts(['a', 'b', 'c'], { failOn: ['a', 'c'] })
        runChunked({ ...ports, saveCursor: (_cursor, _processed, _done, f) => failures.push(f) }, { batchSize: 10, budgetMs: 100 })
        expect(failures).toEqual([{ failed: 2, lastError: 'c: boom c' }])
    })

    it.each([0, -5])('fetches one record at a time with a batch size of %i, and still gets to the end', (batchSize) => {
        const { ports, handled, fetched } = fakePorts(['a', 'b', 'c'])
        const result = runChunked(ports, { batchSize, budgetMs: 100 })
        expect(handled).toEqual(['a', 'b', 'c'])
        expect(result.done).toBe(true)
        expect(fetched).toEqual([1, 1, 1, 1])
    })

    it.each([0, -1000])('handles one record before pausing on a budget of %i ms', (budgetMs) => {
        const { ports, handled, saved } = fakePorts(['a', 'b'])
        const result = runChunked(ports, { batchSize: 10, budgetMs })
        expect(handled).toEqual(['a'])
        expect(result).toMatchObject({ done: false, cursor: 'a' })
        expect(saved).toEqual([{ cursor: 'a', processed: 1, done: false }])
    })
})

describe('cursorReport', () => {
    const none = { failed: 0, lastError: '' }

    it('reads complete for a pass that reached the end with no record failed', () => {
        expect(cursorReport(none, { ...none, resumed: false, done: true })).toEqual({ ...none, status: 'complete' })
    })

    it('reads paused for a run that spent its budget with no record failed', () => {
        expect(cursorReport(none, { ...none, resumed: true, done: false })).toEqual({ ...none, status: 'paused (time budget)' })
    })

    it('never reads complete when a record of the run failed', () => {
        const report = cursorReport(none, { failed: 2, lastError: 'b: boom', resumed: false, done: true })
        expect(report).toEqual({ failed: 2, lastError: 'b: boom', status: 'complete with 2 failed record(s)' })
    })

    it('says how many records failed so far when it pauses', () => {
        const report = cursorReport(none, { failed: 1, lastError: 'a: boom', resumed: false, done: false })
        expect(report.status).toBe('paused (time budget), 1 failed record(s) so far')
    })

    it("adds an earlier run's failures to a run that resumes the pass, so a clean last run does not hide them", () => {
        const stored = { failed: 3, lastError: 'c: refused' }
        expect(cursorReport(stored, { ...none, resumed: true, done: true })).toEqual({
            failed: 3,
            lastError: 'c: refused',
            status: 'complete with 3 failed record(s)',
        })
        expect(cursorReport(stored, { failed: 1, lastError: 'x: boom', resumed: true, done: false })).toEqual({
            failed: 4,
            lastError: 'x: boom',
            status: 'paused (time budget), 4 failed record(s) so far',
        })
    })

    it("drops the last pass's failures when a run starts a fresh pass", () => {
        expect(cursorReport({ failed: 3, lastError: 'c: refused' }, { ...none, resumed: false, done: true })).toEqual({ ...none, status: 'complete' })
    })

    it('keeps no error text once no record of the pass failed', () => {
        expect(cursorReport({ failed: 0, lastError: 'stale' }, { ...none, resumed: true, done: true })).toEqual({ ...none, status: 'complete' })
    })
})

describe('usableBatchSize', () => {
    it.each([
        [500, 500],
        [2.9, 2],
        [0, 1],
        [-5, 1],
        [Number.NaN, 1],
    ])('makes %s a batch of %i', (configured, size) => {
        expect(usableBatchSize(configured)).toBe(size)
    })
})

describe('a pass position in parm2', () => {
    it('carries the pass token and the cursor, and reads back', () => {
        expect(passParm({ token: '1762689600000', cursor: 'abc123' })).toBe('1762689600000:abc123')
        expect(readPassParm('1762689600000:abc123')).toEqual({ token: '1762689600000', cursor: 'abc123' })
    })

    it("has an empty cursor on a pass's first event", () => {
        expect(passParm({ token: '1762689600000', cursor: '' })).toBe('1762689600000:')
        expect(readPassParm('1762689600000:')).toEqual({ token: '1762689600000', cursor: '' })
    })

    it('reads back a cursor that holds the separator', () => {
        const position = { token: '1762689600000', cursor: 'a:b' }
        expect(readPassParm(passParm(position))).toEqual(position)
    })

    // '' is what a fresh trigger queues; a bare cursor or an event in another encoding names no pass either.
    it.each(['', 'abc123', 'a period sys_id'])('reads %j as naming no pass and no cursor', (parm2) => {
        expect(readPassParm(parm2)).toEqual({ token: '', cursor: '' })
    })

    it('reads a cursor without a token as naming no pass', () => {
        expect(readPassParm(':abc123')).toEqual({ token: '', cursor: 'abc123' })
    })
})

describe('isCurrentPass', () => {
    it('lets only the current pass go on', () => {
        expect(isCurrentPass('1762689600000', '1762689600000')).toBe(true)
        expect(isCurrentPass('1762689600000', '1762680000000')).toBe(false)
    })

    it('stops every pass of a job whose pass was retired, and events that name no pass', () => {
        expect(isCurrentPass('', '1762689600000')).toBe(false)
        expect(isCurrentPass('', '')).toBe(false)
        expect(isCurrentPass('1762689600000', '')).toBe(false)
    })
})

type Write = 'flush' | 'complete'

function lockedChunk(opts: { current?: boolean; heldUntil?: Write; throwsIn?: Write } = {}) {
    const steps: string[] = []
    const write = (step: Write) => {
        steps.push(step)
        if (opts.throwsIn === step) throw new Error(`${step} failed`)
    }
    const ports: LockedChunkPorts = {
        isCurrent: () => opts.current ?? true,
        // `heldUntil` is the write during which a taker clears the lock.
        held: () => !(opts.heldUntil && steps.includes(opts.heldUntil)),
        flush: () => write('flush'),
        queueNext: () => steps.push('queueNext'),
        complete: () => write('complete'),
    }
    return { ports, steps }
}

describe('writeChunkUnderLock', () => {
    it('flushes a chunk and queues the next one', () => {
        const { ports, steps } = lockedChunk()
        expect(writeChunkUnderLock(ports, false)).toEqual({ outcome: 'written' })
        expect(steps).toEqual(['flush', 'queueNext'])
    })

    it('flushes the last chunk and completes the pass', () => {
        const { ports, steps } = lockedChunk()
        expect(writeChunkUnderLock(ports, true)).toEqual({ outcome: 'written' })
        expect(steps).toEqual(['flush', 'complete'])
    })

    it('writes nothing for a superseded pass', () => {
        const { ports, steps } = lockedChunk({ current: false })
        expect(writeChunkUnderLock(ports, true)).toEqual({ outcome: 'superseded' })
        expect(steps).toEqual([])
    })

    it.each([false, true])('writes nothing more after losing the lock during its flush (last chunk: %s)', (last) => {
        const { ports, steps } = lockedChunk({ heldUntil: 'flush' })
        expect(writeChunkUnderLock(ports, last)).toEqual({ outcome: 'lost', error: '' })
        expect(steps).toEqual(['flush'])
    })

    it('reports a pass whose lock was lost during its completion', () => {
        const { ports, steps } = lockedChunk({ heldUntil: 'complete' })
        expect(writeChunkUnderLock(ports, true)).toEqual({ outcome: 'lost', error: '' })
        expect(steps).toEqual(['flush', 'complete'])
    })

    it.each<Write>(['flush', 'complete'])('reports the lock as lost, with the error, when the %s throws after losing it', (step) => {
        const { ports, steps } = lockedChunk({ heldUntil: step, throwsIn: step })
        expect(writeChunkUnderLock(ports, true)).toEqual({ outcome: 'lost', error: `${step} failed` })
        expect(steps.at(-1)).toBe(step)
    })

    // A refused save in a chunk throws (entry/margin.ts): its pass must then neither go on nor complete.
    it.each<[Write, boolean, string[]]>([
        ['flush', false, ['flush']],
        ['flush', true, ['flush']],
        ['complete', true, ['flush', 'complete']],
    ])('writes nothing more when the %s throws still holding the lock (last chunk: %s)', (step, last, written) => {
        const { ports, steps } = lockedChunk({ throwsIn: step })
        expect(() => writeChunkUnderLock(ports, last)).toThrow(`${step} failed`)
        expect(steps).toEqual(written)
    })

    it('neither queues the next chunk nor throws after a flush that threw having lost the lock', () => {
        const { ports, steps } = lockedChunk({ heldUntil: 'flush', throwsIn: 'flush' })
        expect(writeChunkUnderLock(ports, false)).toEqual({ outcome: 'lost', error: 'flush failed' })
        expect(steps).toEqual(['flush'])
    })
})

describe('lockLostIn', () => {
    it('gives nothing for a write that held the lock throughout', () => {
        expect(lockLostIn({ lock: 'held', value: undefined })).toBeNull()
    })

    it('reports a write that finished after losing the lock', () => {
        expect(lockLostIn({ lock: 'lost', threw: false, value: undefined })).toEqual({ outcome: 'lost', error: '' })
    })

    it('reports a write that threw after losing the lock, with what it threw', () => {
        expect(lockLostIn({ lock: 'lost', threw: true, error: 'deadlock' })).toEqual({ outcome: 'lost', error: 'deadlock' })
        expect(lockLostIn({ lock: 'lost', threw: true, error: new Error('insert refused') })).toEqual({
            outcome: 'lost',
            error: 'insert refused',
        })
    })
})

describe('JOB', () => {
    it('gives every job a row of its own, whatever period a per-period job runs for', () => {
        const names = Object.values(JOB)
        const fixed = names.flatMap((name) => (typeof name === 'string' ? [name] : []))
        const perPeriodPrefixes = names.flatMap((name) => (typeof name === 'function' ? [name('')] : []))
        expect(new Set(fixed).size).toBe(fixed.length)
        expect(new Set(perPeriodPrefixes).size).toBe(perPeriodPrefixes.length)
        for (const prefix of perPeriodPrefixes) {
            expect(fixed.filter((name) => name.startsWith(prefix)), prefix).toEqual([])
            expect(perPeriodPrefixes.filter((other) => other !== prefix && other.startsWith(prefix)), prefix).toEqual([])
        }
    })
})
