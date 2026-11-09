import { gs } from '@servicenow/glide'
import { memoized } from '../domain/memo.ts'
import { resolveVisibility, type VisibilityScope } from '../domain/visibility.ts'
import { pluck } from './records.ts'

/** The signed-in user's visibility and the identifiers it is scoped by (ADR 0005). */
export interface SessionScope {
    scope: VisibilityScope
    userId: string
    customerId: string
    stockroomIds(): string[]
    siteIds(): string[]
}

/*
 * A user's scope, Customer, Stockrooms and Sites, read once per user and transaction: a module's state lasts one
 * transaction (docs/research/external-contracts.md N37), and the read ACLs' row checks run for every row a user reads of
 * the tables they guard, every hardware row included, so they would otherwise resolve the roles and query the
 * Stockrooms and Sites again for each. Keyed by user, so a transaction that changes user (an impersonation) reads the
 * new user's own.
 */
const scopeOf = memoized(() => resolveVisibility((role) => gs.hasRole(role)))
const customerOf = memoized(() => gs.getUser().getCompanyID())
const stockroomsOf = memoized((userId) => pluck('x_daas_ham_stockroom_member', `user=${userId}`, 'stockroom'))
// Contacts are a comma-separated list of 32-character sys_ids: a whole sys_id matches only its own entry.
const sitesOf = memoized((userId) => pluck('cmn_location', `x_daas_ham_site_contactsLIKE${userId}`, 'sys_id'))

export function currentSession(): SessionScope {
    const userId = gs.getUserID()
    return {
        scope: scopeOf(userId),
        userId,
        customerId: customerOf(userId),
        stockroomIds: () => stockroomsOf(userId),
        siteIds: () => sitesOf(userId),
    }
}
