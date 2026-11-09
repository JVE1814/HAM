import { GlideDateTime, GlideRecord, gs } from '@servicenow/glide'
import {
    cursorReport,
    runChunked,
    writeChunkUnderLock,
    writeHoldingLock,
    type ChunkedJobPorts,
    type ChunkedJobResult,
    type ChunkWrite,
    type Failures,
    type LockLost,
} from '../domain/chunked-job.ts'
import { andEachClause } from '../domain/encoded-query.ts'
import { msToGlide, nowMs } from './clock.ts'
import { isLocked, withLock } from './locks.ts'
import { intProperty, PROPERTY } from './properties.ts'
import { num, refusal, str } from './records.ts'

/**
 * Run the chunked-job runner over a table, persisting the cursor in x_daas_ham_job_cursor (ADR 0007).
 * Each record is read into a row `R`; the item handled is `T`, the row itself unless `prepare` is set.
 * A record whose handling throws is a failure: the pass moves on past it, the run logs its failures as an
 * error, and the cursor counts the pass's (`failed_total`, `last_error`), reading complete only without any.
 */
interface TableJobFields<T, R> {
    job: string
    table: string
    query: string
    read(record: GlideRecord): R
    handle(item: T, sysId: string): void
}

/**
 * Turn a batch's rows into the items handled, one per row and in the same order, loading what the
 * whole batch needs in one go (e.g. its referenced records with one query): called once per batch,
 * after every row of it is read and before any of it is handled. Required whenever the items handled
 * are not the rows read. A row it gives a RowFailure for fails with that error when it is handled; if
 * it throws, every row of the batch does. The pass moves on past them as past any other failed record.
 */
type Prepare<T, R> = [R] extends [T] ? { prepare?: PrepareBatch<T, R> } : { prepare: PrepareBatch<T, R> }

type PrepareBatch<T, R> = (rows: readonly R[]) => Array<T | RowFailure>

/** What `prepare` gives for a row it could not prepare: that row fails with `error` when it is handled, the others go on. */
export class RowFailure {
    constructor(readonly error: unknown) {}
}

export type TableJob<T, R = T> = TableJobFields<T, R> & Prepare<T, R>

/** The length of the job cursor's Last error column (data/operations.now.ts). */
const LAST_ERROR_LENGTH = 1000

/** Log the records of a run or chunk that failed as an error (`where` names it): the pass has moved on past them. */
function logFailures(where: string, failures: Failures): void {
    if (failures.failed === 0) return
    gs.error(`[x_daas_ham] ${where}: ${failures.failed} record(s) failed, the last: ${failures.lastError}`)
}

// The row type comes first so that, without `prepare`, the item type defaults to it.
export function runTableJob<R, T = R>(spec: TableJob<T, R>): ChunkedJobResult {
    let cursorRecord: GlideRecord
    try {
        cursorRecord = loadCursorRecord(spec.job)
    } catch (error) {
        // Without a cursor no progress is kept, and every run would handle the same records again from the start.
        const reason = error instanceof Error ? error.message : String(error)
        gs.error(`[x_daas_ham] ${spec.job}: not run: ${reason}`)
        return { processed: 0, failed: 0, done: false, cursor: '', lastError: reason }
    }
    // A run that starts from a saved cursor goes on with a pass that earlier runs began, and adds to their failures.
    const resumed = str(cursorRecord, 'cursor') !== ''
    return runOverTable(spec, {
        loadCursor: () => str(cursorRecord, 'cursor'),
        saveCursor: (cursor, processed, done, failures) => {
            // The pass moves on past a failed record: the log and the cursor are where it shows.
            logFailures(`${spec.job}: in this run`, failures)
            const stored = { failed: num(cursorRecord, 'failed_total'), lastError: str(cursorRecord, 'last_error') }
            const report = cursorReport(stored, { ...failures, resumed, done })
            cursorRecord.setValue('cursor', cursor)
            cursorRecord.setValue('last_run', msToGlide(nowMs()))
            cursorRecord.setValue('processed_total', processed)
            cursorRecord.setValue('failed_total', report.failed)
            cursorRecord.setValue('last_error', report.lastError.slice(0, LAST_ERROR_LENGTH))
            cursorRecord.setValue('last_status', report.status)
            if (cursorRecord.update()) return
            // The next run starts again from the cursor last saved, and would do so unseen.
            const reason = refusal(cursorRecord)
            gs.warn(`[x_daas_ham] ${spec.job}: cursor not saved, so the next run repeats this one: ${reason}`)
        },
    })
}

