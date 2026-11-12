/**
 * The app's role names, the platform roles it relies on, and the role groups that both the metadata
 * (fluent/shared/roles.now.ts) and the server code or the pages name, so that each group is written once.
 */

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
 * Customer. The metadata's read lists are this list.
 */
export const BROAD_STAFF = [ROLE.assetManager, ROLE.fieldTech, ROLE.noc, ROLE.accountManager, ROLE.finance]

/**
 * Every provider-staff role: who reads the installed base, and so opens an Asset's form (the rack page links a device
 * to it for them only). The metadata's `providerStaff` (shared/roles.now.ts) is this list, in the order the
 * navigator's modules store it.
 */
export const PROVIDER_STAFF = [ROLE.assetManager, ROLE.inventoryTech, ROLE.fieldTech, ROLE.noc, ROLE.accountManager, ROLE.finance]

/**
 * Who handles equipment by hand: scans it (the warehouse page, Audits with their lines) and changes a fleet asset's
 * lifecycle data on a form, a list or the Table API. An inventory tech only of their Stockrooms. A Customer's
 * Agreement, subscription line and lease, its company and its cost are the asset manager's alone
 * (domain/visibility writesFleetCommercialField).
 */
export const EQUIPMENT_HANDLERS = [ROLE.assetManager, ROLE.inventoryTech, ROLE.fieldTech]

/**
 * Who opens the customer page and calls its routes: Customer contacts, and asset managers as a preview, which shows
 * every Customer. The Customer-admin actions stay with Customer admins (domain/visibility actsAsCustomerAdmin).
 */
export const CUSTOMER_PAGE_USERS = [ROLE.customerAdmin, ROLE.siteContact, ROLE.assetManager]

/** The Customer contacts' roles: their reads are kept to their own Customer, and a site contact's to their Sites. */
export const CUSTOMER_CONTACTS = [ROLE.customerAdmin, ROLE.siteContact]

/**
 * Who opens the rack page and calls its routes: every person the app serves, PROVIDER_STAFF and CUSTOMER_CONTACTS.
 * Written out, as the metadata cannot evaluate a spread.
 */
export const RACK_PAGE_USERS = [
    ROLE.assetManager,
    ROLE.inventoryTech,
    ROLE.fieldTech,
    ROLE.noc,
    ROLE.accountManager,
    ROLE.finance,
    ROLE.customerAdmin,
    ROLE.siteContact,
]

/** The roles that read the money tables: service intervals, billing, cost facts and margin. */
export const MONEY_READERS = [ROLE.finance, ROLE.accountManager, ROLE.assetManager]
