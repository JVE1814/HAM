import { FLEET_FIELD, naasStockroomType, outsideFleetCondition, outsideNaasStockroomCondition, STOCKROOM_TYPE_FIELD } from './fleet.ts'

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

export type AppRole = (typeof ROLE)[keyof typeof ROLE]

/**
 * The roles of other applications the app's roles contain or its metadata names. They must exist on the instance
 * (README "Required plugins"), which the preflight check reports (domain/preflight).
 */
export const PLATFORM_ROLE = {
    asset: 'asset',
    inventoryUser: 'inventory_user',
    inventoryAdmin: 'inventory_admin',
    procurementUser: 'procurement_user',
    procurementAdmin: 'procurement_admin',
    modelManager: 'model_manager',
    reportUser: 'report_user',
    external: 'snc_external',
    canvasUser: 'canvas_user',
    serviceDeskAgent: 'sn_customerservice_agent',
} as const

/**
 * Provider staff without inventory techs: who reads the customer, commercial and configuration tables, and sees every
 * Customer. The metadata's read lists (shared/roles.now.ts `broadStaff`) are this list.
 */
export const BROAD_STAFF = [ROLE.assetManager, ROLE.fieldTech, ROLE.noc, ROLE.accountManager, ROLE.finance]

/**
 * Every provider-staff role: who reads the installed base, and so opens an Asset's form (the rack page links a device
 * to it for them only). The metadata's `providerStaff` (shared/roles.now.ts) is this list, in the order the
 * navigator's modules store it.
 */
export const PROVIDER_STAFF = [ROLE.assetManager, ROLE.inventoryTech, ROLE.fieldTech, ROLE.noc, ROLE.accountManager, ROLE.finance]

/** The roles that read the money tables: service intervals, billing, cost facts and margin. */
export const MONEY_READERS = [ROLE.finance, ROLE.accountManager, ROLE.assetManager]

const BROAD_STAFF_ROLES = [ROLE.admin, ...BROAD_STAFF]

/**
 * The roles that may change a fleet asset by hand: its lifecycle data, on a form, a list or the Table API. An
 * inventory tech only of their Stockrooms. A Customer's Agreement, subscription line and lease, its company and its
 * cost are the asset manager's alone (writesFleetCommercialField).
 */
export const ASSET_EDITOR_ROLES: readonly string[] = [ROLE.assetManager, ROLE.inventoryTech, ROLE.fieldTech]

export function resolveVisibility(hasRole: (role: string) => boolean): VisibilityScope {
    if (BROAD_STAFF_ROLES.some(hasRole)) return 'everything'
    if (hasRole(ROLE.inventoryTech)) return 'assigned_stockrooms'
    if (hasRole(ROLE.customerAdmin)) return 'own_customer'
    if (hasRole(ROLE.siteContact)) return 'own_sites'
    return 'unscoped'
}

/**
 * Whether the user takes the Customer admin's part on the customer page (Q49: request returns, answer attestations):
 * a Customer admin who sees only their own Customer. Staff who see every Customer do not, even holding the role (as a
 * platform admin holds every role) or previewing the page: an attestation is the Customer's own word, and staff raise
 * returns through the record producer.
 */
export function actsAsCustomerAdmin(hasRole: (role: string) => boolean): boolean {
    return resolveVisibility(hasRole) === 'own_customer'
}

/**
 * How one table is scoped (ADR 0005): the field that carries each scoping key, a key the table has no field for left
 * out, and, on a table the app shares with the Provider's IT (ADR 0016), what tells its NaaS records. A field may be
 * dot-walked through the record's parent (`order.customer`). The before-query filter (visibilityFilter) and the read
 * ACLs' row checks (rowVisible, grantsNaasRecord, grantsContactRecord) are both read from it, so the two never
 * disagree on what a user may see.
 */
export interface TableScoping {
    /** The Stockroom an inventory tech is kept to; several fields when a record of any one of them is theirs. */
    stockroom?: string | readonly string[]
    customer?: string
    site?: string
    /** A record with no Customer is every Customer's (a Site template offered to all): a Customer admin reads it too. */
    sharedWithoutCustomer?: boolean
    /**
     * On a shared table, what makes a record NaaS: hardware its Fleet flag (`fleet_flag`); a Stockroom, or a record
     * between Stockrooms, a NaaS stockroom type on any of the Stockrooms `stockroom` names (`stockroom_type`). Every
     * other record of the table is outside NaaS (outsideNaasConditions).
     */
    naas?: 'fleet_flag' | 'stockroom_type'
}