/**
 * Start a new run of `job`, superseding any run still in progress; returns the run's token (its start time). Throws
 * when the cursor is refused: that run could never be current, so its `onStart` must not clear anything for it.
 */
function startRun(job: string): string {
    const record = loadCursorRecord(job)
    const token = String(nowMs())
    record.setValue('cursor', token)
    record.setValue('last_run', msToGlide(nowMs()))
    record.setValue('last_status', 'running')
    if (record.update()) return token
    throw new Error(`job cursor ${job} not saved: ${refusal(record)}`)
}

/**
 * Mark the current run of `job` complete (a run still 'running' with an old last run has stalled). Called once the
 * pass's own completion is written, so a refusal here is only logged: thrown, it would stop a pass that completed.
 */
function completeRun(job: string): void {
    const record = loadCursorRecord(job)
    record.setValue('last_run', msToGlide(nowMs()))
    record.setValue('last_status', 'complete')
    if (record.update()) return
    gs.warn(`[x_daas_ham] ${job}: the pass completed, but its job cursor still reads running (as if stalled): ${refusal(record)}`)
}

function isCurrentRun(job: string, token: string): boolean {
    return str(loadCursorRecord(job), 'cursor') === token
}

/** The job's cursor record, created on its first run; throws (with why) when there is none and it cannot be created. */
function loadCursorRecord(job: string): GlideRecord {
    const found = findCursorRecord(job)
    if (found) return found
    const created = new GlideRecord('x_daas_ham_job_cursor')
    created.initialize()
    created.setValue('job', job)
    if (created.insert()) return created
    // Another run inserted it first (the unique index on job): go on from that run's record, never an unsaved one.
    const raced = findCursorRecord(job)
    if (raced) return raced
    throw new Error(`job cursor ${job} could not be created: ${refusal(created)}`)
}

function findCursorRecord(job: string): GlideRecord | null {
    const gr = new GlideRecord('x_daas_ham_job_cursor')
    return gr.get('job', job) ? gr : null
}

export type EventTableJob<T, R = T> = Omit<TableJobFields<T, R>, 'job'> & Prepare<T, R> & EventJobFields

interface EventJobFields {
    eventName: string
    record: GlideRecord
    parm1: string
    /** The event's parm2 as received ('' on the first event of a pass). */
    cursor: string
    /**
     * Write out what the chunk accumulated in memory, with its records that failed, before the next chunk can start.
     * The runner logs a chunk's failures either way; `flush` records them where the pass's outcome is kept.
     */
    flush?: (failures: Failures) => void
    /**
     * Make each fresh pass supersede one still running under `job` (see runEventTableJob). `onStart` runs once
     * as a pass starts, `complete` once its last chunk is flushed and `stopped` when a chunk throws, each only
     * while the pass is still the current one. A chunk may be handled again (after finding the job locked), so
     * `handle` must only accumulate in memory: every write belongs in `flush`, `onStart` and `complete`.
     */
    supersede?: { job: string; onStart(): void; complete?(): void; stopped?(error: string): void }
}

/** How long a chunk that finds its job locked waits before it runs again from the same cursor. */
const LOCKED_RETRY_SECONDS = 60

