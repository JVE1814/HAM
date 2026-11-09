import '@servicenow/sdk/global'
import { Role } from '@servicenow/sdk/core'

/*
 * Base-platform roles contained below (asset, inventory_user, inventory_admin, procurement_user,
 * procurement_admin, report_user, snc_external, canvas_user) must exist on the instance, as must
 * sn_customerservice_agent, which the ACLs grant directly (serviceDesk); see README "Required plugins".
 */

export const inventoryTech = Role({
    name: 'x_daas_ham.inventory_tech',
    description: 'Depot and staging-centre technician: receiving, put-away, picking, staging and stockroom audits for assigned stockrooms.',
    containsRoles: ['asset', 'inventory_user', 'canvas_user'],
})

export const fieldTech = Role({
    name: 'x_daas_ham.field_tech',
    description: 'Field engineer: installs, swaps, collects and audits equipment at customer sites (in addition to FSM roles).',
    containsRoles: ['asset', 'canvas_user'],
})

export const noc = Role({
    name: 'x_daas_ham.noc',
    description: 'Network operations centre: reads the installed base, coverage and lifecycle data and raises proactive cases.',
    containsRoles: ['canvas_user'],
})

export const accountManager = Role({
    name: 'x_daas_ham.account_manager',
    description: 'Owns customer agreements, catalog entries and site templates; approves over-quota orders.',
    containsRoles: ['canvas_user'],
})

export const finance = Role({
    name: 'x_daas_ham.finance',
    description: 'Reads subscription lines and fee events; runs and closes billing periods.',
    containsRoles: ['report_user', 'canvas_user'],
})

export const assetManager = Role({
    name: 'x_daas_ham.asset_manager',
    description: 'Provider asset manager: full lifecycle management across all customers.',
    containsRoles: ['asset', 'inventory_user', 'procurement_user', 'report_user', inventoryTech, noc],
})

export const admin = Role({
    name: 'x_daas_ham.admin',
    description: 'Application administrator: configuration plus every provider role.',
    containsRoles: [assetManager, inventoryTech, fieldTech, noc, accountManager, finance, 'inventory_admin', 'procurement_admin'],
    scopedAdmin: true,
})

export const customerAdmin = Role({
    name: 'x_daas_ham.customer_admin',
    description: 'Customer network/IT admin (external): sees their own customer only; orders, raises faults, approves off-catalog orders, attests inventory.',
    containsRoles: ['snc_external'],
})

export const siteContact = Role({
    name: 'x_daas_ham.site_contact',
    description: 'Customer site contact (external): confirms deliveries and installs at their assigned sites.',
    containsRoles: ['snc_external'],
})

export const integration = Role({
    name: 'x_daas_ham.integration',
    description: 'Machine role for the provider NMS that posts device events (server-side writes need no table roles).',
})

/** Every provider-staff role: reads the installed base and the tables of stockroom work (INVENTORY_TECH_TABLES in domain/visibility.ts). */
export const providerStaff = [assetManager, inventoryTech, fieldTech, noc, accountManager, finance]

/** Provider staff without inventory techs: the read list for customer, commercial and configuration tables. */
export const broadStaff = [assetManager, fieldTech, noc, accountManager, finance]

/**
 * Roles that may change a fleet asset by hand: its lifecycle data (an inventory tech only in their stockrooms). The
 * hardware write check (acls-hardware.now.ts, entry/visibility `writesAsset`) reads them as domain/visibility
 * ASSET_EDITOR_ROLES, which the security tests check against this list.
 */
export const assetEditors = [assetManager, inventoryTech, fieldTech]

/** Roles that read the money tables (service intervals, billing, cost facts and margin), the NaaS dashboard's Margin tab among them. */
export const moneyReaders = [finance, accountManager, assetManager]

/**
 * The service desk (Customer Service agents, a platform role the ACLs name directly): raises Orders and Returns for any
 * Customer, so it reads the Agreements, Site templates, Orders and Returns that work needs, and no other NaaS table.
 */
export const serviceDesk = 'sn_customerservice_agent'

/** External customer roles; their reads are filtered to their own customer. */
export const customerRoles = [customerAdmin, siteContact]
