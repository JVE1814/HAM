/**
 * Job locks (ADR 0013), the part that needs no platform: how a take is tried again, what a holder does with the lock it
 * holds, and the numbers the retries share.
 */

/**
 * A lock held this long is taken as abandoned (its holder's transaction died) and cleared by the next taker. A holder
 * still running is not stopped, so one whose writes must not overlap the next holder's makes them through its
 * `HeldLock`.
 */
export const ABANDONED_AFTER_MINUTES = 10

/** Tries, back to back, at a lock its holders keep for a read or two and a save. */
export const LOCK_TRIES = 5

/** Tries, back to back, at a lock a holder keeps through several saves and their rules (a receipt, a go-live, a purchase). */
export const LONG_HOLD_LOCK_TRIES = 10

/**
 * A request that cannot wait back to back (it finds its lock held, or lost it) is queued again `delaySeconds` later,
 * `times` at most. Together they outlast the abandonment time (job-lock.test.ts), so a lock left by a dead holder is
 * cleared before the request is dropped: one still held by then was taken after the request was queued.
 */
export const REQUEUE = { delaySeconds: 60, times: 15 } as const

export const TRY_AGAIN = { tryAgain: true } as const

export type TryAgain = typeof TRY_AGAIN

/** How a save made after its lock was lost is logged: what to check, and as an error where a warning is too little. */
export interface LateSave {
    check?: string
    level?: 'warn' | 'error'
}

export type HeldWrite<T> = { written: false } | { written: true; value: T; lockLost: boolean }

export type LockedSave = 'saved' | 'refused' | 'lock lost'

/**
 * A lock being held. A holder that outlasts the abandonment time may have lost it to a taker, and what it saves then
 * overlaps what that taker saves; no write can be tied to the lock in a transaction, so a holder checks around its writes.
 */
export interface HeldLock {
    held(): boolean
    /**
     * Make `write` only while the lock is still held, and say whether it was lost while `write` ran. For a holder with
     * its own answer to a write that overlapped; what `write` throws escapes.
     */
    write<T>(write: () => T): HeldWrite<T>
    /**
     * Make one save (`save` returns nothing when the platform refuses it, as a record's update and insert do) only while
     * the lock is still held: 'lock lost' when it is not, and nothing is saved; 'refused' for the caller to report;
     * 'saved' otherwise, logged as `done` after its lock was lost when the lock went during the save (`lostAfter`).
     */
    save(done: string, save: () => unknown, late?: LateSave): LockedSave
    /**
     * Whether the lock is lost now that `done` is saved, logged if so: the holder that took it over may have saved the
     * same. For a holder whose check before the save sits elsewhere, or that saves whether it holds the lock or not.
     */
    lostAfter(done: string, late?: LateSave): boolean
}

export type LockAttempt<T> = { ran: true; value: T } | { ran: false; held: true } | { ran: false; held: false; error: unknown }

export interface LockPorts {
    /** Take the lock `name`: its id, or null while another holder has it. Throws when it cannot be taken for another reason. */
    take(name: string): string | null
    release(lockId: string): void
    held(lockId: string): boolean
    log(level: 'warn' | 'error', message: string): void
}

/**
 * Run `work` holding the lock `name`, trying up to `tries` times, back to back, while other holders have it. A take
 * that throws is tried again too, and is reported (`held: false`, with what the last one threw) only when no try found
 * the lock held; `work`'s own errors escape at once, the lock released. `work` runs once, unless it returns TRY_AGAIN
 * to give its try up, having lost the lock before its result could be used: that try counts as held, and the next runs
 * `work` again. Only `work` that may safely run twice returns it.
 */
export function attemptUnderLock<T>(
    ports: LockPorts,
    name: string,
    tries: number,
    work: (lock: HeldLock) => T | TryAgain,
): LockAttempt<T> {
    let held = false
    let takeError: { thrown: unknown } | null = null
    for (let attempt = 0; attempt < tries; attempt++) {
        let lockId: string | null
        try {
            lockId = ports.take(name)
        } catch (error) {
            takeError = { thrown: error }
            continue
        }
        held = true
        if (!lockId) continue
        let value: T | TryAgain
        try {
            value = work(heldLock(ports, name, lockId))
        } finally {
            ports.release(lockId)
        }
        if (value !== TRY_AGAIN) return { ran: true, value: value as T }
    }
    if (!held && takeError) return { ran: false, held: false, error: takeError.thrown }
    return { ran: false, held: true }
}

function heldLock(ports: LockPorts, name: string, lockId: string): HeldLock {
    const held = () => ports.held(lockId)
    const logLate = (done: string, late: LateSave = {}) => {
        const check = late.check ?? 'check what the holder that took it over did meanwhile'
        ports.log(late.level ?? 'warn', `${done} after its lock ${name} was lost: ${check}`)
    }
    const write = <T>(make: () => T): HeldWrite<T> => {
        if (!held()) return { written: false }
        const made = writeHoldingLock(held, make)
        if (made.lock === 'lost' && made.threw) throw made.error
        return { written: true, value: made.value, lockLost: made.lock === 'lost' }
    }
    return {
        held,
        write,
        save: (done, save, late) => {
            const made = write(save)
            if (!made.written) return 'lock lost'
            if (!made.value) return 'refused'
            if (made.lockLost) logLate(done, late)
            return 'saved'
        },
        lostAfter: (done, late) => {
            if (held()) return false
            logLate(done, late)
            return true
        },
    }
}

export type LockedWrite<T> =
    | { lock: 'held'; value: T }
    | { lock: 'lost'; threw: false; value: T }
    | { lock: 'lost'; threw: true; error: unknown }

/**
 * Make a write under a lock and check that the lock was held throughout. A taker that judges the lock abandoned clears
 * it even from a holder still writing, and what that holder wrote may then sit beside the taker's, so a write that lost
 * the lock is reported as lost even when it threw. A write that throws while still holding the lock throws on.
 */
export function writeHoldingLock<T>(held: () => boolean, write: () => T): LockedWrite<T> {
    let value: T
    try {
        value = write()
    } catch (error) {
        if (held()) throw error
        return { lock: 'lost', threw: true, error }
    }
    return held() ? { lock: 'held', value } : { lock: 'lost', threw: false, value }
}
