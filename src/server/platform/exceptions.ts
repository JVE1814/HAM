import { GlideRecord, gs } from '@servicenow/glide'
import type { ExceptionType } from '../domain/reconciliation'
import { msToGlide, nowMs } from './clock'
import { withLock } from './locks'
import { refusal } from './records'

/** Reconciliation exceptions: at most one open exception per type and asset (or CI). */

interface ExceptionSubject {
    assetId?: string
    ciId?: string
    customerId: string
    detail: string
}

/** Tries at taking the subject's lock before leaving the exception to the holder: it holds it for one read and one insert. */
const LOCK_ATTEMPTS = 5

/**
 * Open an exception of `type` for the subject unless one is already open. Two runs (an overlapping reconciliation, two
 * audits closing at once) may raise the same one, and a unique index cannot allow closed duplicates beside the open
 * one, so the check and the insert are made under a lock on the type and subject, re-checking there. A run that finds
 * the lock held through every try leaves the exception to the holder, which is raising it. Taking the lock throws only
 * when an insert is refused with no lock row (platform/locks retries once when the holder lets go mid-take): that try
 * is made again, and only when every try throws does the error escape, as does one from the insert.
 */
export function openException(type: ExceptionType, subject: ExceptionSubject): void {
    // Most calls find the exception already open from an earlier run: those need no lock.
    if (isOpen(type, subject)) return
    let held = false
    let takeError: unknown = null
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
        let started = false
        try {
            const taken = withLock(`recon_exception_${type}_${subject.assetId || subject.ciId || ''}`, () => {
                started = true
                if (!isOpen(type, subject)) insertException(type, subject)
            })
            if (taken) return
            held = true
        } catch (error) {
            if (started) throw error
            takeError = error
        }
    }
    if (!held && takeError) throw takeError
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
    if (types.length === 0) return
    const exception = new GlideRecord('x_daas_ham_recon_exception')
    exception.addQuery('asset', assetId)
    exception.addQuery('status', 'open')
    exception.addQuery('exception_type', 'IN', types.join(','))
    exception.query()
    while (exception.next()) {
        exception.setValue('status', 'resolved')
        exception.update()
    }
}
