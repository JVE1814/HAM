import { GlideDateTime, GlideRecord } from '@servicenow/glide'
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
import { log } from './log.ts'
import { deleteWhere, exists, refusal, str } from './records.ts'

/** Job locks (ADR 0013): a row per lock held, behind a unique index, so taking a lock is one insert only one holder wins. */
const LOCK_TABLE = 'x_daas_ham_job_lock'

const LOCK_ROWS: LockPorts = {
    take,
    release,
    held: (lockId) => new GlideRecord(LOCK_TABLE).get(lockId),
    log: (level, message) => log[level](message),
}

/** What became of work to run under a lock: it ran and returned `value`, or other holders kept the lock. */
export type LockRun<T> = { ran: true; value: T } | { ran: false }

/** What a holder does under its lock (domain/job-lock `attemptUnderLock` says when it returns TRY_AGAIN). */
type Work<T> = (lock: HeldLock) => T | TryAgain

/**
 * Run `work` holding the lock `name` and give what it returned, or `ran: false` at once when
 * another holder has the lock. Throws when the lock cannot be taken for another reason (the insert is refused while no
 * lock row exists); `work`'s own errors escape. Not reentrant: a lock is one row, not a count of takes, so a nested
 * take of `name` (inside `work`, or anywhere in the same transaction while it is held) finds it held and does not run.
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

/**
 * Whether a holder has the lock `name` now: a cheap probe only, since taking the lock is what decides. A lock taken as
 * abandoned does not count, so its caller goes on to a take, which clears it.
 */
export function isLocked(name: string): boolean {
    return exists(LOCK_TABLE, `name=${name}^sys_created_on>=${abandonedBefore()}`)
}

function hasLockRow(name: string): boolean {
    return exists(LOCK_TABLE, `name=${name}`)
}

function take(name: string): string | null {
    const first = insertLock(name)
    if (first.id) return first.id
    clearAbandoned(name)
    const second = insertLock(name)
    if (second.id) return second.id
    if (hasLockRow(name)) return null
    // The holder let go between the refusal and the probe: one more try, so only a refusal with no lock row throws.
    const third = insertLock(name)
    if (third.id) return third.id
    if (!hasLockRow(name)) throw new Error(`job lock ${name} could not be taken: ${third.error}`)
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

/** Clear the lock `name` when it is abandoned; one whose delete is refused is logged, as it is held until removed. */
function clearAbandoned(name: string): void {
    if (deleteWhere(LOCK_TABLE, `name=${name}^sys_created_on<${abandonedBefore()}`)) return
    log.warn(`Abandoned job lock ${name} not cleared (its delete was refused): every take finds it held until it is removed`)
}

function abandonedBefore(): string {
    const cutoff = new GlideDateTime()
    cutoff.addSeconds(-ABANDONED_AFTER_MINUTES * 60)
    return cutoff.getValue()
}

/**
 * Let the lock go. One already gone was taken as abandoned and cleared by another taker. A refused delete is logged:
 * the lock stays held, and every taker finds it so, until it is taken as abandoned (ABANDONED_AFTER_MINUTES after it
 * was taken).
 */
function release(lockId: string): void {
    const lock = new GlideRecord(LOCK_TABLE)
    if (!lock.get(lockId) || lock.deleteRecord()) return
    const held = `held until taken as abandoned, ${ABANDONED_AFTER_MINUTES} minutes after it was taken`
    log.warn(`Job lock ${str(lock, 'name')} not released: ${refusal(lock, 'the delete was refused')}; ${held}`)
}
