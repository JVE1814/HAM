/**
 * Bulk work in bounded chunks with a persistent cursor (ADR 0007).
 *
 * Records are visited in ascending key order. A run stops when its time budget is spent and saves
 * the last key it finished; the next run continues after it. When the end is reached the cursor
 * resets so the following run starts a fresh pass.
 */
export interface ChunkedJobPorts<T> {
    loadCursor(): string
    /** Up to `size` records with key > `after`, in ascending key order. */
    fetchBatch(after: string, size: number): T[]
    keyOf(record: T): string
    handle(record: T): void
    saveCursor(cursor: string, processed: number, done: boolean): void
    now(): number
}

export interface ChunkedJobOptions {
    batchSize: number
    budgetMs: number
}

export interface ChunkedJobResult {
    processed: number
    failed: number
    done: boolean
    cursor: string
    lastError: string
}

export function runChunked<T>(ports: ChunkedJobPorts<T>, options: ChunkedJobOptions): ChunkedJobResult {
    const started = ports.now()
    let cursor = ports.loadCursor()
    let processed = 0
    let failed = 0
    let lastError = ''

    for (;;) {
        const batch = ports.fetchBatch(cursor, options.batchSize)
        for (const record of batch) {
            const key = ports.keyOf(record)
            try {
                ports.handle(record)
                processed++
            } catch (error) {
                failed++
                lastError = `${key}: ${error instanceof Error ? error.message : String(error)}`
            }
            cursor = key
            if (ports.now() - started >= options.budgetMs) {
                ports.saveCursor(cursor, processed, false)
                return { processed, failed, done: false, cursor, lastError }
            }
        }
        if (batch.length < options.batchSize) {
            ports.saveCursor('', processed, true)
            return { processed, failed, done: true, cursor: '', lastError }
        }
    }
}