/**
 * The same runner driven by an event instead of a schedule: the cursor travels in the event's parm2
 * (with the pass token when `supersede` is set) and the event is queued again until the pass is complete.
 * A chunk's failed records are logged as an error; without `flush` they are kept nowhere else.
 *
 * With `supersede`, a pass's start, each chunk's flush and the pass's completion hold the job's lock
 * (ADR 0013), and each checks under it that its pass is still the current one: a fresh pass starts only
 * between them, so a superseded chunk neither flushes, queues the next chunk nor completes its pass, and
 * nothing it handled is written. A chunk that finds the lock held runs again later from the same cursor
 * and pass; a pass that completes is marked complete on its job cursor. A holder that outlasts the lock's
 * abandonment time can lose it mid-write to a fresh pass, so after each write, and when a write throws,
 * it checks it still holds it; one that lost it writes nothing more and starts another fresh pass, which
 * clears what both wrote. A superseded, retried or restarted chunk reports `done: false` and no counts.
 */
export function runEventTableJob<R, T = R>(spec: EventTableJob<T, R>): ChunkedJobResult {
    const supersede = spec.supersede
    if (!supersede) {
        return runOverTable(spec, {
            loadCursor: () => spec.cursor,
            saveCursor: (next, _processed, done, failures) => {
                logFailures(`${spec.eventName} ${spec.parm1}: in this chunk`, failures)
                spec.flush?.(failures)
                if (!done) gs.eventQueue(spec.eventName, spec.record, spec.parm1, next)
            },
        })
    }
    const job = supersede.job
    const separator = spec.cursor.indexOf(':')
    let token = separator < 0 ? '' : spec.cursor.slice(0, separator)
    const cursor = separator < 0 ? '' : spec.cursor.slice(separator + 1)
    const idle = { processed: 0, failed: 0, done: false, cursor, lastError: '' }
    try {
        if (!token) {
            // Set inside the start's lock.
            let lost = null as LockLost | null
            const started = withLock(job, (lock) => {
                lost = writeHoldingLock(
                    () => lock.held(),
                    () => {
                        token = startRun(job)
                        supersede.onStart()
                    },
                )
            })
            if (!started) return retryLater(spec, '')
            if (lost) return restartPass(spec, lost.error)
        } else if (!isCurrentRun(job, token)) {
            return idle
        }
        // A cheap probe first: a chunk only takes the lock at its end, and would throw its work away then.
        if (isLocked(job)) return retryLater(spec, `${token}:${cursor}`)
        // Set inside saveCursor's lock.
        let write = { outcome: 'written' } as ChunkWrite | { outcome: 'locked' }
        const result = runOverTable(spec, {
            loadCursor: () => cursor,
            saveCursor: (next, _processed, done, failures) => {
                const taken = withLock(job, (lock) => {
                    write = writeChunkUnderLock(
                        {
                            isCurrent: () => isCurrentRun(job, token),
                            held: () => lock.held(),
                            // Logged only as the chunk is written: a superseded chunk's work is dropped, a locked one runs again.
                            flush: () => {
                                logFailures(`${spec.eventName} ${spec.parm1}: in this chunk`, failures)
                                spec.flush?.(failures)
                            },
                            queueNext: () => gs.eventQueue(spec.eventName, spec.record, spec.parm1, `${token}:${next}`),
                            complete: () => {
                                supersede.complete?.()
                                completeRun(job)
                            },
                        },
                        done,
                    )
                })
                if (!taken) write = { outcome: 'locked' }
            },
        })
        if (write.outcome === 'locked') return retryLater(spec, `${token}:${cursor}`)
        if (write.outcome === 'lost') return restartPass(spec, write.error)
        return write.outcome === 'superseded' ? idle : result
    } catch (error) {
        if (token) recordStop(supersede, token, error instanceof Error ? error.message : String(error))
        throw error
    }
}

