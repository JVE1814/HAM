import { GlideRecord } from '@servicenow/glide'
import { runChunked, type ChunkedJobResult } from '../domain/chunked-job'
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
            fetchBatch: (after, size) => {
                const gr = new GlideRecord(spec.table)
                gr.addEncodedQuery(spec.query)
                if (after) gr.addQuery('sys_id', '>', after)
                gr.orderBy('sys_id')
                gr.setLimit(size)
                gr.query()
                const batch: Array<{ id: string; item: T }> = []
                while (gr.next()) batch.push({ id: gr.getUniqueValue(), item: spec.read(gr) })
                return batch
            },
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
