import { GlideRecord } from '@servicenow/glide'
import { TRY_AGAIN, type HeldLock } from '../domain/job-lock.ts'
import { LOCK } from '../domain/lock-names.ts'
import { PROPERTY } from '../domain/properties.ts'
import { formatProviderTag, nextFreeSequence } from '../domain/provider-tag.ts'
import { beyondVisibility } from './beyond-visibility.ts'
import { openJobCursor } from './job-cursor.ts'
import { withLockTries } from './locks.ts'
import { intProperty, stringProperty } from './properties.ts'

/** The counter's row among the job cursors (platform/job-cursor), which holds the last number issued. */
const SEQUENCE_JOB = 'provider_tag_sequence'

/**
 * The next Provider tag, or null while other receipts held the counter through every try (a holder keeps it for one
 * read, an Asset check per number and one write). A tag is a scan key, so two Assets must never share one: the counter
 * is read and advanced under a job lock, its first row created there too.
 * A holder that outlasted the lock (ADR 0013) and saved a stale number sets the counter back, so a number whose tag an
 * Asset already carries is skipped, and a holder that lost the lock before or while writing gives its number up. What
 * is left is a tag issued but not yet saved on its Asset when a write that ran past the ten minutes sets the counter
 * back, and taken again before that save.
 * Taking the lock throws only when an insert is refused with no lock row (platform/locks `withLockTries` tries again,
 * and that error escapes only when every try threw), as does a failure to save the counter.
 */
export function nextProviderTag(): string | null {
    const prefix = stringProperty(PROPERTY.tagPrefix)
    const digits = intProperty(PROPERTY.tagDigits)
    const tagOf = (sequence: number) => formatProviderTag(prefix, sequence, digits)
    const counted = withLockTries(LOCK.providerTagSequence(), (lock) => {
        const sequence = advanceCounter(lock, (next) => onAsset(tagOf(next)))
        return sequence === null ? TRY_AGAIN : tagOf(sequence)
    })
    return counted.ran ? counted.value : null
}

/**
 * Take the next free number from the counter (the first is 1) holding `lock`, or null once the lock was lost: before
 * the write, which is then not made (the next holder may have advanced the counter since this one read it), or while
 * writing (the next holder may share the number, so it is not used).
 */
function advanceCounter(lock: HeldLock, taken: (sequence: number) => boolean): number | null {
    // Its first row is created empty, which reads as no number issued, as no row does.
    const counter = openJobCursor(SEQUENCE_JOB)
    const next = nextFreeSequence(parseInt(counter.cursor, 10) || 0, taken)
    const saved = lock.write(() => {
        const refused = counter.save({ cursor: String(next) })
        if (refused) throw new Error(`Provider tag counter could not be saved: ${refused}`)
    })
    return saved.written && !saved.lockLost ? next : null
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
