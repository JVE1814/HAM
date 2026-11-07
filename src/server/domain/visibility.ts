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

/**
 * The app tables an inventory tech with no broader role may read: the Assets, Staging tasks and Audits of their
 * Stockrooms (STOCKROOM_SCOPED_TABLES), and the ASN imports, Staging steps and templates, Orders, Shipments, Return
 * orders, OEM RMAs and Disposal orders they work on, which are not narrowed to their Stockrooms. Every other table's
 * read ACL leaves inventory techs out (the security Fluent files are checked against this list).
 */
export const INVENTORY_TECH_TABLES: readonly string[] = [
    'alm_hardware',
    'x_daas_ham_asn_import',
    'x_daas_ham_staging_task',
    'x_daas_ham_staging_step',
    'x_daas_ham_staging_template',
    'x_daas_ham_staging_tmpl_item',
    'x_daas_ham_order',
    'x_daas_ham_order_line',
    'x_daas_ham_shipment',
    'x_daas_ham_shipment_event',
    'x_daas_ham_return_order',
    'x_daas_ham_return_order_line',
    'x_daas_ham_audit',
    'x_daas_ham_audit_line',
    'x_daas_ham_oem_rma',
    'x_daas_ham_disposal_order',
    'x_daas_ham_disposal_line',
]

/**
 * The tables an inventory tech sees only for their assigned Stockrooms: stock, transfer orders, Staging tasks and
 * Audits with their lines. Each has a before-query rule that filters on a Stockroom field, and no other table does
 * (the rules are checked against this list).
 */
export const STOCKROOM_SCOPED_TABLES: readonly string[] = [
    'alm_hardware',
    'alm_stockroom',
    'alm_transfer_order',
    'x_daas_ham_staging_task',
    'x_daas_ham_audit',
    'x_daas_ham_audit_line',
]

export function resolveVisibility(hasRole: (role: string) => boolean): VisibilityScope {
    if (BROAD_STAFF_ROLES.some(hasRole)) return 'everything'
    if (hasRole(ROLE.inventoryTech)) return 'assigned_stockrooms'
    if (hasRole(ROLE.customerAdmin)) return 'own_customer'
    if (hasRole(ROLE.siteContact)) return 'own_sites'
    return 'unscoped'
}

/**
 * Whether the user takes the Customer admin's part on the customer page (D49: request returns, answer attestations):
 * a Customer admin who sees only their own Customer. Staff who see every Customer do not, even holding the role (as a
 * platform admin holds every role) or previewing the page: an attestation is the Customer's own word, and staff raise
 * returns through the record producer.
 */
export function actsAsCustomerAdmin(hasRole: (role: string) => boolean): boolean {
    return resolveVisibility(hasRole) === 'own_customer'
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
 *
 * Inventory techs are only filtered where `fields` names a Stockroom (STOCKROOM_SCOPED_TABLES). The other tables
 * they work on (Orders, Return orders, Shipments) serve every Customer, and the tables they may not read at all are
 * closed by their read ACLs, not here: this filter also applies to the server logic a tech sets off, such as
 * receiving a returned Asset, which can end its Subscription line and record a late-return Fee event, so it must
 * not hide those records.
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