/**
 * Every table the app scopes, by name (ADR 0005). The before-query rules' one script (entry/visibility `scopeRecords`)
 * and the read ACLs' row checks (`readsRecord`, `grantsCustomerRecord`, `grantsFleetAsset`) find a record's scoping
 * here by its table. So a table is scoped by its entry here and the metadata that calls those: a before-query rule
 * (shared/visibility.now.ts), a Deny-Unless read ACL where an inventory tech is kept to their Stockrooms
 * (shared/visibility.now.ts), and the Customer contacts' read ACL.
 */
export const SCOPED_TABLES = {
    alm_hardware: { stockroom: 'stockroom', customer: 'company', site: 'x_daas_ham_site', naas: 'fleet_flag' },
    alm_stockroom: { stockroom: 'sys_id', customer: 'x_daas_ham_customer', naas: 'stockroom_type' },
    alm_transfer_order: { stockroom: ['from_stockroom', 'to_stockroom'], naas: 'stockroom_type' },
    x_daas_ham_staging_task: { stockroom: 'asset.stockroom' },
    // An inventory tech sees the blind counts of their Stockrooms; a site audit has no Stockroom, so it drops out.
    x_daas_ham_audit: { stockroom: 'stockroom', customer: 'customer', site: 'site' },
    x_daas_ham_audit_line: { stockroom: 'audit.stockroom', customer: 'audit.customer', site: 'audit.site' },
    x_daas_ham_order: { customer: 'customer', site: 'site' },
    x_daas_ham_order_line: { customer: 'order.customer', site: 'order.site' },
    x_daas_ham_return_order: { customer: 'customer', site: 'site' },
    x_daas_ham_shipment: { customer: 'customer', site: 'site' },
    x_daas_ham_attestation: { customer: 'customer', site: 'site' },
    x_daas_ham_agreement: { customer: 'customer' },
    x_daas_ham_subscription_line: { customer: 'customer' },
    x_daas_ham_catalog_entry: { customer: 'customer' },
    // Fee events carry no Site, so site contacts get none.
    x_daas_ham_fee_event: { customer: 'customer' },
    // The tables below have no before-query rule: the Customer contacts' read ACL is their only check.
    x_daas_ham_return_order_line: { customer: 'return_order.customer', site: 'return_order.site' },
    x_daas_ham_shipment_event: { customer: 'shipment.customer', site: 'shipment.site' },
    x_daas_ham_attestation_item: { customer: 'attestation.customer', site: 'attestation.site' },
    x_daas_ham_site_template: { customer: 'customer', sharedWithoutCustomer: true },
    x_daas_ham_site_template_item: { customer: 'site_template.customer', sharedWithoutCustomer: true },
} as const satisfies Record<string, TableScoping>

export type ScopedTable = keyof typeof SCOPED_TABLES

/**
 * The scoping of the first of `tables` that has one: a table's own or, given the table and then each table it extends,
 * its nearest parent's (a before-query rule on a table also runs for its child tables' queries). Null when none has:
 * a table the app cannot place, of which visibilityFilter and the row checks show a narrowed reader nothing.
 */
export function scopingOf(tables: readonly string[]): TableScoping | null {
    const scoped: Readonly<Record<string, TableScoping>> = SCOPED_TABLES
    const found = tables.find((table) => Object.prototype.hasOwnProperty.call(scoped, table))
    return found === undefined ? null : scoped[found]
}

function columnsOf(stockroom: string | readonly string[]): readonly string[] {
    return typeof stockroom === 'string' ? [stockroom] : stockroom
}

function stockroomPaths(scoping: TableScoping): string[] {
    return columnsOf(scoping.stockroom ?? []).map((column) => (column === 'sys_id' ? '' : `${column}.`))
}

/**
 * The records of a table the app shares with the Provider's IT (ADR 0016) that its visibility leaves to the platform
 * for an inventory tech, as encoded conditions a record matches all of: hardware outside the fleet, stockrooms outside
 * NaaS, and transfer orders between two of those. The before-query rule keeps every such record in for them, and the
 * read ACLs' row checks pass it (outsideNaas, the same test on one record), so the platform's own ACLs and rules alone
 * decide whether they see it (see leavesOutsideNaas for Customer contacts). None on the app's own tables.
 */
export function outsideNaasConditions(scoping: TableScoping): string[] {
    switch (scoping.naas) {
        case undefined:
            return []
        case 'fleet_flag':
            return [outsideFleetCondition()]
        case 'stockroom_type':
            return stockroomPaths(scoping).map((path) => outsideNaasStockroomCondition(path))
    }
}

