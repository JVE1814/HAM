import { GlideDateTime, GlideRecord, gs } from '@servicenow/glide'
import { messageOf } from '../domain/errors.ts'
import {
    ABANDONED_AFTER_MINUTES,
    attemptUnderLock,
    LOCK_TRIES,
    type HeldLock,
    type LockAttempt,
    type LockPorts,
    type TryAgain,
} from '../domain/job-lock.ts'
import { exists, refusal } from './records.ts'

/** Job locks (ADR 0013): a row per lock held, behind a unique index, so taking a lock is one insert only one holder wins. */
const LOCK_TABLE = 'x_daas_ham_job_lock'

const LOCK_ROWS: LockPorts = {
    take,
    release,
    held: (lockId) => new GlideRecord(LOCK_TABLE).get(lockId),
    log: (level, message) => (level === 'error' ? gs.error(`[x_daas_ham] ${message}`) : gs.warn(`[x_daas_ham] ${message}`)),
}

/** What became of work to run under a lock: it ran and returned `value`, or other holders kept the lock. */
export type LockRun<T> = { ran: true; value: T } | { ran: false }

/** What a holder does under its lock (domain/job-lock `attemptUnderLock` says when it returns TRY_AGAIN). */
type Work<T> = (lock: HeldLock) => T | TryAgain

/**
 * Run `work` holding the lock `name` (domain/lock-names `LOCK`) and give what it returned, or `ran: false` at once when
 * another holder has the lock. Throws when the lock cannot be taken for another reason (the insert is refused while no
 * lock row exists); `work`'s own errors escape.
 */
export function withLock<T>(name: string, work: Work<T>): LockRun<T> {
    return withLockTries(name, work, 1)
}

/**
 * `withLock` tried up to `tries` times, back to back, while other holders have the lock: `ran: false` when it was held
 * through every try. A take that throws is tried again too, and its error escapes only when no try found the lock held.
 */
export function withLockTries<T>(name: string, work: Work<T>, tries = LOCK_TRIES): LockRun<T> {
    const attempt = attemptLock(name, work, tries)
    if (!attempt.ran && !attempt.held) throw attempt.error
    return attempt
}

/**
 * `withLockTries` for a caller that reports a lock that could not be taken instead of throwing: `held: false` with
 * what the take threw. `work`'s own errors still escape.
 */
export function attemptLock<T>(name: string, work: Work<T>, tries = LOCK_TRIES): LockAttempt<T> {
    return attemptUnderLock(LOCK_ROWS, name, tries, work)
}

/**
 * Why an attempt that did not run did not, for its caller to log or tell: `held` (who has the lock, in the caller's
 * words) when other holders kept it through every try, else what taking it threw.
 */
export function whyNotRun(attempt: Exclude<LockAttempt<unknown>, { ran: true }>, held: string): string {
    return attempt.held ? held : messageOf(attempt.error)
}

/** Whether a holder has the lock `name` now: a cheap probe only, since taking the lock is what decides. */
export function isLocked(name: string): boolean {
    return exists(LOCK_TABLE, `name=${name}`)
}

function take(name: string): string | null {
    const first = insertLock(name)
    if (first.id) return first.id
    clearAbandoned(name)
    const second = insertLock(name)
    if (second.id) return second.id
    if (isLocked(name)) return null
    // The holder let go between the refusal and the probe: one more try, so only a refusal with no lock row throws.
    const third = insertLock(name)
    if (third.id) return third.id
    if (!isLocked(name)) throw new Error(`job lock ${name} could not be taken: ${third.error}`)
    return null
}

/** The new lock row's sys_id, or none (and why) when the insert is refused: by the unique index while the lock is held. */
function insertLock(name: string): { id: string | null; error: string } {
    const lock = new GlideRecord(LOCK_TABLE)
    lock.initialize()
    lock.setValue('name', name)
    const id = lock.insert()
    return { id: id || null, error: id ? '' : refusal(lock) }
}

function clearAbandoned(name: string): void {
    const cutoff = new GlideDateTime()
    cutoff.addSeconds(-ABANDONED_AFTER_MINUTES * 60)
    const lock = new GlideRecord(LOCK_TABLE)
    lock.addQuery('name', name)
    lock.addQuery('sys_created_on', '<', cutoff.getValue())
    lock.deleteMultiple()
}

function release(lockId: string): void {
    const lock = new GlideRecord(LOCK_TABLE)
    // A refused delete is not checked: the row is then cleared as an abandoned one, by the next taker past that time.
    if (lock.get(lockId)) lock.deleteRecord()
}
