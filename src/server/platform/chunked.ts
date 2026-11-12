import { GlideRecord } from '@servicenow/glide'
import {
    cursorReport,
    JOB_STATUS,
    lockLostIn,
    passParm,
    readPassParm,
    runChunked,
    usableBatchSize,
    writeChunkUnderLock,
    type ChunkedJobPorts,
    type ChunkedJobResult,
    type ChunkWrite,
    type Failures,
} from '../domain/chunked-job.ts'
import { andEachClause } from '../domain/encoded-query.ts'
import { messageOf } from '../domain/errors.ts'
import { REQUEUE, writeHoldingLock } from '../domain/job-lock.ts'
import { LOCK } from '../domain/lock-names.ts'
import { PROPERTY } from '../domain/properties.ts'
import { nowMs } from './clock.ts'
import { queueJobAt, type JobEvent } from './events.ts'
import { completePass, isCurrentPass, openJobCursor, startPass, type JobCursor } from './job-cursor.ts'
import { isLocked, withLock } from './locks.ts'
import { log } from './log.ts'
import { intProperty } from './properties.ts'

/**
 * The chunked-job runners over a table's records (ADR 0007), for a scheduled job (`runTableJob`, its cursor kept in
 * x_daas_ham_job_cursor) and for an event job (`runEventTableJob`, its cursor carried by its events).
 *
 * An event job whose passes replace each other has a runner of its own, over the same table walk, because each of
 * the two such jobs is kept from an old pass's writes in a different way:
 * - the margin recompute runs on `runSupersedingChunk`, under the job's lock (ADR 0013). A fresh recompute may start
 *   while one is running, and an old pass writing after it would leave its Cost facts beside the fresh pass's or
 *   replace the fresh Margin. So a pass's start, each flush and its completion check that the pass is still current
 *   and write in one critical section;
 * - billing generation runs on `runTriggeredChunk` and takes no lock (ADR 0007). A period is regenerated only once it
 *   is ready for review, never while it is generating, so no fresh pass starts beside a running one: a pass starts
 *   where it is triggered (`queuePass`), and its token only drops the chunks still queued of a pass reset by hand or
 *   replaced (`inCurrentPass`).
 *
 * Each record is read into a row `R`; the item handled is `T`, the row itself unless `prepare` is set.
 * A record whose handling throws is a failure: the pass moves on past it, the run logs its failures as an
 * error, and the cursor counts the pass's (`failed_total`, `last_error`), reading complete only without any.
 */
interface TableSourceFields<T, R> {
    table: string
    query: string
    read(record: GlideRecord): R
    handle(item: T, sysId: string): void
}

/**
 * Turn a batch's rows into the items handled, one per row and in the same order, loading what the
 * whole batch needs in one go (e.g. its referenced records with one query): called once per batch,
 * after every row of it is read and before any of it is handled. Required whenever the items handled
 * are not the rows read. If it throws, every row of the batch fails with that error when it is handled,
 * and the pass moves on past them as past any other failed record.
 */
type Prepare<T, R> = [R] extends [T] ? { prepare?: PrepareBatch<T, R> } : { prepare: PrepareBatch<T, R> }

type PrepareBatch<T, R> = (rows: readonly R[]) => T[]

type TableSource<T, R> = TableSourceFields<T, R> & { prepare?: PrepareBatch<T, R> }

type TableJob<T, R = T> = TableSourceFields<T, R> & Prepare<T, R> & { job: string }

function logFailures(where: string, failures: Failures): void {
    if (failures.failed === 0) return
    log.error(`${where}: ${failures.failed} record(s) failed, the last: ${failures.lastError}`)
}

function chunkOf(queued: JobEvent): string {
    return `${queued.name} ${queued.subject}: in this chunk`
}

