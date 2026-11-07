import { GlideRecord, gs } from '@servicenow/glide'
import { runChunked, type ChunkedJobResult } from '../domain/chunked-job'
import { andEachClause } from '../domain/encoded-query'
import { msToGlide, nowMs } from './clock'
import { intProperty, PROPERTY } from './properties'

/** Run the chunked-job runner over a table, persisting the cursor in x_daas_ham_job_cursor (ADR 0007). */
export interface TableJob<T> {
    job: string
    table: string
    query: string
    read(record: GlideRecord): T
    handle(item: T, sysId: string): void
}

export function runTableJob<T>(spec: TableJob<T>): ChunkedJobResult {
    const cursorRecord = loadCursorRecord(spec.job)
    return runChunked<{ id: string; item: T }>(
        {
            loadCursor: () => String(cursorRecord.getValue('cursor') ?? ''),
            fetchBatch: (after, size) => fetchBatch(spec, after, size),
            keyOf: (record) => record.id,
            handle: (record) => spec.handle(record.item, record.id),
            saveCursor: (cursor, processed, done) => {
                cursorRecord.setValue('cursor', cursor)
                cursorRecord.setValue('last_run', msToGlide(nowMs()))
                cursorRecord.setValue('processed_total', processed)
                cursorRecord.setValue('last_status', done ? 'complete' : 'paused (time budget)')
                cursorRecord.update()
            },
            now: nowMs,
        },
        {
            batchSize: intProperty(PROPERTY.jobBatchSize, 500),
            budgetMs: intProperty(PROPERTY.jobBudgetSeconds, 120) * 1000,
        },
    )
}

/** Start a new run of `job`, superseding any run still in progress; returns the run's token. */
function startRun(job: string): string {
    const record = loadCursorRecord(job)
    const token = String(nowMs())
    record.setValue('cursor', token)
    record.setValue('last_run', msToGlide(nowMs()))
    record.setValue('last_status', 'running')
    record.update()
    return token
}

function isCurrentRun(job: string, token: string): boolean {
    return String(loadCursorRecord(job).getValue('cursor') ?? '') === token
}

function loadCursorRecord(job: string): GlideRecord {
    const gr = new GlideRecord('x_daas_ham_job_cursor')
    if (gr.get('job', job)) return gr
    gr.initialize()
    gr.setValue('job', job)
    gr.insert()
    return gr
}

export interface EventTableJob<T> extends Omit<TableJob<T>, 'job'> {
    eventName: string
    record: GlideRecord
    parm1: string
    /** The event's parm2 as received ('' on the first event of a pass). */
    cursor: string
    /** Write out anything accumulated in memory before the next chunk can start. */
    flush?: () => void
    /**
     * Make each fresh pass supersede one still running under `job`: `onStart` runs once at the start
     * of a pass, and chunks of a superseded pass stop without flushing or queueing more events.
     */
    supersede?: { job: string; onStart(): void }
}

/**
 * The same runner driven by an event instead of a schedule: the cursor travels in the event's parm2
 * (with the pass token when `supersede` is set) and the event is queued again until the pass is
 * complete. A superseded chunk reports `done: false`.
 */
export function runEventTableJob<T>(spec: EventTableJob<T>): ChunkedJobResult {
    const run = spec.supersede
    let token = ''
    let cursor = spec.cursor
    if (run) {
        const separator = spec.cursor.indexOf(':')
        token = separator < 0 ? '' : spec.cursor.slice(0, separator)
        cursor = separator < 0 ? '' : spec.cursor.slice(separator + 1)
        if (!token) {
            token = startRun(run.job)
            run.onStart()
        } else if (!isCurrentRun(run.job, token)) {
            return { processed: 0, failed: 0, done: false, cursor, lastError: 'superseded' }
        }
    }
    let superseded = false
    const result = runChunked<{ id: string; item: T }>(
        {
            loadCursor: () => cursor,
            fetchBatch: (after, size) => fetchBatch(spec, after, size),
            keyOf: (record) => record.id,
            handle: (record) => spec.handle(record.item, record.id),
            saveCursor: (next, _processed, done) => {
                if (run && !isCurrentRun(run.job, token)) {
                    superseded = true
                    return
                }
                spec.flush?.()
                if (!done) gs.eventQueue(spec.eventName, spec.record, spec.parm1, run ? `${token}:${next}` : next)
            },
            now: nowMs,
        },
        {
            batchSize: intProperty(PROPERTY.jobBatchSize, 500),
            budgetMs: intProperty(PROPERTY.jobBudgetSeconds, 120) * 1000,
        },
    )
    return superseded ? { ...result, done: false, lastError: 'superseded' } : result
}

function fetchBatch<T>(spec: Pick<TableJob<T>, 'table' | 'query' | 'read'>, after: string, size: number) {
    const gr = new GlideRecord(spec.table)
    gr.addEncodedQuery(after ? andEachClause(spec.query, `sys_id>${after}`) : spec.query)
    gr.orderBy('sys_id')
    gr.setLimit(size)
    gr.query()
    const batch: Array<{ id: string; item: T }> = []
    while (gr.next()) batch.push({ id: gr.getUniqueValue(), item: spec.read(gr) })
    return batch
}