/** A stored boolean that is set: `1` as a GlideRecord gives it, `true` as an encoded query writes it. */
function isSet(value: string): boolean {
    return value === '1' || value === 'true'
}

/** Whether `row` is a record outsideNaasConditions matches. A record that could not be read is not taken for one. */
function outsideNaas(scoping: TableScoping, row: ScopedRow): boolean {
    if (row.missing?.()) return false
    switch (scoping.naas) {
        case undefined:
            return false
        case 'fleet_flag':
            return !isSet(row.valueOf(FLEET_FIELD))
        case 'stockroom_type':
            return stockroomPaths(scoping).every((path) => naasStockroomType(row.valueOf(`${path}${STOCKROOM_TYPE_FIELD}`)) === null)
    }
}

export interface ScopingIds {
    customerId: string
    stockroomIds(): string[]
    siteIds(): string[]
}

const NOTHING = 'sys_id=-1'

/** visibilityFilter as encoded OR groups, all of which a visible record matches; null for no restriction. */
function visibilityConditions(scope: VisibilityScope, scoping: TableScoping | null, ids: ScopingIds): string[] | null {
    if (scope === 'everything' || scope === 'unscoped') return null
    if (!scoping) return [NOTHING]
    switch (scope) {
        case 'assigned_stockrooms': {
            if (!scoping.stockroom) return null
            const stockrooms = ids.stockroomIds()
            if (stockrooms.length === 0) return [NOTHING]
            return [columnsOf(scoping.stockroom).map((column) => `${column}IN${stockrooms.join(',')}`).join('^OR')]
        }
        case 'own_customer': {
            if (!scoping.customer) return [NOTHING]
            const theirs = [
                ...(scoping.sharedWithoutCustomer ? [`${scoping.customer}ISEMPTY`] : []),
                ...(ids.customerId ? [`${scoping.customer}=${ids.customerId}`] : []),
            ]
            return [theirs.length === 0 ? NOTHING : theirs.join('^OR')]
        }
        case 'own_sites': {
            // The Customer as well as the Site: a Site of another Customer listing the contact shows them nothing.
            if (!scoping.customer || !scoping.site || !ids.customerId) return [NOTHING]
            const sites = ids.siteIds()
            return sites.length === 0 ? [NOTHING] : [`${scoping.customer}=${ids.customerId}`, `${scoping.site}IN${sites.join(',')}`]
        }
    }
}

/**
 * The encoded query that restricts a table (`scoping`, its SCOPED_TABLES entry) to what `scope` may see, or null for
 * no restriction. Ids are fetched lazily so unrestricted users never pay for the lookups.
 *
 * Inventory techs are only filtered where `scoping` names a Stockroom. The other tables they work on (Orders, Return
 * orders, Shipments) serve every Customer, and the tables they may not read at all are closed by their read ACLs, not
 * here: this filter also applies to the server logic a tech sets off, such as receiving a returned Asset, which can
 * end its Subscription line and record a late-return Fee event, so it must not hide those records.
 *
 * On a table shared with the Provider's IT the filter leaves the records outside NaaS in for a scope that leaves them
 * to the platform (leavesOutsideNaas): each of outsideNaasConditions is ORed into each condition of the filter, which
 * keeps (outside) OR (filter) in the AND-of-ORs form an encoded query has.
 *
 * A table with no scoping (null: neither it nor a table it extends has an entry) shows a narrowed reader nothing. No
 * rule or ACL is wired on such a table, so this only says which way a wiring mistake fails.
 */
export function visibilityFilter(scope: VisibilityScope, scoping: TableScoping | null, ids: ScopingIds): string | null {
    const conditions = visibilityConditions(scope, scoping, ids)
    if (!conditions) return null
    const left = scoping && leavesOutsideNaas(scope) ? outsideNaasConditions(scoping) : []
    if (left.length === 0) return conditions.join('^')
    return left.flatMap((record) => conditions.map((condition) => `${record}^OR${condition}`)).join('^')
}

/**
 * Whether `scope` leaves the records of a shared table outside NaaS (outsideNaasConditions) to the platform. An
 * inventory tech does: a Provider user, whom the platform's own ACLs and rules govern on the Provider IT's hardware,
 * stockrooms and transfer orders as any asset user. A Customer contact does not: the rules keep them to their Customer
 * (and Sites) on every record of those tables, as they did before the fleet, so a contact's read never depends on
 * another scope's narrowing (Customer Service's contact rules on alm_asset run in interactive sessions only, ADR
 * 0005). Hiding another company's hardware from a contact hides nothing the Provider's IT needs.
 */
