/**
 * Which slice of the installed base a user may see (ADR 0005).
 *
 * `hasRole` must honour role containment (as `gs.hasRole` does), so an asset manager also "has"
 * the inventory-tech role; the broadest scope wins.
 */
export type VisibilityScope = 'everything' | 'assigned_stockrooms' | 'own_customer' | 'own_sites' | 'unscoped'

export const ROLE = {
    admin: 'x_daas_ham.admin',
    assetManager: 'x_daas_ham.asset_manager',
    inventoryTech: 'x_daas_ham.inventory_tech',
    fieldTech: 'x_daas_ham.field_tech',
    noc: 'x_daas_ham.noc',
    accountManager: 'x_daas_ham.account_manager',
    finance: 'x_daas_ham.finance',
    customerAdmin: 'x_daas_ham.customer_admin',
    siteContact: 'x_daas_ham.site_contact',
    integration: 'x_daas_ham.integration',
} as const

const BROAD_STAFF_ROLES = [
    ROLE.admin,
    ROLE.assetManager,
    ROLE.fieldTech,
    ROLE.noc,
    ROLE.accountManager,
    ROLE.finance,
]

export function resolveVisibility(hasRole: (role: string) => boolean): VisibilityScope {
    if (BROAD_STAFF_ROLES.some(hasRole)) return 'everything'
    if (hasRole(ROLE.inventoryTech)) return 'assigned_stockrooms'
    if (hasRole(ROLE.customerAdmin)) return 'own_customer'
    if (hasRole(ROLE.siteContact)) return 'own_sites'
    return 'unscoped'
}

/** Which field on a table carries each scoping key; omit a key the table has no field for. */
export interface ScopingFields {
    stockroom?: string | readonly string[]
    customer?: string
    site?: string
}

export interface ScopingIds {
    customerId: string
    stockroomIds(): string[]
    siteIds(): string[]
}

const NOTHING = 'sys_id=-1'

/**
 * The encoded query that restricts a table to what `scope` may see, or null for no restriction.
 * Ids are fetched lazily so unrestricted users never pay for the lookups.
 */
export function visibilityFilter(scope: VisibilityScope, fields: ScopingFields, ids: ScopingIds): string | null {
    switch (scope) {
        case 'everything':
        case 'unscoped':
            return null
        case 'assigned_stockrooms': {
            if (!fields.stockroom) return null
            const stockrooms = ids.stockroomIds()
            if (stockrooms.length === 0) return NOTHING
            const columns = typeof fields.stockroom === 'string' ? [fields.stockroom] : fields.stockroom
            return columns.map((column) => `${column}IN${stockrooms.join(',')}`).join('^OR')
        }
        case 'own_customer':
            if (!fields.customer || !ids.customerId) return NOTHING
            return `${fields.customer}=${ids.customerId}`
        case 'own_sites': {
            if (!fields.site) return NOTHING
            const sites = ids.siteIds()
            return sites.length === 0 ? NOTHING : `${fields.site}IN${sites.join(',')}`
        }
    }
}
