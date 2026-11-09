import { GlideRecord } from '@servicenow/glide'
import { formatProviderTag, nextFreeSequence } from '../domain/provider-tag.ts'
import { beyondVisibility } from './beyond-visibility.ts'
import { type HeldLock, withLockTries } from './locks.ts'
import { intProperty, PROPERTY, stringProperty } from './properties.ts'
import { refusal } from './records.ts'

/** The counter's row in x_daas_ham_job_cursor, and the job lock taken while advancing it. */
const SEQUENCE_JOB = 'provider_tag_sequence'

/** Tries at taking the lock before giving up: a holder keeps it for one read, an Asset check per number and one write. */
const LOCK_ATTEMPTS = 5

/**
 * The next Provider tag, or null while other receipts held the counter through every try. A tag is a scan key, so two
 * Assets must never share one: the counter is read and advanced under a job lock, its first row created there too.
 * A holder that outlasted the lock (ADR 0013) and saved a stale number sets the counter back, so a number whose tag an
 * Asset already carries is skipped, and a holder that lost the lock before or while writing gives its number up. What
 * is left is a tag issued but not yet saved on its Asset when a write that ran past the ten minutes sets the counter
 * back, and taken again before that save.
 * Taking the lock throws only when an insert is refused with no lock row (platform/locks `withLockTries` tries again,
 * and that error escapes only when every try threw), as does a failure to save the counter.
 */
export function nextProviderTag(): string | null {
    const prefix = stringProperty(PROPERTY.tagPrefix, 'NAAS')
    const digits = intProperty(PROPERTY.tagDigits, 7)
    const tagOf = (sequence: number) => formatProviderTag(prefix, sequence, digits)
    // Set inside the lock.
    let tag = ''
    const counted = withLockTries(SEQUENCE_JOB, LOCK_ATTEMPTS, (lock) => {
        const sequence = advanceCounter(lock, (next) => onAsset(tagOf(next)))
        if (sequence === null) return false
        tag = tagOf(sequence)
        // A holder that lost the lock while writing may share its number with the next holder: that number is not used.
        return lock.held()
    })
    return counted ? tag : null
}

/**
 * Take the next free number from the counter (the first is 1) holding `lock`, or null, writing nothing, once the lock
 * was lost before the write: the next holder may have advanced the counter since this one read it.
 */
function advanceCounter(lock: HeldLock, taken: (sequence: number) => boolean): number | null {
    const counter = new GlideRecord('x_daas_ham_job_cursor')
    const found = counter.get('job', SEQUENCE_JOB)
    if (!found) {
        counter.initialize()
        counter.setValue('job', SEQUENCE_JOB)
    }
    const next = nextFreeSequence(parseInt(String(counter.getValue('cursor') ?? '0'), 10) || 0, taken)
    if (!lock.held()) return null
    counter.setValue('cursor', String(next))
    if (!(found ? counter.update() : counter.insert())) throw new Error(`Provider tag counter could not be saved: ${refusal(counter)}`)
    return next
}

/**
 * Whether an Asset of any class carries `tag`, read past the app's visibility rules (ADR 0005, platform/beyond-visibility):
 * a tag is unique across them all. The app's scope rule is on alm_hardware and does not run for this alm_asset query;
 * the mark keeps the read whole should one be added here.
 */
function onAsset(tag: string): boolean {
    const asset = new GlideRecord('alm_asset')
    asset.addQuery('asset_tag', tag)
    asset.setLimit(1)
    beyondVisibility(asset, () => asset.query())
    return asset.hasNext()
}
