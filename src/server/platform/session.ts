import { GlideRecord, gs } from '@servicenow/glide'
import { NAAS_STOCKROOM_CONDITION } from '../domain/fleet.ts'
import { memoized } from '../domain/memo.ts'
import type { CustomerActor } from '../domain/customer-parties.ts'
import { contactScope, resolveVisibility, type ContactScope, type VisibilityScope } from '../domain/visibility.ts'
import { beyondVisibility } from './beyond-visibility.ts'
import { pluck } from './records.ts'

export interface SessionScope {
    scope: VisibilityScope
    contactScope(): ContactScope
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
const contactScopeOf = memoized(() => contactScope((role) => gs.hasRole(role)))
const customerOf = memoized(() => gs.getUser().getCompanyID())
const stockroomsOf = memoized(assignedStockrooms)
// Contacts are a comma-separated list of 32-character sys_ids: a whole sys_id matches only its own entry.
const sitesOf = memoized((userId) => pluck('cmn_location', `x_daas_ham_site_contactsLIKE${userId}`, 'sys_id'))

/**
 * The Stockrooms a user works at: the NaaS stockrooms whose Assignment group the user is a member of (ADR 0018). The
 * app's own rule on alm_stockroom narrows an inventory tech to this very list, so the read goes past it.
 */
function assignedStockrooms(userId: string): string[] {
    const groups = pluck('sys_user_grmember', `user=${userId}`, 'group').filter(Boolean)
    if (groups.length === 0) return []
    const stockroom = new GlideRecord('alm_stockroom')
    stockroom.addEncodedQuery(`assignment_groupIN${groups.join(',')}^${NAAS_STOCKROOM_CONDITION}`)
    beyondVisibility(stockroom, () => stockroom.query())
    const ids: string[] = []
    while (stockroom.next()) ids.push(stockroom.getUniqueValue())
    return ids
}

/**
 * The signed-in user as the person asking for `record` to be created for a Customer (domain/customer-parties
 * `actorRefusal`): whether its table's create rule lets them create it, how far they see and their own Customer. A
 * record producer saves its record without applying the create rule, so the service that takes the record on (an
 * Order, a Return) asks here, and removes a record its requester may not raise.
 */
export function creatorOf(record: GlideRecord): CustomerActor {
    const { scope, customerId } = currentSession()
    return { permitted: record.canCreate(), scope, customerId }
}

export function currentSession(): SessionScope {
    const userId = gs.getUserID()
    return {
        scope: scopeOf(userId),
        contactScope: () => contactScopeOf(userId),
        userId,
        customerId: customerOf(userId),
        stockroomIds: () => stockroomsOf(userId),
        siteIds: () => sitesOf(userId),
    }
}
