import '@servicenow/sdk/global'
import { Record, Role } from '@servicenow/sdk/core'
import { PLATFORM_ROLE, PROVIDER_STAFF, ROLE } from '../../server/domain/roles'

/*
 * The base-platform roles contained below must exist on the instance, as must the service desk's, which the ACLs grant
 * directly (`serviceDesk`); see README "Required plugins".
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

export const billingReader = Role({
    name: ROLE.billingReader,
    description: 'Machine role for the billing consumer (an ERP) that reads Billing periods and their lines through the pull API; it grants no table and posts no device events.',
})

/*
 * The role groups hold role names, which every record that takes
 * roles reads (a navigator module takes nothing else), and a list keeps the order its module shows the roles in.
 */

/** Every provider-staff role: reads the installed base and the tables of stockroom work, the only app tables an inventory tech reads. */
export const providerStaff = PROVIDER_STAFF

/**
 * The service desk (Customer Service agents, a platform role the ACLs name directly): raises Orders and Returns for any
 * Customer, so it reads the Agreements, Site templates, Orders and Returns that work needs, and no other NaaS table.
 */
export const serviceDesk = [PLATFORM_ROLE.serviceDeskAgent]

/** Who writes Agreements, Catalog entries and the other commercial records. */
export const commercialEditors = [ROLE.accountManager, ROLE.assetManager]

/**
 * Who raises an Order or a Return for any Customer, from the navigator, a record producer or its form: provider roles
 * and the service desk. A customer admin raises them for their own Customer only, through the record producers, and has
 * create ACLs of its own that check the Customer (a Table API insert meets no producer); it creates no Order lines,
 * which the producer's script adds, past ACLs.
 */
export const orderRaisers = [ROLE.assetManager, ROLE.accountManager, ROLE.noc, PLATFORM_ROLE.serviceDeskAgent]

/**
 * Who may open the record producers "Request network equipment" and "Return or decommission network equipment": the
 * Order raisers and Customer admins, never site contacts (docs/spec/p1-ordering.md, p2-aftersales.md). The service
 * desk's role is the platform's, whose sys_id differs from instance to instance, so the script matches it by name.
 * The platform also gives each producer "Not available for: SNC External", which wins over this and keeps the Customer
 * admins out until an admin removes it (README "Install").
 */
export const producerRequesters = Record({
    $id: Now.ID['uc_order_raisers'],
    table: 'user_criteria',
    data: {
        name: 'NaaS - Order and Return raisers',
        active: true,
        match_all: false,
        role: [
            Now.ref('sys_user_role', { name: ROLE.assetManager }),
            Now.ref('sys_user_role', { name: ROLE.accountManager }),
            Now.ref('sys_user_role', { name: ROLE.noc }),
            Now.ref('sys_user_role', { name: ROLE.customerAdmin }),
        ],
        advanced: true,
        script: `var held = new GlideRecord('sys_user_has_role');
held.addQuery('user', user_id);
held.addQuery('role.name', '${PLATFORM_ROLE.serviceDeskAgent}');
held.setLimit(1);
held.query();
answer = held.hasNext();`,
    },
})

/** Who changes an Order as it is fulfilled. */
export const orderWorkers = [ROLE.assetManager, ROLE.accountManager, ROLE.noc, ROLE.inventoryTech, ROLE.fieldTech, PLATFORM_ROLE.serviceDeskAgent]

/** Who changes a Return as it is worked: the Order workers but the service desk, which raises Returns and works none. */
export const returnEditors = [ROLE.assetManager, ROLE.accountManager, ROLE.noc, ROLE.inventoryTech, ROLE.fieldTech]

/** Who changes an Attestation from the provider side: its Customer admin answers it through the customer page instead. */
export const attestationEditors = [ROLE.accountManager, ROLE.assetManager]

/** Who does the stockroom's work: receiving, staging, shipping, blind counts. */
export const stockroomWorkers = [ROLE.inventoryTech, ROLE.assetManager]

/** Who sends equipment back: opens OEM RMAs and Return lines, buys and voids labels. */
export const returnWorkers = [ROLE.assetManager, ROLE.inventoryTech, ROLE.noc]

/** Who writes Lease schedules and their decisions. */
export const leaseEditors = [ROLE.assetManager, ROLE.finance]

/** Who raises or corrects a Fee event by hand, besides the charges the returns workflow raises. */
export const feeEditors = [ROLE.assetManager, ROLE.finance]

/** Who opens or closes a Service interval by hand, when a stage change could not. */
export const intervalEditors = [ROLE.assetManager, ROLE.finance]