/** Tell the pass `token` that a chunk of it threw, under the job's lock and only while it is the current pass. */
function recordStop(supersede: NonNullable<EventJobFields['supersede']>, token: string, error: string): void {
    try {
        withLock(supersede.job, () => {
            if (isCurrentRun(supersede.job, token)) supersede.stopped?.(error)
        })
    } catch (unrecorded) {
        // The original error is what the caller sees; this one (e.g. a refused save in `stopped`) is only logged.
        const reason = unrecorded instanceof Error ? unrecorded.message : String(unrecorded)
        gs.warn(`[x_daas_ham] ${supersede.job}: why the pass stopped was not recorded: ${reason}`)
    }
}

/** Queue the event again with `parm2` (the same pass and cursor, or '' to start one) to run once the job's lock is free. */
function retryLater(spec: Pick<EventJobFields, 'eventName' | 'record' | 'parm1'>, parm2: string): ChunkedJobResult {
    gs.warn(`[x_daas_ham] ${spec.eventName} ${spec.parm1}: job locked, running again in ${LOCKED_RETRY_SECONDS} s`)
    const when = new GlideDateTime()
    when.addSeconds(LOCKED_RETRY_SECONDS)
    gs.eventQueueScheduled(spec.eventName, spec.record, spec.parm1, parm2, when)
    return { processed: 0, failed: 0, done: false, cursor: parm2, lastError: 'job locked: retried later' }
}

/**
 * Start a fresh pass at once, after a chunk lost the job's lock mid-write: it clears what that chunk wrote beside the pass that took over.
 * `error` is what the write threw after losing the lock ('' when it finished): the chunk throws nothing, so it is logged here.
 */
function restartPass(spec: Pick<EventJobFields, 'eventName' | 'record' | 'parm1'>, error: string): ChunkedJobResult {
    const threw = error ? ` (the write then threw: ${error})` : ''
    gs.warn(`[x_daas_ham] ${spec.eventName} ${spec.parm1}: job lock lost while writing${threw}, starting a fresh pass`)
    gs.eventQueue(spec.eventName, spec.record, spec.parm1, '')
    return { processed: 0, failed: 0, done: false, cursor: '', lastError: 'job lock lost: pass restarted' }
}

type TableSource<T, R> = Pick<TableJobFields<T, R>, 'table' | 'query' | 'read' | 'handle'> & { prepare?: PrepareBatch<T, R> }

/** A record of a batch as handled: its item, or the error `prepare` failed it with. */
type BatchRecord<T> = { id: string; item: T } | { id: string; prepareError: unknown }

/** The runner over a table's records in sys_id order, with the batch size and time budget from properties. */
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
            batchSize: intProperty(PROPERTY.jobBatchSize, 500),
            budgetMs: intProperty(PROPERTY.jobBudgetSeconds, 120) * 1000,
        },
    )
}

function fetchBatch<T, R>(spec: TableSource<T, R>, after: string, size: number): Array<BatchRecord<T>> {
    const gr = new GlideRecord(spec.table)
    gr.addEncodedQuery(after ? andEachClause(spec.query, `sys_id>${after}`) : spec.query)
    gr.orderBy('sys_id')
    gr.setLimit(size)
    gr.query()
    const ids: string[] = []
    const rows: R[] = []
    while (gr.next()) {
        ids.push(gr.getUniqueValue())
        rows.push(spec.read(gr))
    }
    let items: Array<T | RowFailure>
    try {
        // Without `prepare` the rows are the items (T defaults to R).
        items = spec.prepare ? spec.prepare(rows) : (rows as unknown[] as T[])
    } catch (error) {
        // Thrown from here, outside the runner's per-record handling, it would stop the chunk with no cursor saved.
        return ids.map((id) => ({ id, prepareError: error }))
    }
    return ids.map((id, index) => {
        const item = items[index]
        return item instanceof RowFailure ? { id, prepareError: item.error } : { id, item }
    })
}
