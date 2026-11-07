import { GlideRecord } from '@servicenow/glide'
import { deleteWhere } from './records'

/** Job locks (ADR 0013): a row per lock held, behind a unique index, so taking a lock is one insert only one holder wins. */
const LOCK = 'x_daas_ham_job_lock'

/** A lock held this long is taken as abandoned: its holder's transaction died before releasing it. */
const ABANDONED_AFTER_MINUTES = 10

/** Run `work` holding the lock `name` and return true, or return false at once when another holder has it. */
export function withLock(name: string, work: () => void): boolean {
    const lockId = take(name)
    if (!lockId) return false
    try {
        work()
    } finally {
        release(lockId)
    }
    return true
}

function take(name: string): string | null {
    const lockId = insertLock(name)
    if (lockId) return lockId
    deleteWhere(LOCK, `name=${name}^sys_created_on<javascript:gs.minutesAgoStart(${ABANDONED_AFTER_MINUTES})`)
    return insertLock(name)
}

/** The new lock row's sys_id, or null when the unique index refuses it (the lock is held). */
function insertLock(name: string): string | null {
    const lock = new GlideRecord(LOCK)
    lock.initialize()
    lock.setValue('name', name)
    return lock.insert() || null
}

function release(lockId: string): void {
    const lock = new GlideRecord(LOCK)
    if (lock.get(lockId)) lock.deleteRecord()
}
