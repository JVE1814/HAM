import { GlideRecord } from '@servicenow/glide'
import type { ExceptionType } from '../domain/reconciliation'
import { msToGlide, nowMs } from './clock'

/** Reconciliation exceptions: at most one open exception per type and asset (or CI). */

export function openException(type: ExceptionType, subject: { assetId?: string; ciId?: string; customerId: string; detail: string }): void {
    const existing = new GlideRecord('x_daas_ham_recon_exception')
    existing.addQuery('exception_type', type)
    existing.addQuery('status', 'open')
    if (subject.assetId) existing.addQuery('asset', subject.assetId)
    else existing.addQuery('ci', subject.ciId ?? '')
    existing.setLimit(1)
    existing.query()
    if (existing.hasNext()) return
    const exception = new GlideRecord('x_daas_ham_recon_exception')
    exception.initialize()
    exception.setValue('exception_type', type)
    exception.setValue('asset', subject.assetId ?? '')
    exception.setValue('ci', subject.ciId ?? '')
    exception.setValue('customer', subject.customerId)
    exception.setValue('detail', subject.detail.slice(0, 255))
    exception.setValue('detected_at', msToGlide(nowMs()))
    exception.insert()
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
