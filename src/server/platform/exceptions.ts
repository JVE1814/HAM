import { GlideRecord, gs } from '@servicenow/glide'
import { LOCK } from '../domain/lock-names.ts'
import { nowGlide } from './clock.ts'
import { withLockTries } from './locks.ts'
import { exists, pluck, refusal, str } from './records.ts'
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
 * Open an exception of `type` for the subject unless one is already open. Two runs (an overlapping reconciliation, two
 * audits closing at once) may raise the same one, and a unique index cannot allow closed duplicates beside the open
 * one, so the check and the insert are made under a lock on the type and subject, re-checking there. A run that finds
 * the lock held through every try (a holder keeps it for one read and one insert) leaves the exception to the holder,
 * which is raising it. Taking the lock throws only when an insert is refused with no lock row (platform/locks
 * `withLockTries` tries again, and that error escapes only when every try threw), as does an error from the insert.
 */
export function openException(type: ExceptionType, subject: ExceptionSubject, facts: ExceptionFacts): void {
    // Most calls find the exception already open from an earlier run: those need no lock.
    if (isOpen(type, subject)) return
    withLockTries(LOCK.reconException(type, fieldOf(subject).id), () => {
        if (!isOpen(type, subject)) insertException(type, subject, facts)
    })
}

function isOpen(type: ExceptionType, subject: ExceptionSubject): boolean {
    const { field, id } = fieldOf(subject)
    return exists(TABLE, `exception_type=${type}^status=${EXCEPTION_STATUS.open}^${field}=${id}`)
}

function insertException(type: ExceptionType, subject: ExceptionSubject, facts: ExceptionFacts): void {
    const { field, id } = fieldOf(subject)
    const exception = new GlideRecord(TABLE)
    exception.initialize()
    exception.setValue('exception_type', type)
    exception.setValue('asset', field === 'asset' ? id : '')
    exception.setValue('ci', field === 'ci' ? id : '')
    exception.setValue('customer', facts.customerId)
    exception.setValue('detail', facts.detail.slice(0, 255))
    exception.setValue('detected_at', nowGlide())
    // An audit or attestation is closed once and does not raise it again, so a refused one is logged, not lost.
    if (exception.insert()) return
    gs.warn(`[x_daas_ham] No ${type} exception for ${id} (${facts.detail}): ${refusal(exception)}`)
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
    if (!id || types.length === 0) return
    const exception = new GlideRecord(TABLE)
    exception.addQuery(field, id)
    exception.addQuery('status', EXCEPTION_STATUS.open)
    exception.addQuery('exception_type', 'IN', types.join(','))
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
        exception.setValue('status', 'resolved')
        if (exception.update()) continue
        const subjectId = str(exception, 'asset') || str(exception, 'ci')
        gs.warn(`[x_daas_ham] ${str(exception, 'exception_type')} exception for ${subjectId} not resolved: ${refusal(exception)}`)
    }
}

/** The CIs (racks, network gear) with an open exception of one of `types`, each once. */
export function cisWithOpenException(types: readonly ExceptionType[]): string[] {
    return [...new Set(pluck(TABLE, `status=${EXCEPTION_STATUS.open}^exception_typeIN${types.join(',')}^ciISNOTEMPTY`, 'ci'))]
}
