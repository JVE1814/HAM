import { GlideRecord } from '@servicenow/glide'
import { formatProviderTag } from '../domain/provider-tag'
import { withLock } from './locks'
import { intProperty, PROPERTY, stringProperty } from './properties'

/** The counter's row in x_daas_ham_job_cursor, and the job lock taken while advancing it. */
const SEQUENCE_JOB = 'provider_tag_sequence'

/** Tries at taking the lock before giving up: a holder keeps it for one read and one write only. */
const LOCK_ATTEMPTS = 5

/**
 * The next Provider tag, or null while other receipts held the counter through every try. A tag is a scan key, so two
 * Assets must never share one: the counter is read and advanced under a job lock, its first row created there too.
 *
 * Taking the lock also throws when the holder lets go between refusing this taker and the check that it still holds
 * the lock; that try counts as refused too. Only when every try throws is the lock itself broken, and that error
 * escapes, as does a failure to save the counter.
 */
export function nextProviderTag(): string | null {
    let refused = false
    let takeError: unknown = null
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
        let sequence = 0
        let counted = false
        try {
            let lost = false
            const taken = withLock(SEQUENCE_JOB, (lock) => {
                counted = true
                sequence = advanceCounter()
                // A holder that outlasted the lock may share its number with the next holder: that number is not used.
                lost = !lock.held()
            })
            if (taken && !lost) return formatProviderTag(stringProperty(PROPERTY.tagPrefix, 'NAAS'), sequence, intProperty(PROPERTY.tagDigits, 7))
            refused = true
        } catch (error) {
            if (counted) throw error
            takeError = error
        }
    }
    if (!refused && takeError) throw takeError
    return null
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
