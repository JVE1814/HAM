import '@servicenow/sdk/global'
import { Role } from '@servicenow/sdk/core'

/*
 * Base-platform roles contained below (asset, inventory_user, inventory_admin, procurement_user,
 * procurement_admin, model_manager, report_user, snc_external) must exist on the instance; see README "Required
 * plugins".
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
    // model_manager: the platform's ACLs let only it create and change Model lifecycle milestones (ADR 0017).
    containsRoles: ['asset', 'inventory_user', 'procurement_user', 'model_manager', 'report_user', inventoryTech, noc],
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

/** Roles that may change lifecycle data. */
export const assetEditors = [assetManager, inventoryTech, fieldTech]

/** External customer roles; their reads are filtered to their own customer. */
export const customerRoles = [customerAdmin, siteContact]
