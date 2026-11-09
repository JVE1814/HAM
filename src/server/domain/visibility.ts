import { fleetStagesQuery, NAAS_STOCKROOM_TYPES, outsideFleetCondition, STOCKROOM_TYPE_FIELD } from './fleet.ts'
import { DEPLOYED_STAGES } from './lifecycle.ts'

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
 * Audits with their lines. Each has a before-query rule that filters on a Stockroom field, and no other table does,
 * and a Deny-Unless read ACL that checks each record the same way (rowVisible), alm_hardware's on its parent alm_asset
 * (ADR 0005); the rules and the ACLs are checked against this list.
 */
export const STOCKROOM_SCOPED_TABLES: readonly string[] = [
    'alm_hardware',
    'alm_stockroom',
    'alm_transfer_order',
    'x_daas_ham_staging_task',
    'x_daas_ham_audit',
    'x_daas_ham_audit_line',
]

/**
 * The roles that may change a fleet asset by hand (security/roles.now.ts `assetEditors`, which the security tests check
 * against this list): its lifecycle data, on a form, a list or the Table API. An inventory tech only of their
 * Stockrooms. A Customer's Agreement, subscription line and lease, its company and its cost are the asset manager's
 * alone (writesFleetCommercialField).
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
 * Whether the user takes the Customer admin's part on the customer page (D49: request returns, answer attestations):
 * a Customer admin who sees only their own Customer. Staff who see every Customer do not, even holding the role (as a
 * platform admin holds every role) or previewing the page: an attestation is the Customer's own word, and staff raise
 * returns through the record producer.
 */
export function actsAsCustomerAdmin(hasRole: (role: string) => boolean): boolean {
    return resolveVisibility(hasRole) === 'own_customer'
}

/**
 * The equipment the customer page lists (D49), as an encoded alm_hardware query: the fleet assets (ADR 0016) shipped to
 * a Site, serving there or awaiting return. The Fleet flag tells them from the Provider IT's hardware, laptops in use
 * included, whatever their Agreement: a deployed fleet unit missing its Agreement (a data gap) is still its Customer's
 * equipment. `visible` (the reader's `visibilityFilter` on alm_hardware, null for staff who see every Customer) is put
 * into every stage's clause: the before-query rule's filter would bind to the last clause only (ADR 0005).
 */
export function customerEquipmentQuery(visible: string | null = null): string {
    return fleetStagesQuery(DEPLOYED_STAGES, visible ?? '')
}

/** Which field on a table carries each scoping key; omit a key the table has no field for. */
export interface ScopingFields {
    stockroom?: string | readonly string[]
    customer?: string
    site?: string
}

/** The scopes the before-query rules (entry/visibility) and the read ACLs' row checks apply, one per rule script. */
export type ScopedRecords =
    | 'assets'
    | 'stockrooms'
    | 'transferOrders'
    | 'stagingTasks'
    | 'audits'
    | 'auditLines'
    | 'orders'
    | 'orderLines'
    | 'customerRecords'
    | 'customerSiteRecords'

/**
 * The fields each before-query rule filters on, and each read ACL's row check reads (ADR 0005), so the two never
 * disagree on what a user may see.
 */
export const SCOPE: Readonly<Record<ScopedRecords, ScopingFields>> = {
    assets: { stockroom: 'stockroom', customer: 'company', site: 'x_daas_ham_site' },
    stockrooms: { stockroom: 'sys_id', customer: 'x_daas_ham_customer' },
    transferOrders: { stockroom: ['from_stockroom', 'to_stockroom'] },
    stagingTasks: { stockroom: 'asset.stockroom' },
    // An inventory tech sees the blind counts of their Stockrooms; a site audit has no Stockroom, so it drops out.
    audits: { stockroom: 'stockroom', customer: 'customer', site: 'site' },
    auditLines: { stockroom: 'audit.stockroom', customer: 'audit.customer', site: 'audit.site' },
    orders: { customer: 'customer', site: 'site' },
    orderLines: { customer: 'order.customer', site: 'order.site' },
    customerRecords: { customer: 'customer' },
    customerSiteRecords: { customer: 'customer', site: 'site' },
}

/**
 * Encoded condition matching stockrooms outside NaaS (through `via`, e.g. `from_stockroom.`): another type, or none,
 * which is not left to how `NOT IN` treats an empty value. The complement of domain/fleet `naasStockroomCondition`.
 */
export function outsideNaasStockroomCondition(via = ''): string {
    const type = `${via}${STOCKROOM_TYPE_FIELD}`
    return `${type}NOT IN${NAAS_STOCKROOM_TYPES.join(',')}^OR${type}ISEMPTY`
}

