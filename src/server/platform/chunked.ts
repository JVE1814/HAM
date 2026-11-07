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

function loadCursorRecord(job: string): GlideRecord {
    const gr = new GlideRecord('x_daas_ham_job_cursor')
    if (gr.get('job', job)) return gr
    gr.initialize()
    gr.setValue('job', job)
    gr.insert()
    return gr
}

/**
 * The same runner driven by an event instead of a schedule: the cursor travels in the event's parm2
 * and the event is queued again (with the new cursor) until the pass is complete.
 */
export function runEventTableJob<T>(
    spec: Omit<TableJob<T>, 'job'> & { eventName: string; record: GlideRecord; parm1: string; cursor: string },
): ChunkedJobResult {
    return runChunked<{ id: string; item: T }>(
        {
            loadCursor: () => spec.cursor,
            fetchBatch: (after, size) => fetchBatch(spec, after, size),
            keyOf: (record) => record.id,
            handle: (record) => spec.handle(record.item, record.id),
            saveCursor: (cursor, _processed, done) => {
                if (!done) gs.eventQueue(spec.eventName, spec.record, spec.parm1, cursor)
            },
            now: nowMs,
        },
        {
            batchSize: intProperty(PROPERTY.jobBatchSize, 500),
            budgetMs: intProperty(PROPERTY.jobBudgetSeconds, 120) * 1000,
        },
    )
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