// The row type comes first so that, without `prepare`, the item type defaults to it.
export function runTableJob<R, T = R>(spec: TableJob<T, R>): ChunkedJobResult {
    let row: JobCursor
    try {
        row = openJobCursor(spec.job)
    } catch (error) {
        // Without a cursor no progress is kept, and every run would handle the same records again from the start.
        const reason = messageOf(error)
        log.error(`${spec.job}: not run: ${reason}`)
        return { processed: 0, failed: 0, done: false, cursor: '', lastError: reason }
    }
    const resumed = row.cursor !== ''
    return runOverTable(spec, {
        loadCursor: () => row.cursor,
        saveCursor: (cursor, processed, done, failures) => {
            logFailures(`${spec.job}: in this run`, failures)
            const report = cursorReport({ failed: row.failed, lastError: row.lastError }, { ...failures, resumed, done })
            const refused = row.save({ cursor, processed, status: report.status, failed: report.failed, lastError: report.lastError, ranNow: true })
            if (refused) log.warn(`${spec.job}: cursor not saved, so the next run repeats this one: ${refused}`)
        },
    })
}

type EventJob<T, R = T> = TableSourceFields<T, R> &
    Prepare<T, R> & {
        /**
         * Write out what the chunk accumulated in memory, with its records that failed, before the next chunk can start.
         * The runner logs a chunk's failures either way; `flush` records them where the pass's outcome is kept.
         */
        flush?: (failures: Failures) => void
    }

/** An event job whose passes replace each other: each event carries its pass's token, and only the current pass writes. */
type PassJob<T, R> = EventJob<T, R> & {
    /** The job, whose cursor row names the current pass. */
    job: string
}

/**
 * `onStart` runs once as a pass starts, `complete` once its last chunk is flushed and `stopped` when a chunk throws,
 * each under the job's lock and only while the pass is still the current one. A chunk may be handled again (after
 * finding the job locked), so `handle` must only accumulate in memory: every write belongs in `flush`, `onStart` and
 * `complete`.
 */
type SupersedingJob<T, R> = PassJob<T, R> & { onStart(): void; complete?(): void; stopped?(error: string): void }

export interface EventJobResult extends ChunkedJobResult {
    /** The chunk's pass is no longer its job's current one: nothing it handled was written, and nothing is queued. */
    superseded: boolean
}

/**
 * An event job's query is scoped by its subject: without one it would match every record that names none, so every
 * event runner runs nothing for it.
 */
function unscoped(queued: JobEvent): EventJobResult {
    return { processed: 0, failed: 0, done: false, cursor: queued.position, lastError: '', superseded: false }
}

/**
 * The same runner driven by an event instead of a schedule: the cursor travels in the event's parm2 and the event is
 * queued again until the pass is complete. A chunk's failed records are logged as an error; without `flush` they are
 * kept nowhere else.
 */
export function runEventTableJob<R, T = R>(queued: JobEvent, spec: EventJob<T, R>): EventJobResult {
    if (!queued.subject) return unscoped(queued)
    const result = runOverTable(spec, {
        loadCursor: () => queued.position,
        saveCursor: (next, _processed, done, failures) => {
            logFailures(chunkOf(queued), failures)
            spec.flush?.(failures)
            if (!done) queueJobAt(queued, next)
        },
    })
    return { ...result, superseded: false }
}

/**
 * Start a pass of `job` where it is triggered and queue its first chunk, for a job run by `runTriggeredChunk`, which
 * starts none. The chunks still queued of an earlier pass are dropped from then on. Throws (with why) when the pass
 * cannot be recorded on the job's cursor, and then queues nothing.
 */
export function queuePass(name: string, record: GlideRecord, subject: string, job: string): void {
    const token = startPass(job, JOB_STATUS.passStarted)
    queueJobAt({ name, record, subject, position: '' }, passParm({ token, cursor: '' }))
}

export function inCurrentPass(queued: JobEvent, job: string): boolean {
    return isCurrentPass(job, readPassParm(queued.position).token)
}

function superseded(cursor: string): EventJobResult {
    return { processed: 0, failed: 0, done: false, cursor, lastError: '', superseded: true }
}

/**
 * One chunk of a pass started where it was triggered (`queuePass`). It checks that its pass is still the job's current
 * one as it starts and again before it writes: a chunk of a pass replaced or retired since, or of an event that carries
 * no pass, neither flushes nor queues the next chunk, and is reported as `superseded`. It takes no lock, and the caller
 * completes the pass on a result that is `done`.
 */
