import { GlideRecord } from '@servicenow/glide'
import { anyOf } from '../domain/encoded-query.ts'
import { LOCK } from '../domain/lock-names.ts'
import { EXCEPTION_DETAIL_MAX_LENGTH, OPEN_EXCEPTIONS_QUERY } from '../domain/reconciliation.ts'
import { nowGlide } from './clock.ts'
import { withLockTries } from './locks.ts'
import { exists, pluck, str, warnRefused } from './records.ts'
import { EXCEPTION_STATUS, type ExceptionType } from '../domain/vocabulary.ts'

/** Reconciliation exceptions: at most one open exception per type and asset (or CI, such as a rack). */

const TABLE = 'x_daas_ham_recon_exception'

/** What an exception is about: an Asset, or a CI such as a rack. */
export type ExceptionSubject = { assetId: string } | { ciId: string }

/** The subject as the exception's field and its sys_id. */
function fieldOf(subject: ExceptionSubject): { field: 'asset' | 'ci'; id: string } {
    return 'assetId' in subject ? { field: 'asset', id: subject.assetId } : { field: 'ci', id: subject.ciId }
}

interface ExceptionFacts {
    customerId: string
    detail: string
}

/** One exception a check found: its type and what to say of it. */
export interface FoundException {
    type: ExceptionType
    detail: string
}

/**
 * What came of a raise: an exception of its type is `open` for the subject (opened now or before), the platform
 * `refused` the insert (logged), or other holders kept its lock through every try and none is open yet (`busy`).
 */
export type ExceptionRaise = 'open' | 'refused' | 'busy'

/**
 * Open an exception of `type` for the subject unless one is already open. Two runs (an overlapping reconciliation, two
 * audits closing at once) may raise the same one, and a unique index cannot allow closed duplicates beside the open
 * one, so the check and the insert are made under a lock on the type and subject, re-checking there. A run that finds
 * the lock held through every try (a holder keeps it for one read and one insert) leaves the exception to the holder,
 * which is raising it, and reads once more whether it is open. Taking the lock throws only when an insert is refused
 * with no lock row (platform/locks `withLockTries` tries again, and that error escapes only when every try threw), as
 * does an error from the insert.
 */
export function openException(type: ExceptionType, subject: ExceptionSubject, facts: ExceptionFacts): ExceptionRaise {
    // Most calls find the exception already open from an earlier run: those need no lock.
    if (hasOpenException(type, subject)) return 'open'
    const run = withLockTries(LOCK.reconException(type, fieldOf(subject).id), () =>
        hasOpenException(type, subject) || insertException(type, subject, facts) ? 'open' : 'refused',
    )
    if (run.ran) return run.value
    return hasOpenException(type, subject) ? 'open' : 'busy'
}

function hasOpenException(type: ExceptionType, subject: ExceptionSubject): boolean {
    const { field, id } = fieldOf(subject)
    return exists(TABLE, `exception_type=${type}^${OPEN_EXCEPTIONS_QUERY}^${field}=${id}`)
}

function insertException(type: ExceptionType, subject: ExceptionSubject, facts: ExceptionFacts): boolean {
    const { field, id } = fieldOf(subject)
    const exception = new GlideRecord(TABLE)
    exception.initialize()
    exception.setValue('exception_type', type)
    exception.setValue('asset', field === 'asset' ? id : '')
    exception.setValue('ci', field === 'ci' ? id : '')
    exception.setValue('customer', facts.customerId)
    exception.setValue('detail', facts.detail.slice(0, EXCEPTION_DETAIL_MAX_LENGTH))
    exception.setValue('detected_at', nowGlide())
    // An audit or attestation is closed once and does not raise it again, so a refused one is logged, not lost.
    if (exception.insert()) return true
    warnRefused(exception, `No ${type} exception for ${id} (${facts.detail})`)
    return false
}

/**
 * What a check of one subject comes to: open each exception it `found`, and resolve the subject's open ones of the
 * other `types` the check covers, which no longer apply.
 */
export function settleExceptions(subject: ExceptionSubject, customerId: string, types: readonly ExceptionType[], found: readonly FoundException[]): void {
    for (const { type, detail } of found) openException(type, subject, { customerId, detail })
    resolveExceptions(subject, types.filter((type) => !found.some((exception) => exception.type === type)))
}

/**
 * Resolve the subject's open exceptions of the given types that no longer apply. A blank subject would match every
 * exception of the other kind, so it resolves nothing. One the platform refuses to resolve stays open and is logged;
 * the next check that finds it cleared tries again.
 */
export function resolveExceptions(subject: ExceptionSubject, types: readonly ExceptionType[]): void {
    const { field, id } = fieldOf(subject)
    const ofTypes = anyOf('exception_type', types)
    if (!id || !ofTypes) return
    const exception = new GlideRecord(TABLE)
    exception.addQuery(field, id)
    exception.addEncodedQuery(`${OPEN_EXCEPTIONS_QUERY}^${ofTypes}`)
    resolveEach(exception)
}

/**
 * Resolve the open exceptions an encoded query matches (domain/reconciliation builds it), such as those on Assets the
 * reconciliation no longer checks. A blank query would resolve every exception, so it resolves nothing. One the
 * platform refuses to resolve stays open and is logged.
 */
export function resolveExceptionsWhere(encodedQuery: string): void {
    if (!encodedQuery) return
    const exception = new GlideRecord(TABLE)
    exception.addEncodedQuery(encodedQuery)
    resolveEach(exception)
}

function resolveEach(exception: GlideRecord): void {
    exception.query()
    while (exception.next()) {
        exception.setValue('status', EXCEPTION_STATUS.resolved)
        if (exception.update()) continue
        const subjectId = str(exception, 'asset') || str(exception, 'ci')
        warnRefused(exception, `${str(exception, 'exception_type')} exception for ${subjectId} not resolved`)
    }
}

/** The CIs (racks, network gear) with an open exception of one of `types`, each once. */
export function cisWithOpenException(types: readonly ExceptionType[]): string[] {
    return [...new Set(pluck(TABLE, `${OPEN_EXCEPTIONS_QUERY}^exception_typeIN${types.join(',')}^ciISNOTEMPTY`, 'ci'))]
}
