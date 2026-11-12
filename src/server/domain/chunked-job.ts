import { messageOf } from './errors.ts'
import { writeHoldingLock, type LockedWrite } from './job-lock.ts'

/**
 * Every job's row name in x_daas_ham_job_cursor, whose unique `job` column keys one row per job: two jobs given one
 * name share a row. Installed instances hold these rows, so a name stays as it is.
 */
export const JOB = {
    normalizeRawModels: 'normalize_raw_models',
    inServiceDetection: 'in_service_detection',
    chaseOverdueReturns: 'chase_overdue_returns',
    reconcileInstalledBase: 'reconcile_installed_base',
    sparePoolTopUp: 'spare_pool_top_up',
    providerTagSequence: 'provider_tag_sequence',
    oemClaimStranded: 'oem_claim_stranded',
    preflight: 'preflight',
    margin: (periodId: string) => `margin_${periodId}`,
    billingGenerate: (periodId: string) => `billing_generate_${periodId}`,
} as const

/** The length of a Job cursor's Last status, which `save` cuts a status to. */
export const JOB_STATUS_LENGTH = 255

/** What a job's `last_status` reads (the preflight check writes its result there instead). */
export const JOB_STATUS = {
    /**
     * A scheduled job's run reached the end of its pass, or a pass its runner started is complete. `cursorReport` adds
     * a pass's failed records to these two.
     */
    complete: 'complete',
    paused: 'paused (time budget)',
    /** A pass its runner started and marks complete: one still running with an old last run has stalled. */
    running: 'running',
    /** A pass started where it was triggered. Nothing marks its end on the row, so it must not read as running. */
    passStarted: 'pass started',
    /** The current pass was retired by hand, and the job has none. */
    reset: 'reset by hand',
} as const

/** The length of a Job cursor's Last error, which `save` cuts an error to. */
export const JOB_ERROR_LENGTH = 1000

/**
 * Bulk work in bounded chunks with a persistent cursor (ADR 0007).
 *
 * Records are visited in ascending key order. A run stops when its time budget is spent and saves
 * the last key it finished; the next run continues after it. When the end is reached the cursor
 * resets so the following run starts a fresh pass.
 */
export interface ChunkedJobPorts<T> {
    loadCursor(): string
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

export function usableBatchSize(configured: number): number {
    return Math.max(1, Math.floor(configured) || 1)
}

export function runChunked<T>(ports: ChunkedJobPorts<T>, options: ChunkedJobOptions): ChunkedJobResult {
    const started = ports.now()
    let cursor = ports.loadCursor()
    let processed = 0
    let failed = 0
    let lastError = ''
    const batchSize = usableBatchSize(options.batchSize)

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
    if (run.done) return { failed, lastError, status: failed > 0 ? `${JOB_STATUS.complete} with ${failedText}` : JOB_STATUS.complete }
    return { failed, lastError, status: failed > 0 ? `${JOB_STATUS.paused}, ${failedText} so far` : JOB_STATUS.paused }
}

/**
 * Where a pass of an event job got to, as each of its events carries it in parm2: `<token>:<cursor>`. The token names
 * the pass (its job's cursor row holds the current one's) and the cursor is the key of the last record the pass
 * finished, '' before its first.
 */
export interface PassPosition {
    token: string
    cursor: string
}

export function passParm(position: PassPosition): string {
    return `${position.token}:${position.cursor}`
}

/** An event's parm2 read back. One that is no `<token>:<cursor>` (the '' a fresh trigger queues, or anything else) names no pass and no cursor. */
export function readPassParm(parm2: string): PassPosition {
    const separator = parm2.indexOf(':')
    if (separator < 0) return { token: '', cursor: '' }
    return { token: parm2.slice(0, separator), cursor: parm2.slice(separator + 1) }
}

/** Whether an event's pass `token` names its job's current pass (`currentToken`, '' while the job has none). */
export function isCurrentPass(currentToken: string, token: string): boolean {
    return token !== '' && token === currentToken
}

/** A write that lost its job's lock: a taker that judged the lock abandoned cleared it while the write ran. */
export interface LockLost {
    outcome: 'lost'
    /** What the write threw after losing the lock ('' when it finished), so that it is not lost with it. */
    error: string
}

export type ChunkWrite = { outcome: 'written' | 'superseded' } | LockLost

/** What a chunk of a pass does as it writes, under its job's lock (ADR 0013). */
export interface LockedChunkPorts {
    isCurrent(): boolean
    /** Whether the chunk still holds the job's lock: a taker that judged it abandoned may have cleared it. */
    held(): boolean
    flush(): void
    queueNext(): void
    complete(): void
}

/**
 * A chunk whose pass is no longer the current one writes nothing, and one that lost its job's lock during a write
 * writes nothing more.
 */
export function writeChunkUnderLock(ports: LockedChunkPorts, last: boolean): ChunkWrite {
    if (!ports.isCurrent()) return { outcome: 'superseded' }
    const held = () => ports.held()
    const lostInFlush = lockLostIn(writeHoldingLock(held, () => ports.flush()))
    if (lostInFlush) return lostInFlush
    if (!last) {
        ports.queueNext()
        return { outcome: 'written' }
    }
    return lockLostIn(writeHoldingLock(held, () => ports.complete())) ?? { outcome: 'written' }
}

/**
 * A job's write that lost its lock (domain/job-lock `writeHoldingLock`), or null when it held the lock throughout. What
 * it wrote may sit beside a fresh pass's, even when it threw: only another fresh pass clears both. A write that throws
 * while still holding the lock throws on, so its pass stops as on any other error.
 */
export function lockLostIn(write: LockedWrite<void>): LockLost | null {
    if (write.lock === 'held') return null
    return { outcome: 'lost', error: write.threw ? messageOf(write.error) : '' }
}