export function runTriggeredChunk<R, T = R>(queued: JobEvent, spec: PassJob<T, R>): EventJobResult {
    if (!queued.subject) return unscoped(queued)
    const job = spec.job
    const { token, cursor } = readPassParm(queued.position)
    if (!isCurrentPass(job, token)) return superseded(cursor)
    let current = true
    const result = runOverTable(spec, {
        loadCursor: () => cursor,
        saveCursor: (next, _processed, done, failures) => {
            current = isCurrentPass(job, token)
            if (!current) return
            logFailures(chunkOf(queued), failures)
            spec.flush?.(failures)
            if (!done) queueJobAt(queued, passParm({ token, cursor: next }))
        },
    })
    return current ? { ...result, superseded: false } : superseded(cursor)
}

/**
 * One chunk of a pass that a fresh pass supersedes, started by the runner itself from an event that carries none (a
 * fresh trigger). A pass's start, each chunk's flush and the pass's completion hold the job's lock (ADR 0013), and each
 * checks under it that its pass is still the current one: a fresh pass starts only between them, so a superseded chunk
 * neither flushes, queues the next chunk nor completes its pass, and nothing it handled is written. A chunk that finds
 * the lock held runs again later from the same cursor and pass; a pass that completes is marked complete on its job
 * cursor. A holder that outlasts the lock's abandonment time can lose it mid-write to a fresh pass, so after each
 * write, and when a write throws, it checks it still holds it; one that lost it writes nothing more and starts another
 * fresh pass, which clears what both wrote. A superseded, retried or restarted chunk reports `done: false` and no counts.
 */
export function runSupersedingChunk<R, T = R>(queued: JobEvent, spec: SupersedingJob<T, R>): EventJobResult {
    if (!queued.subject) return unscoped(queued)
    const job = spec.job
    const lockName = LOCK.job(job)
    const position = readPassParm(queued.position)
    const cursor = position.cursor
    let token = position.token
    try {
        if (!token) {
            const start = withLock(lockName, (lock) => {
                const started = writeHoldingLock(
                    () => lock.held(),
                    () => {
                        token = startPass(job, JOB_STATUS.running)
                        spec.onStart()
                    },
                )
                return lockLostIn(started)
            })
            if (!start.ran) return retryLater(queued, '')
            if (start.value) return restartPass(queued, start.value.error)
        } else if (!isCurrentPass(job, token)) {
            return superseded(cursor)
        }
        // A cheap probe first: a chunk only takes the lock at its end, and would throw its work away then.
        if (isLocked(lockName)) return retryLater(queued, passParm({ token, cursor }))
        let write = { outcome: 'written' } as ChunkWrite | { outcome: 'locked' }
        const result = runOverTable(spec, {
            loadCursor: () => cursor,
            saveCursor: (next, _processed, done, failures) => {
                const chunk = withLock(lockName, (lock) =>
                    writeChunkUnderLock(
                        {
                            isCurrent: () => isCurrentPass(job, token),
                            held: () => lock.held(),
                            // Logged only as the chunk is written: a superseded chunk's work is dropped, a locked one runs again.
                            flush: () => {
                                logFailures(chunkOf(queued), failures)
                                spec.flush?.(failures)
                            },
                            queueNext: () => queueJobAt(queued, passParm({ token, cursor: next })),
                            complete: () => {
                                spec.complete?.()
                                completePass(job)
                            },
                        },
                        done,
                    ),
                )
                write = chunk.ran ? chunk.value : { outcome: 'locked' }
            },
        })
        if (write.outcome === 'locked') return retryLater(queued, passParm({ token, cursor }))
        if (write.outcome === 'lost') return restartPass(queued, write.error)
        return write.outcome === 'superseded' ? superseded(cursor) : { ...result, superseded: false }
    } catch (error) {
        if (token) recordStop(spec, token, messageOf(error))
        throw error
    }
}

