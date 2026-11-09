import { GlideRecord, gs } from '@servicenow/glide'
import { LOCK } from '../domain/lock-names.ts'
import { msToGlide, nowMs } from './clock.ts'
import { withLockTries } from './locks.ts'
import { refusal, str } from './records.ts'
import type { ExceptionType } from '../domain/vocabulary.ts'

/** Reconciliation exceptions: at most one open exception per type and asset (or CI, such as a rack). */

interface ExceptionSubject {
    assetId?: string
    ciId?: string
    customerId: string
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
export function openException(type: ExceptionType, subject: ExceptionSubject): void {
    // Most calls find the exception already open from an earlier run: those need no lock.
    if (isOpen(type, subject)) return
    withLockTries(LOCK.reconException(type, subject.assetId || subject.ciId || ''), () => {
        if (!isOpen(type, subject)) insertException(type, subject)
    })
}

function isOpen(type: ExceptionType, subject: ExceptionSubject): boolean {
    const existing = new GlideRecord('x_daas_ham_recon_exception')
    existing.addQuery('exception_type', type)
    existing.addQuery('status', 'open')
    if (subject.assetId) existing.addQuery('asset', subject.assetId)
    else existing.addQuery('ci', subject.ciId ?? '')
    existing.setLimit(1)
    existing.query()
    return existing.hasNext()
}

function insertException(type: ExceptionType, subject: ExceptionSubject): void {
    const exception = new GlideRecord('x_daas_ham_recon_exception')
    exception.initialize()
    exception.setValue('exception_type', type)
    exception.setValue('asset', subject.assetId ?? '')
    exception.setValue('ci', subject.ciId ?? '')
    exception.setValue('customer', subject.customerId)
    exception.setValue('detail', subject.detail.slice(0, 255))
    exception.setValue('detected_at', msToGlide(nowMs()))
    // An audit or attestation is closed once and does not raise it again, so a refused one is logged, not lost.
    if (exception.insert()) return
    const reason = refusal(exception)
    const subjectId = subject.assetId || subject.ciId || ''
    gs.warn(`[x_daas_ham] No ${type} exception for ${subjectId} (${subject.detail}): ${reason}`)
}

/** Resolve an asset's open exceptions of the given types that no longer apply. */
export function resolveExceptions(assetId: string, types: readonly ExceptionType[]): void {
    resolveOpen('asset', assetId, types)
}

/** Resolve a CI's open exceptions of the given types that no longer apply, such as a rack's (domain/reconciliation). */
export function resolveCiExceptions(ciId: string, types: readonly ExceptionType[]): void {
    resolveOpen('ci', ciId, types)
}

/**
 * A blank subject would match every exception of the other kind, so it resolves nothing. One the platform refuses to
 * resolve stays open and is logged; the next check that finds it cleared tries again.
 */
function resolveOpen(field: 'asset' | 'ci', subjectId: string, types: readonly ExceptionType[]): void {
    if (!subjectId || types.length === 0) return
    const exception = new GlideRecord('x_daas_ham_recon_exception')
    exception.addQuery(field, subjectId)
    exception.addQuery('status', 'open')
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
    const exception = new GlideRecord('x_daas_ham_recon_exception')
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
