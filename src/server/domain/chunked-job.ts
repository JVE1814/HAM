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
    /** Save where the run got to; `failures` are the records of this run that failed and the last error. */
    saveCursor(cursor: string, processed: number, done: boolean, failures: Failures): void
    now(): number
}

export interface ChunkedJobOptions {
    /** Records fetched per batch; a size below 1 (a misset property) counts as 1, since a batch of none would never reach the end. */
    batchSize: number
    /** How long a run may take: it pauses once this is spent, though never before handling one record, so even a budget of 0 gets through. */
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
    const batchSize = Math.max(1, Math.floor(options.batchSize) || 1)

    for (;;) {
        const batch = ports.fetchBatch(cursor, batchSize)
        for (const record of batch) {
            const key = ports.keyOf(record)
            try {
                ports.handle(record)
                processed++
            } catch (error) {
                failed++
                lastError = `${key}: ${messageOf(error)}`
            }
            cursor = key
            if (ports.now() - started >= options.budgetMs) {
                ports.saveCursor(cursor, processed, false, { failed, lastError })
                return { processed, failed, done: false, cursor, lastError }
            }
        }
        if (batch.length < batchSize) {
            ports.saveCursor('', processed, true, { failed, lastError })
            return { processed, failed, done: true, cursor: '', lastError }
        }
    }
}

/** Records of a pass, or of one run or chunk of it, that failed, with the last error ('' when none did). */
export interface Failures {
    failed: number
    lastError: string
}

/** What a scheduled job's cursor says once a run of its pass saved it: the pass's failures so far, and its status. */
export interface CursorReport extends Failures {
    status: string
}

/**
 * What a scheduled job's cursor says once a run saved it (ADR 0007). A pass may take several runs, each ending on its
 * time budget, so the failures counted are the pass's: those the cursor holds from its earlier runs (`stored`) and the
 * run's own, unless the run started a fresh pass (`resumed` false), which drops what the last pass left. The status
 * reads *complete* only for a pass that reached the end with no record failed.
 */
export function cursorReport(stored: Failures, run: Failures & { resumed: boolean; done: boolean }): CursorReport {
    const failed = (run.resumed ? stored.failed : 0) + run.failed
    const lastError = run.lastError || (run.resumed && failed > 0 ? stored.lastError : '')
    const failedText = `${failed} failed record(s)`
    if (run.done) return { failed, lastError, status: failed > 0 ? `complete with ${failedText}` : 'complete' }
    return { failed, lastError, status: failed > 0 ? `paused (time budget), ${failedText} so far` : 'paused (time budget)' }
}

/** A write that lost its job's lock: a taker that judged the lock abandoned cleared it while the write ran. */
export interface LockLost {
    outcome: 'lost'
    /** What the write threw after losing the lock ('' when it finished), so that it is not lost with it. */
    error: string
}

/** What became of a chunk's write under its job's lock. */
export type ChunkWrite = { outcome: 'written' | 'superseded' } | LockLost

/** What a chunk of a superseding pass does while it holds its job's lock (ADR 0013). */
export interface LockedChunkPorts {
    /** Whether the chunk's pass is still its job's current one. */
    isCurrent(): boolean
    /** Whether the chunk still holds the job's lock: a taker that judged it abandoned may have cleared it. */
    held(): boolean
    /** Write out what the chunk accumulated. */
    flush(): void
    /** Queue the pass's next chunk. */
    queueNext(): void
    /** Complete the pass (after its last chunk only). */
    complete(): void
}

/**
 * Write a chunk of a superseding pass under its job's lock: flush, then queue the next chunk or, after
 * the last one, complete the pass. A chunk whose pass was superseded writes nothing, and one that lost
 * the lock during a write writes nothing more.
 */
export function writeChunkUnderLock(ports: LockedChunkPorts, last: boolean): ChunkWrite {
    if (!ports.isCurrent()) return { outcome: 'superseded' }
    const held = () => ports.held()
    const lostInFlush = writeHoldingLock(held, () => ports.flush())
    if (lostInFlush) return lostInFlush
    if (!last) {
        ports.queueNext()
        return { outcome: 'written' }
    }
    return writeHoldingLock(held, () => ports.complete()) ?? { outcome: 'written' }
}

/**
 * Make a write under a job's lock and check that it held the lock throughout: null when it did. A taker
 * that judges the lock abandoned clears it even from a holder still writing, and what that holder wrote
 * may then sit beside a fresh pass's, so a write that lost the lock gives LockLost even when it threw:
 * only another fresh pass clears both. A write that throws while still holding the lock throws on, so
 * its pass stops as on any other error.
 */
export function writeHoldingLock(held: () => boolean, write: () => void): LockLost | null {
    try {
        write()
    } catch (error) {
        if (held()) throw error
        return { outcome: 'lost', error: messageOf(error) }
    }
    return held() ? null : { outcome: 'lost', error: '' }
}

/** What a record or write threw, as text. */
function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