function recordStop(pass: Pick<SupersedingJob<unknown, unknown>, 'job' | 'stopped'>, token: string, error: string): void {
    try {
        withLock(LOCK.job(pass.job), () => {
            if (isCurrentPass(pass.job, token)) pass.stopped?.(error)
        })
    } catch (unrecorded) {
        log.warn(`${pass.job}: why the pass stopped was not recorded: ${messageOf(unrecorded)}`)
    }
}

function retryLater(queued: JobEvent, parm2: string): EventJobResult {
    log.warn(`${queued.name} ${queued.subject}: job locked, running again in ${REQUEUE.delaySeconds} s`)
    queueJobAt(queued, parm2, 'later')
    return { processed: 0, failed: 0, done: false, cursor: parm2, lastError: 'job locked: retried later', superseded: false }
}

/**
 * Start a fresh pass at once, after a chunk lost the job's lock mid-write: it clears what that chunk wrote beside the pass that took over.
 * `error` is what the write threw after losing the lock ('' when it finished): the chunk throws nothing, so it is logged here.
 */
function restartPass(queued: JobEvent, error: string): EventJobResult {
    const threw = error ? ` (the write then threw: ${error})` : ''
    log.warn(`${queued.name} ${queued.subject}: job lock lost while writing${threw}, starting a fresh pass`)
    queueJobAt(queued, '')
    return { processed: 0, failed: 0, done: false, cursor: '', lastError: 'job lock lost: pass restarted', superseded: false }
}

type BatchRecord<T> = { id: string; item: T } | { id: string; prepareError: unknown }

function batchSize(): number {
    return usableBatchSize(intProperty(PROPERTY.jobBatchSize))
}

function runOverTable<T, R>(spec: TableSource<T, R>, cursor: Pick<ChunkedJobPorts<unknown>, 'loadCursor' | 'saveCursor'>): ChunkedJobResult {
    return runChunked<BatchRecord<T>>(
        {
            loadCursor: cursor.loadCursor,
            saveCursor: cursor.saveCursor,
            fetchBatch: (after, size) => fetchBatch(spec, after, size),
            keyOf: (record) => record.id,
            handle: (record) => {
                if ('prepareError' in record) throw record.prepareError
                spec.handle(record.item, record.id)
            },
            now: nowMs,
        },
        {
            batchSize: batchSize(),
            budgetMs: intProperty(PROPERTY.jobBudgetSeconds) * 1000,
        },
    )
}

function fetchBatch<T, R>(spec: TableSource<T, R>, after: string, size: number): Array<BatchRecord<T>> {
    const rows: R[] = []
    const ids = visitPage(spec.table, spec.query, after, size, (record) => rows.push(spec.read(record)))
    let items: T[]
    try {
        items = spec.prepare ? spec.prepare(rows) : (rows as unknown[] as T[])
    } catch (error) {
        // Thrown from here, outside the runner's per-record handling, it would stop the chunk with no cursor saved.
        return ids.map((id) => ({ id, prepareError: error }))
    }
    return ids.map((id, index) => ({ id, item: items[index] }))
}

/**
 * Visit every record of `table` matching `query` in sys_id order, a batch at a time and with no time budget: for work
 * that must reach the end within its transaction. Each record is visited once even when visiting it takes it out of
 * the query, or leaves it in.
 */
export function visitInKeyOrder(table: string, query: string, visit: (record: GlideRecord) => void): void {
    const size = batchSize()
    let after = ''
    for (;;) {
        const ids = visitPage(table, query, after, size, visit)
        if (ids.length < size) return
        after = ids[ids.length - 1]
    }
}

function visitPage(table: string, query: string, after: string, size: number, visit: (record: GlideRecord) => void): string[] {
    const gr = new GlideRecord(table)
    gr.addEncodedQuery(after ? andEachClause(query, `sys_id>${after}`) : query)
    gr.orderBy('sys_id')
    gr.setLimit(size)
    gr.query()
    const ids: string[] = []
    while (gr.next()) {
        ids.push(gr.getUniqueValue())
        visit(gr)
    }
    return ids
}