function leavesOutsideNaas(scope: VisibilityScope): boolean {
    return scope === 'assigned_stockrooms'
}

/** Whether `scope` is a Customer contact's (a customer admin or a site contact), kept to their own Customer. */
export function isCustomerContact(scope: VisibilityScope): boolean {
    return scope === 'own_customer' || scope === 'own_sites'
}

/** One record a read ACL asks about, as the row checks read it. */
export interface ScopedRow {
    /**
     * Whether it is a saved row. The platform also asks about a new record (a New form) and about a GlideRecord on no
     * row (a check of the whole table), which hold nothing to hide: rowVisible and grantsNaasRecord always pass those.
     */
    saved: boolean
    /** The value of a field its table's scoping names, or tells its NaaS records by ('' for blank). */
    valueOf(field: string): string
    /**
     * Whether a record that holds the fields could not be read (an Asset's hardware record, entry/visibility
     * `hardwareOf`; a Stockroom a transfer order names, `transferOrderRow`): its fields are then blank, and the row is
     * not taken for a record outside NaaS. Omitted when the fields are the row's own.
     */
    missing?(): boolean
}

/** What visibilityFilter keeps, decided on one record's values, saved row or not. */
function keeps(scope: VisibilityScope, scoping: TableScoping | null, row: ScopedRow, ids: ScopingIds): boolean {
    if (scope === 'everything' || scope === 'unscoped') return true
    if (!scoping) return false
    switch (scope) {
        case 'assigned_stockrooms': {
            if (!scoping.stockroom) return true
            // This scope leaves the records outside NaaS to the platform (leavesOutsideNaas).
            if (outsideNaas(scoping, row)) return true
            const stockrooms = ids.stockroomIds()
            return columnsOf(scoping.stockroom).some((column) => {
                const stockroom = row.valueOf(column)
                return stockroom !== '' && stockrooms.includes(stockroom)
            })
        }
        case 'own_customer': {
            if (!scoping.customer) return false
            const customer = row.valueOf(scoping.customer)
            return customer === '' ? !!scoping.sharedWithoutCustomer : customer === ids.customerId
        }
        case 'own_sites': {
            if (!scoping.customer || !scoping.site || !ids.customerId) return false
            if (row.valueOf(scoping.customer) !== ids.customerId) return false
            const site = row.valueOf(scoping.site)
            return site !== '' && ids.siteIds().includes(site)
        }
    }
}

/**
 * Whether `scope` may see one record (`row`) of a table (`scoping`): the record-by-record check of the Deny-Unless
 * read ACLs, keeping exactly what visibilityFilter keeps. A before-query rule can only append conditions, which an
 * `^NQ` in the query binds to its last clause, so a list can carry records the filter would hide; the Deny-Unless read
 * ACL (ADR 0005) removes them. Ids are fetched, and fields read, lazily, as for visibilityFilter.
 */
export function rowVisible(scope: VisibilityScope, scoping: TableScoping | null, row: ScopedRow, ids: ScopingIds): boolean {
    return !row.saved || keeps(scope, scoping, row, ids)
}

/**
 * Whether an Allow-If read ACL of the app on a shared table grants `scope` the record: a NaaS record (not outside
 * NaaS) that rowVisible keeps, or a record that is not a saved row (the check of the whole table, which lets the
 * reader open its list at all). The app grants only what it governs; the platform's own Allow-If ACLs, ORed with
 * these, decide the rest.
 */
export function grantsNaasRecord(scope: VisibilityScope, scoping: TableScoping, row: ScopedRow, ids: ScopingIds): boolean {
    if (!row.saved) return true
    return !outsideNaas(scoping, row) && keeps(scope, scoping, row, ids)
}

export type ContactScope = Extract<VisibilityScope, 'own_customer' | 'own_sites'>

/**
 * The scope the Customer contacts' read ACLs grant a user by: a Customer admin their Customer, anyone else those ACLs
 * admit (a site contact) their Sites. It goes by the customer admin role alone, not by resolveVisibility: a user who
 * also holds a staff role is granted here what a contact is, and reads the rest through the staff read ACLs.
 */
export function contactScope(hasRole: (role: string) => boolean): ContactScope {
    return hasRole(ROLE.customerAdmin) ? 'own_customer' : 'own_sites'
}