/**
 * The records of the tables the app shares with the Provider's IT (ADR 0016) that its visibility leaves to the
 * platform for an inventory tech, as encoded conditions a record matches all of: hardware outside the fleet,
 * stockrooms outside NaaS, and transfer orders between two of those. The before-query rules keep every such record in
 * for them, and the read ACLs' row checks pass it, so the platform's own ACLs and rules alone decide whether they see
 * it (see leavesOutsideNaas for Customer contacts).
 */
export const OUTSIDE_NAAS: Readonly<Partial<Record<ScopedRecords, readonly string[]>>> = {
    assets: [outsideFleetCondition()],
    stockrooms: [outsideNaasStockroomCondition()],
    transferOrders: [outsideNaasStockroomCondition('from_stockroom.'), outsideNaasStockroomCondition('to_stockroom.')],
}

export interface ScopingIds {
    customerId: string
    stockroomIds(): string[]
    siteIds(): string[]
}

const NOTHING = 'sys_id=-1'

function columnsOf(stockroom: string | readonly string[]): readonly string[] {
    return typeof stockroom === 'string' ? [stockroom] : stockroom
}

/** visibilityFilter as encoded OR groups, all of which a visible record matches; null for no restriction. */
function visibilityConditions(scope: VisibilityScope, fields: ScopingFields, ids: ScopingIds): string[] | null {
    switch (scope) {
        case 'everything':
        case 'unscoped':
            return null
        case 'assigned_stockrooms': {
            if (!fields.stockroom) return null
            const stockrooms = ids.stockroomIds()
            if (stockrooms.length === 0) return [NOTHING]
            return [columnsOf(fields.stockroom).map((column) => `${column}IN${stockrooms.join(',')}`).join('^OR')]
        }
        case 'own_customer':
            if (!fields.customer || !ids.customerId) return [NOTHING]
            return [`${fields.customer}=${ids.customerId}`]
        case 'own_sites': {
            // The Customer as well as the Site, as the read ACLs check: a Site of another Customer listing the
            // contact shows them nothing.
            if (!fields.customer || !fields.site || !ids.customerId) return [NOTHING]
            const sites = ids.siteIds()
            return sites.length === 0 ? [NOTHING] : [`${fields.customer}=${ids.customerId}`, `${fields.site}IN${sites.join(',')}`]
        }
    }
}

/**
 * The encoded query that restricts a table to what `scope` may see, or null for no restriction.
 * Ids are fetched lazily so unrestricted users never pay for the lookups.
 *
 * Inventory techs are only filtered where `fields` names a Stockroom (STOCKROOM_SCOPED_TABLES). The other tables
 * they work on (Orders, Return orders, Shipments) serve every Customer, and the tables they may not read at all are
 * closed by their read ACLs, not here: this filter also applies to the server logic a tech sets off, such as
 * receiving a returned Asset, which can end its Subscription line and record a late-return Fee event, so it must
 * not hide those records.
 *
 * `outside` (OUTSIDE_NAAS, for a table shared with the Provider's IT) matches the records the filter leaves in for a
 * scope that leaves them to the platform (leavesOutsideNaas): each of its conditions is ORed into each condition of
 * the filter, which keeps (outside) OR (filter) in the AND-of-ORs form an encoded query has.
 */
export function visibilityFilter(
    scope: VisibilityScope,
    fields: ScopingFields,
    ids: ScopingIds,
    outside: readonly string[] = [],
): string | null {
    const conditions = visibilityConditions(scope, fields, ids)
    if (!conditions) return null
    const left = leavesOutsideNaas(scope) ? outside : []
    if (left.length === 0) return conditions.join('^')
    return left.flatMap((record) => conditions.map((condition) => `${record}^OR${condition}`)).join('^')
}

/**
 * Whether `scope` leaves the records of a shared table outside NaaS (OUTSIDE_NAAS) to the platform. An inventory tech
 * does: a Provider user, whom the platform's own ACLs and rules govern on the Provider IT's hardware, stockrooms and
 * transfer orders as any asset user. A Customer contact does not: the rules keep them to their Customer (and Sites)
 * on every record of those tables, as they did before the fleet, so a contact's read never depends on another scope's
 * narrowing (Customer Service's contact rules on alm_asset run in interactive sessions only, ADR 0005). Hiding another
 * company's hardware from a contact hides nothing the Provider's IT needs.
 */
function leavesOutsideNaas(scope: VisibilityScope): boolean {
    return scope === 'assigned_stockrooms'
}

/** Whether `scope` is a Customer contact's (a customer admin or a site contact), kept to their own Customer. */
export function isCustomerContact(scope: VisibilityScope): boolean {
    return scope === 'own_customer' || scope === 'own_sites'
}

