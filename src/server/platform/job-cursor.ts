import { GlideRecord } from '@servicenow/glide'
import { isCurrentPass as namesCurrentPass, JOB_ERROR_LENGTH, JOB_STATUS_LENGTH } from '../domain/chunked-job.ts'
import { nowGlide, nowMs } from './clock.ts'
import { log } from './log.ts'
import { num, refusal, str } from './records.ts'

/**
 * The rows of x_daas_ham_job_cursor (ADR 0007): one per job, behind a unique index on its name. Only this module reads
 * and writes the table. What a row's `cursor` holds depends on its job:
 * - a scheduled job (platform/chunked `runTableJob`): the key its last run stopped at, '' once a pass is complete;
 * - an event job whose passes replace each other (`margin_<period>`, `billing_generate_<period>`): the current pass's token;
 * - `provider_tag_sequence` (platform/tags): the last Provider tag number issued;
 * - `oem_claim_stranded` (platform/claim-steps): the last waiting step a claim run checked, '' once it checked them all;
 * - `preflight` (entry/preflight): nothing, its result is the row's `last_status`.
 */
const TABLE = 'x_daas_ham_job_cursor'

/** What a job's `last_status` reads (the preflight check writes its result there instead). */
export const JOB_STATUS = {
    /**
     * A scheduled job's run reached the end of its pass, or a pass its runner started is complete. A scheduled job's
     * status is worded by domain/chunked-job `cursorReport`, which adds the pass's failed records to these two.
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

/** What a save changes on a job's row; what is left out stays as it is. */
export interface JobCursorValues {
    cursor?: string
    /** Kept up to the column's length, as `lastError` is. */
    status?: string
    processed?: number
    /** The records of the pass that failed so far, over all its runs. */
    failed?: number
    /** The last error of the pass, '' when no record failed (kept up to the column's length). */
    lastError?: string
    ranNow?: boolean
}

/** A job's row as it was read. */
export interface JobCursor {
    readonly cursor: string
    /** The stored date/time of the last run, '' when there was none. */
    readonly lastRun: string
    /** A scheduled job's records that failed in its pass so far, over all its runs, and the last error ('' when none did). */
    readonly failed: number
    readonly lastError: string
    /** Save `values` on the row: null once saved, else why the platform refused. */
    save(values: JobCursorValues): string | null
}

/** The job's row as it is stored now, or null when it has none yet. */
export function findJobCursor(job: string): JobCursor | null {
    const record = find(job)
    return record && rowOf(record)
}

/** The job's row, created on first use; throws (with why) when there is none and it cannot be created. */
export function openJobCursor(job: string): JobCursor {
    const found = find(job)
    if (found) return rowOf(found)
    const created = new GlideRecord(TABLE)
    created.initialize()
    created.setValue('job', job)
    if (created.insert()) return rowOf(created)
    // Another run inserted it first (the unique index on job): go on from that run's record, never an unsaved one.
    const raced = find(job)
    if (raced) return rowOf(raced)
    throw new Error(`job cursor ${job} could not be created: ${refusal(created)}`)
}

function find(job: string): GlideRecord | null {
    const record = new GlideRecord(TABLE)
    return record.get('job', job) ? record : null
}

function rowOf(record: GlideRecord): JobCursor {
    return {
        cursor: str(record, 'cursor'),
        lastRun: str(record, 'last_run'),
        failed: num(record, 'failed_total'),
        lastError: str(record, 'last_error'),
        save: (values) => {
            if (values.cursor !== undefined) record.setValue('cursor', values.cursor)
            if (values.status !== undefined) record.setValue('last_status', values.status.slice(0, JOB_STATUS_LENGTH))
            if (values.processed !== undefined) record.setValue('processed_total', values.processed)
            if (values.failed !== undefined) record.setValue('failed_total', values.failed)
            if (values.lastError !== undefined) record.setValue('last_error', values.lastError.slice(0, JOB_ERROR_LENGTH))
            if (values.ranNow) record.setValue('last_run', nowGlide())
            return record.update() ? null : refusal(record)
        },
    }
}

/*
 * Passes that replace each other. A job's row names its current pass by a token (the pass's start time), which every
 * event of the pass carries: starting a pass makes any other pass of the job a stale
 * one, whose queued chunks find they are no longer current and write nothing.
 */

/**
 * Make a new pass the job's current one and return its token. Throws (with why) when the row cannot be created or
 * saved: that pass could never be current, so nothing may be cleared or queued for it.
 */
export function startPass(job: string, status: typeof JOB_STATUS.running | typeof JOB_STATUS.passStarted): string {
    const row = openJobCursor(job)
    const token = String(nowMs())
    const refused = row.save({ cursor: token, status, ranNow: true })
    if (refused) throw new Error(`job cursor ${job} not saved: ${refused}`)
    return token
}

/** Whether the pass `token` names is the job's current one, as stored now. No pass is, of a job without a row or once its pass was retired. */
export function isCurrentPass(job: string, token: string): boolean {
    const row = findJobCursor(job)
    return row !== null && namesCurrentPass(row.cursor, token)
}

/**
 * Mark the job's current pass complete (a pass still 'running' with an old last run has stalled). Called once the
 * pass's own completion is written, so a refusal here is only logged: thrown, it would stop a pass that completed.
 */
export function completePass(job: string): void {
    const refused = openJobCursor(job).save({ status: JOB_STATUS.complete, ranNow: true })
    if (refused) log.warn(`${job}: the pass completed, but its job cursor still reads running (as if stalled): ${refused}`)
}

/**
 * Retire the pass `row` names, by hand, leaving the job with no current pass: null once retired, else why the platform
 * refused. The row's last run is left as it was, so a chunk that starts meanwhile shows on a later read of it.
 */
export function retirePass(row: JobCursor): string | null {
    return row.save({ cursor: '', status: JOB_STATUS.reset })
}