/**
 * Whether an Allow-If read ACL for Customer contacts grants a contact (`contact`, their contactScope) the record: one
 * of their Customer and, for a site contact, at a Site that lists them, as visibilityFilter keeps it for that scope.
 * Unlike rowVisible it judges a record that is not a saved row by its values too: the grant is for the Customer a
 * record names, so a blank record is granted only where a record with no Customer is every Customer's.
 */
export function grantsContactRecord(contact: ContactScope, scoping: TableScoping | null, row: ScopedRow, ids: ScopingIds): boolean {
    return keeps(contact, scoping, row, ids)
}

/**
 * Whether the customer admins' create ACL on Returns grants a customer admin (of Customer `customerId`) a Return that
 * names `returnCustomer` ('' for none): one of their own Customer only. One that names no Customer yet passes: the
 * customer page asks whether a Return may be raised at all (platform/returns, canCreate() of an empty record) before
 * it names the Customer, and a Return with none is no Customer's, which no customer contact reads. (An Order's create
 * ACL grants by grantsContactRecord, which refuses one that names no Customer.)
 */
export function grantsReturnOfOwnCustomer(customerId: string, returnCustomer: string): boolean {
    return !!customerId && (returnCustomer === '' || returnCustomer === customerId)
}

/*
 * Changes to hardware by hand (ADR 0005): the platform's `asset` role, which inventory and field techs hold, lets its
 * holders save and delete every Asset, and change its company and cost, from a form, a list or the Table API. The
 * app's Deny-Unless ACLs on alm_asset (fleet/access.now.ts) keep fleet assets to the people who run them and
 * leave every other Asset to the platform. A record that is not a saved row (a New form, a check of the whole table)
 * passes, as for reads. The app's own server logic saves through GlideRecord, which no ACL checks.
 */

/**
 * Whether the user may save a record of hardware by hand. A fleet asset only an asset editor (ASSET_EDITOR_ROLES)
 * whose scope keeps it (an inventory tech: their Stockrooms), never a Customer contact or a NaaS role that runs no
 * assets (the NOC, account managers, finance). Hardware outside the fleet, and users with no NaaS role, are left to
 * the platform's ACLs, as for reads.
 */
export function writesFleetAsset(scope: VisibilityScope, hasRole: (role: string) => boolean, row: ScopedRow, ids: ScopingIds): boolean {
    if (scope === 'unscoped' || !row.saved || outsideNaas(SCOPED_TABLES.alm_hardware, row)) return true
    if (isCustomerContact(scope)) return false
    return ASSET_EDITOR_ROLES.some(hasRole) && rowVisible(scope, SCOPED_TABLES.alm_hardware, row, ids)
}

/**
 * Whether the user may delete a record of hardware. A fleet asset leaves by disposal and keeps its record, its history
 * being the app's (ADR 0016), so only an app administrator deletes one (a unit taken in by mistake). Hardware outside
 * the fleet is left to the platform's ACLs.
 */
export function deletesFleetAsset(hasRole: (role: string) => boolean, row: ScopedRow): boolean {
    return !row.saved || hasRole(ROLE.admin) || outsideNaas(SCOPED_TABLES.alm_hardware, row)
}

/**
 * Whether the user may change, by hand, a field of hardware that ties it to a Customer or a cost (its company and
 * cost; the app's own columns, the Agreement, subscription line, lease and Legal owner, have their asset-manager
 * ACLs). On a fleet asset only an asset manager (whom an app administrator holds) may: billing, margin and visibility
 * follow them, and the app's flows set them. Hardware outside the fleet is left to the platform's ACLs.
 */
export function writesFleetCommercialField(hasRole: (role: string) => boolean, row: ScopedRow): boolean {
    return !row.saved || hasRole(ROLE.assetManager) || outsideNaas(SCOPED_TABLES.alm_hardware, row)
}

/**
 * Whether the user may read a field of hardware that is the Provider's own figure (its cost). A Customer contact may
 * not on a fleet asset, though Customer Service's ACLs grant a contact holding its roles the cost of the Assets they
 * see; hardware outside the fleet is left to the platform's ACLs. (The app's own Provider columns on hardware, the
 * support cost, claim code and lease, are read by provider staff alone.)
 */
export function readsFleetProviderField(scope: VisibilityScope, row: ScopedRow): boolean {
    if (!row.saved || !isCustomerContact(scope)) return true
    return outsideNaas(SCOPED_TABLES.alm_hardware, row)
}
