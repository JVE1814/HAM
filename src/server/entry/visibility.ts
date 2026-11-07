import type { GlideRecord } from '@servicenow/glide'
import { visibilityFilter, type ScopingFields } from '../domain/visibility'
import { currentSession } from '../platform/session'

// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.

/** Before-query business rules that restrict lists and lookups to what the user may see (ADR 0005). */

function restrict(current: GlideRecord, fields: ScopingFields): void {
    const session = currentSession()
    const filter = visibilityFilter(session.scope, fields, session)
    if (filter) current.addEncodedQuery(filter)
}

export function scopeAssets(current: GlideRecord): void {
    restrict(current, { stockroom: 'stockroom', customer: 'company', site: 'x_daas_ham_site' })
}

export function scopeStockrooms(current: GlideRecord): void {
    restrict(current, { stockroom: 'sys_id', customer: 'x_daas_ham_customer' })
}

export function scopeTransferOrders(current: GlideRecord): void {
    restrict(current, { stockroom: ['from_stockroom', 'to_stockroom'] })
}

export function scopeStagingTasks(current: GlideRecord): void {
    restrict(current, { stockroom: 'asset.stockroom' })
}

/** An inventory tech sees the blind counts of their Stockrooms; a site audit has no Stockroom, so it drops out. */
export function scopeAudits(current: GlideRecord): void {
    restrict(current, { stockroom: 'stockroom', customer: 'customer', site: 'site' })
}

export function scopeAuditLines(current: GlideRecord): void {
    restrict(current, { stockroom: 'audit.stockroom', customer: 'audit.customer', site: 'audit.site' })
}

export function scopeOrders(current: GlideRecord): void {
    restrict(current, { customer: 'customer', site: 'site' })
}

export function scopeOrderLines(current: GlideRecord): void {
    restrict(current, { customer: 'order.customer', site: 'order.site' })
}

export function scopeCustomerRecords(current: GlideRecord): void {
    restrict(current, { customer: 'customer' })
}

export function scopeCustomerSiteRecords(current: GlideRecord): void {
    restrict(current, { customer: 'customer', site: 'site' })
}
