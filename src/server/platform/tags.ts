import { GlideRecord } from '@servicenow/glide'
import { formatProviderTag } from '../domain/provider-tag'
import { withLockTries } from './locks'
import { intProperty, PROPERTY, stringProperty } from './properties'

/** The counter's row in x_daas_ham_job_cursor, and the job lock taken while advancing it. */
const SEQUENCE_JOB = 'provider_tag_sequence'

/** Tries at taking the lock before giving up: a holder keeps it for one read and one write only. */
const LOCK_ATTEMPTS = 5

/**
 * The next Provider tag, or null while other receipts held the counter through every try. A tag is a scan key, so two
 * Assets must never share one: the counter is read and advanced under a job lock, its first row created there too.
 * Taking the lock throws only when an insert is refused with no lock row (platform/locks `withLockTries` tries again,
 * and that error escapes only when every try threw), as does a failure to save the counter.
 */
export function nextProviderTag(): string | null {
    // Set inside the lock.
    let sequence = 0
    const counted = withLockTries(SEQUENCE_JOB, LOCK_ATTEMPTS, (lock) => {
        sequence = advanceCounter()
        // A holder that outlasted the lock may share its number with the next holder: that number is not used.
        return lock.held()
    })
    if (!counted) return null
    return formatProviderTag(stringProperty(PROPERTY.tagPrefix, 'NAAS'), sequence, intProperty(PROPERTY.tagDigits, 7))
}

/** Take the next number from the counter (the first is 1). The caller holds the lock. */
function advanceCounter(): number {
    const counter = new GlideRecord('x_daas_ham_job_cursor')
    const found = counter.get('job', SEQUENCE_JOB)
    if (!found) {
        counter.initialize()
        counter.setValue('job', SEQUENCE_JOB)
    }
    const next = (parseInt(String(counter.getValue('cursor') ?? '0'), 10) || 0) + 1
    counter.setValue('cursor', String(next))
    if (!(found ? counter.update() : counter.insert())) throw new Error(`Provider tag counter could not be saved: ${counter.getLastErrorMessage()}`)
    return next
}
