import { GlideDateTime, GlideRecord } from '@servicenow/glide'
import { exists } from './records'

/** Job locks (ADR 0013): a row per lock held, behind a unique index, so taking a lock is one insert only one holder wins. */
const LOCK = 'x_daas_ham_job_lock'

/**
 * A lock held this long is taken as abandoned (its holder's transaction died) and cleared by the next taker. A holder
 * still running is not stopped, so one whose writes must not overlap the next holder's checks `held()` after each write
 * and when one throws.
 */
const ABANDONED_AFTER_MINUTES = 10

/** A lock being held: `held()` says whether it still is (a holder past the abandonment time may have lost it). */
export interface HeldLock {
    held(): boolean
}

/**
 * Run `work` holding the lock `name` and return true, or return false at once when another holder has it.
 * Throws when the lock cannot be taken for another reason (the insert is refused while no lock row exists).
 */
export function withLock(name: string, work: (lock: HeldLock) => void): boolean {
    const lockId = take(name)
    if (!lockId) return false
    try {
        work({ held: () => new GlideRecord(LOCK).get(lockId) })
    } finally {
        release(lockId)
    }
    return true
}

/** Whether a holder has the lock `name` now: a cheap probe only, since taking the lock is what decides. */
export function isLocked(name: string): boolean {
    return exists(LOCK, `name=${name}`)
}

function take(name: string): string | null {
    const first = insertLock(name)
    if (first.id) return first.id
    clearAbandoned(name)
    const second = insertLock(name)
    if (second.id) return second.id
    if (!isLocked(name)) throw new Error(`job lock ${name} could not be taken: ${second.error || 'insert refused'}`)
    return null
}

/** The new lock row's sys_id, or none (and why) when the insert is refused: by the unique index while the lock is held. */
function insertLock(name: string): { id: string | null; error: string } {
    const lock = new GlideRecord(LOCK)
    lock.initialize()
    lock.setValue('name', name)
    const id = lock.insert()
    return { id: id || null, error: id ? '' : lock.getLastErrorMessage() }
}

function clearAbandoned(name: string): void {
    const cutoff = new GlideDateTime()
    cutoff.addSeconds(-ABANDONED_AFTER_MINUTES * 60)
    const lock = new GlideRecord(LOCK)
    lock.addQuery('name', name)
    lock.addQuery('sys_created_on', '<', cutoff.getValue())
    lock.deleteMultiple()
}

function release(lockId: string): void {
    const lock = new GlideRecord(LOCK)
    if (lock.get(lockId)) lock.deleteRecord()
}
