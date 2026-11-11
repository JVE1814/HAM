import '@servicenow/sdk/global'
import { Role } from '@servicenow/sdk/core'
import { BROAD_STAFF, EQUIPMENT_HANDLERS, MONEY_READERS, PLATFORM_ROLE, PROVIDER_STAFF, ROLE } from '../../server/domain/roles'

/*
 * The base-platform roles contained below must exist on the instance, as must the service desk's, which the ACLs grant
 * directly (`serviceDesk`): domain/roles PLATFORM_ROLE; see README "Required plugins".
 */

export const inventoryTech = Role({
    name: ROLE.inventoryTech,
    description: 'Depot and staging-centre technician: receiving, put-away, picking, staging and stockroom audits for assigned stockrooms.',
    containsRoles: [PLATFORM_ROLE.asset, PLATFORM_ROLE.inventoryUser, PLATFORM_ROLE.canvasUser],
})

export const fieldTech = Role({
    name: ROLE.fieldTech,
    description: 'Field engineer: installs, swaps, collects and audits equipment at customer sites (in addition to FSM roles).',
    containsRoles: [PLATFORM_ROLE.asset, PLATFORM_ROLE.canvasUser],
})

export const noc = Role({
    name: ROLE.noc,
    description: 'Network operations centre: reads the installed base, coverage and lifecycle data and raises proactive cases.',
    containsRoles: [PLATFORM_ROLE.canvasUser],
})

export const accountManager = Role({
    name: ROLE.accountManager,
    description: 'Owns customer agreements, catalog entries and site templates; approves over-quota orders.',
    containsRoles: [PLATFORM_ROLE.canvasUser],
})

export const finance = Role({
    name: ROLE.finance,
    description: 'Reads subscription lines and fee events; runs and closes billing periods.',
    containsRoles: [PLATFORM_ROLE.reportUser, PLATFORM_ROLE.canvasUser],
})

export const assetManager = Role({
    name: ROLE.assetManager,
    description: 'Provider asset manager: full lifecycle management across all customers.',
    // model_manager: the platform's ACLs let only it create and change Model lifecycle milestones (ADR 0017).
    containsRoles: [PLATFORM_ROLE.asset, PLATFORM_ROLE.inventoryUser, PLATFORM_ROLE.procurementUser, PLATFORM_ROLE.modelManager, PLATFORM_ROLE.reportUser, inventoryTech, noc],
})

export const admin = Role({
    name: ROLE.admin,
    description: 'Application administrator: configuration plus every provider role.',
    containsRoles: [assetManager, inventoryTech, fieldTech, noc, accountManager, finance, PLATFORM_ROLE.inventoryAdmin, PLATFORM_ROLE.procurementAdmin],
    scopedAdmin: true,
})

export const customerAdmin = Role({
    name: ROLE.customerAdmin,
    description: 'Customer network/IT admin (external): sees their own customer only; orders, raises faults, approves off-catalog orders, attests inventory.',
    containsRoles: [PLATFORM_ROLE.external],
})

export const siteContact = Role({
    name: ROLE.siteContact,
    description: 'Customer site contact (external): confirms deliveries and installs at their assigned sites.',
    containsRoles: [PLATFORM_ROLE.external],
})

export const integration = Role({
    name: ROLE.integration,
    description: 'Machine role for the provider NMS that posts device events (server-side writes need no table roles).',
})

/*
 * The role groups the access lists name, each defined here once. They hold role names, which every record that takes
 * roles reads (a navigator module takes nothing else), and a list keeps the order its module shows the roles in.
 */

/** Every provider-staff role: reads the installed base and the tables of stockroom work, the only app tables an inventory tech reads. */
export const providerStaff = PROVIDER_STAFF

/** Provider staff without inventory techs: the read list for customer, commercial and configuration tables. */
export const broadStaff = BROAD_STAFF

/**
 * The service desk (Customer Service agents, a platform role the ACLs name directly): raises Orders and Returns for any
 * Customer, so it reads the Agreements, Site templates, Orders and Returns that work needs, and no other NaaS table.
 */
export const serviceDesk = [PLATFORM_ROLE.serviceDeskAgent]

/** External customer roles; their reads are filtered to their own customer. */
export const customerRoles = [ROLE.customerAdmin, ROLE.siteContact]

/** Who writes Agreements, Catalog entries and the other commercial records. */
export const commercialEditors = [ROLE.accountManager, ROLE.assetManager]

/**
 * Who raises an Order or a Return for any Customer, from the navigator, a record producer or its form: provider roles
 * and the service desk. A customer admin raises them for their own Customer only, through the record producers, and has
 * create ACLs of its own that check the Customer (a Table API insert meets no producer); it creates no Order lines,
 * which the producer's script adds (platform/orders), past ACLs.
 */
export const orderRaisers = [ROLE.assetManager, ROLE.accountManager, ROLE.noc, PLATFORM_ROLE.serviceDeskAgent]

/** Who changes an Order as it is fulfilled. */
export const orderWorkers = [ROLE.assetManager, ROLE.accountManager, ROLE.noc, ROLE.inventoryTech, ROLE.fieldTech, PLATFORM_ROLE.serviceDeskAgent]

/** Who does the stockroom's work: receiving, staging, shipping, blind counts. */
export const stockroomWorkers = [ROLE.inventoryTech, ROLE.assetManager]

/** Who scans equipment: the warehouse page, and Audits with their lines. */
export const scanners = EQUIPMENT_HANDLERS

/** Who sends equipment back: opens OEM RMAs and Return lines, buys and voids labels. */
export const returnWorkers = [ROLE.assetManager, ROLE.inventoryTech, ROLE.noc]

/** Who writes Lease schedules and their decisions. */
export const leaseEditors = [ROLE.assetManager, ROLE.finance]

/** Who opens or closes a Service interval by hand, when a stage change could not (platform/service-intervals). */
export const intervalEditors = [ROLE.assetManager, ROLE.finance]

/** Roles that read the money tables (service intervals, billing, cost facts and margin), the NaaS dashboard's Margin tab among them. */
export const moneyReaders = MONEY_READERS

/** Every person the app serves, provider staff and Customer contacts: the rack elevations are open to them all. */
export const staffAndCustomers = [
    ROLE.assetManager,
    ROLE.inventoryTech,
    ROLE.fieldTech,
    ROLE.noc,
    ROLE.accountManager,
    ROLE.finance,
    ROLE.customerAdmin,
    ROLE.siteContact,
]

/*
 * Three of the groups again as role records, for the workspace's audiences: an Applicability stores role ids, which a
 * name does not give it. built-metadata.test.ts holds each audience to its group of names.
 */
export const providerStaffRecords = [assetManager, inventoryTech, fieldTech, noc, accountManager, finance]
export const broadStaffRecords = [assetManager, fieldTech, noc, accountManager, finance]
export const moneyReaderRecords = [finance, accountManager, assetManager]
