import { gs } from '@servicenow/glide'
import { resolveVisibility, type VisibilityScope } from '../domain/visibility'
import { pluck } from './records'

/** The signed-in user's visibility and the identifiers it is scoped by (ADR 0005). */
export interface SessionScope {
    scope: VisibilityScope
    userId: string
    customerId: string
    stockroomIds(): string[]
    siteIds(): string[]
}

export function currentSession(): SessionScope {
    const userId = gs.getUserID()
    return {
        scope: resolveVisibility((role) => gs.hasRole(role)),
        userId,
        customerId: gs.getUser().getCompanyID(),
        stockroomIds: () => pluck('x_daas_ham_stockroom_member', `user=${userId}`, 'stockroom'),
        // Contacts are a comma-separated list of 32-character sys_ids: a whole sys_id matches only its own entry.
        siteIds: () => pluck('cmn_location', `x_daas_ham_site_contactsLIKE${userId}`, 'sys_id'),
    }
}