/** One record a read ACL asks about, as rowVisible and grantsNaasRecord read it. */
export interface ScopedRow {
    /**
     * Whether it is a saved row. The platform also asks about a new record (a New form) and about a GlideRecord on no
     * row (a check of the whole table), which hold nothing to hide: those always pass.
     */
    saved: boolean
    /** The value of one of the fields `fields` names ('' for blank). */
    valueOf(field: string): string
    /** Whether it is a record of a shared table outside NaaS (OUTSIDE_NAAS); omitted on the app's own tables. */
    outsideNaas?(): boolean
}

/**
 * Whether `scope` may see one record (`row`): the record-by-record check the read ACLs' row checks make, keeping
 * exactly what visibilityFilter keeps (with the table's OUTSIDE_NAAS). A before-query rule can only append conditions,
 * which an `^NQ` in the query binds to its last clause, so a list can carry records the filter would hide; the
 * Deny-Unless read ACL (ADR 0005) removes them. Ids are fetched, and fields read, lazily, as for visibilityFilter.
 */
export function rowVisible(scope: VisibilityScope, fields: ScopingFields, row: ScopedRow, ids: ScopingIds): boolean {
    if (!row.saved) return true
    switch (scope) {
        case 'everything':
        case 'unscoped':
            return true
        case 'assigned_stockrooms': {
            if (!fields.stockroom) return true
            // This scope leaves the records outside NaaS to the platform (leavesOutsideNaas).
            if (row.outsideNaas?.()) return true
            const stockrooms = ids.stockroomIds()
            return columnsOf(fields.stockroom).some((column) => {
                const stockroom = row.valueOf(column)
                return stockroom !== '' && stockrooms.includes(stockroom)
            })
        }
        case 'own_customer':
            return !!fields.customer && !!ids.customerId && row.valueOf(fields.customer) === ids.customerId
        case 'own_sites': {
            if (!fields.customer || !fields.site || !ids.customerId) return false
            if (row.valueOf(fields.customer) !== ids.customerId) return false
            const site = row.valueOf(fields.site)
            return site !== '' && ids.siteIds().includes(site)
        }
    }
}

/**
 * Whether an Allow-If read ACL of the app on a shared table grants `scope` the record: a NaaS record (not
 * `outsideNaas`) that rowVisible keeps, or a record that is not a saved row (the check of the whole table, which lets
 * the reader open its list at all). The app grants only what it governs; the platform's own Allow-If ACLs, ORed with
 * these, decide the rest.
 */
export function grantsNaasRecord(scope: VisibilityScope, fields: ScopingFields, row: ScopedRow, ids: ScopingIds): boolean {
    if (!row.saved) return true
    return !row.outsideNaas?.() && rowVisible(scope, fields, row, ids)
}

/*
 * Changes to hardware by hand (ADR 0005): the platform's `asset` role, which inventory and field techs hold, lets its
 * holders save and delete every Asset, and change its company and cost, from a form, a list or the Table API. The
 * app's Deny-Unless ACLs on alm_asset (security/acls-hardware.now.ts) keep fleet assets to the people who run them and
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
    if (scope === 'unscoped' || !row.saved || row.outsideNaas?.()) return true
    if (isCustomerContact(scope)) return false
    return ASSET_EDITOR_ROLES.some(hasRole) && rowVisible(scope, SCOPE.assets, row, ids)
}

/**
 * Whether the user may delete a record of hardware. A fleet asset leaves by disposal and keeps its record, its history
 * being the app's (ADR 0016), so only an app administrator deletes one (a unit taken in by mistake). Hardware outside
 * the fleet is left to the platform's ACLs.
 */
export function deletesFleetAsset(hasRole: (role: string) => boolean, row: ScopedRow): boolean {
    return !row.saved || hasRole(ROLE.admin) || !!row.outsideNaas?.()
}

/**
 * Whether the user may change, by hand, a field of hardware that ties it to a Customer or a cost (its company and
 * cost; the app's own columns, the Agreement, subscription line, lease, Lessor and Legal owner, have their asset-manager
 * ACLs). On a fleet asset only an asset manager (whom an app administrator holds) may: billing, margin and visibility
 * follow them, and the app's flows set them. Hardware outside the fleet is left to the platform's ACLs.
 */
export function writesFleetCommercialField(hasRole: (role: string) => boolean, row: ScopedRow): boolean {
    return !row.saved || hasRole(ROLE.assetManager) || !!row.outsideNaas?.()
}

/**
 * Whether the user may read a field of hardware that is the Provider's own figure (its cost). A Customer contact may
 * not on a fleet asset, though Customer Service's ACLs grant a contact holding its roles the cost of the Assets they
 * see; hardware outside the fleet is left to the platform's ACLs. (The app's own Provider columns on hardware, the
 * support cost, claim code, Lessor and lease, are read by provider staff alone.)
 */
export function readsFleetProviderField(scope: VisibilityScope, row: ScopedRow): boolean {
    if (!row.saved || !isCustomerContact(scope)) return true
    return !!row.outsideNaas?.()
}
