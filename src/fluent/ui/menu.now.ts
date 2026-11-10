import '@servicenow/sdk/global'
import { ApplicationMenu, Record } from '@servicenow/sdk/core'
import { broadStaff, providerStaff, staffOrderRaisers, stockroomWorkers } from '../security/roles.now'
import { ROLE } from '../../server/domain/visibility'
import { requestNetworkEquipment } from './order-producer.now'
import { requestReturn } from './return-producer.now'
import { OPEN_ORDERS_QUERY } from '../../server/domain/fulfilment'
import { OPEN_NORM_EXCEPTIONS_QUERY } from '../../server/domain/normalization'
import { OPEN_EXCEPTIONS_QUERY } from '../../server/domain/reconciliation'
import { FLEET_IN_STAGE, NAAS_MODEL_MILESTONES } from '../../server/domain/fleet'
import { WORKSPACE_HOME } from '../workspace/workspace.now'

/*
 * Navigator menu "NaaS Asset Management".
 *
 * A module on alm_hardware lists fleet assets only (ADR 0016: the table holds the Provider IT's equipment too): its
 * filter holds the fleet condition in each ^NQ clause, and none opens the table unfiltered (link type LIST), which
 * built-metadata.test.ts checks.
 */

export const naasMenu = ApplicationMenu({
    $id: Now.ID['menu_naas'],
    title: 'NaaS Asset Management',
    hint: 'Hardware asset management for network-as-a-service',
    roles: providerStaff,
    active: true,
})

Record({
    $id: Now.ID['module_workspace'],
    table: 'sys_app_module',
    data: {
        title: 'NaaS Asset Workspace',
        application: naasMenu,
        link_type: 'DIRECT',
        query: WORKSPACE_HOME,
        roles: providerStaff,
        active: true,
        order: 100,
    },
})

Record({
    $id: Now.ID['module_warehouse'],
    table: 'sys_app_module',
    data: {
        title: 'Warehouse scanning',
        application: naasMenu,
        link_type: 'DIRECT',
        query: 'x_daas_ham_warehouse.do',
        roles: stockroomWorkers,
        active: true,
        order: 110,
    },
})

Record({
    $id: Now.ID['module_request'],
    table: 'sys_app_module',
    data: {
        title: 'Request network equipment',
        application: naasMenu,
        link_type: 'DIRECT',
        query: `com.glideapp.servicecatalog_cat_item_view.do?v=1&sysparm_id=${requestNetworkEquipment.$id}`,
        roles: staffOrderRaisers,
        active: true,
        order: 120,
    },
})

Record({
    $id: Now.ID['module_sep_orders'],
    table: 'sys_app_module',
    data: {
        title: 'Orders',
        application: naasMenu,
        link_type: 'SEPARATOR',
        roles: providerStaff,
        active: true,
        order: 200,
    },
})

Record({
    $id: Now.ID['module_orders_open'],
    table: 'sys_app_module',
    data: {
        title: 'Open orders',
        application: naasMenu,
        link_type: 'FILTER',
        name: 'x_daas_ham_order',
        filter: OPEN_ORDERS_QUERY,
        roles: providerStaff,
        active: true,
        order: 210,
    },
})

Record({
    $id: Now.ID['module_orders_all'],
    table: 'sys_app_module',
    data: {
        title: 'All orders',
        application: naasMenu,
        link_type: 'LIST',
        name: 'x_daas_ham_order',
        roles: providerStaff,
        active: true,
        order: 220,
    },
})

Record({
    $id: Now.ID['module_order_lines'],
    table: 'sys_app_module',
    data: {
        title: 'Order lines',
        application: naasMenu,
        link_type: 'LIST',
        name: 'x_daas_ham_order_line',
        roles: providerStaff,
        active: true,
        order: 230,
    },
})

Record({
    $id: Now.ID['module_staging'],
    table: 'sys_app_module',
    data: {
        title: 'Staging tasks',
        application: naasMenu,
        link_type: 'FILTER',
        name: 'x_daas_ham_staging_task',
        filter: 'active=true',
        roles: providerStaff,
        active: true,
        order: 240,
    },
})

Record({
    $id: Now.ID['module_sep_base'],
    table: 'sys_app_module',
    data: {
        title: 'Installed base',
        application: naasMenu,
        link_type: 'SEPARATOR',
        roles: providerStaff,
        active: true,
        order: 300,
    },
})

Record({
    $id: Now.ID['module_assets_in_service'],
    table: 'sys_app_module',
    data: {
        title: 'In service',
        application: naasMenu,
        link_type: 'FILTER',
        name: 'alm_hardware',
        filter: FLEET_IN_STAGE.in_service,
        roles: providerStaff,
        active: true,
        order: 310,
    },
})

Record({
    $id: Now.ID['module_assets_pending'],
    table: 'sys_app_module',
    data: {
        title: 'Installed, not yet seen',
        application: naasMenu,
        link_type: 'FILTER',
        name: 'alm_hardware',
        filter: FLEET_IN_STAGE.pending_in_service,
        roles: providerStaff,
        active: true,
        order: 320,
    },
})

Record({
    $id: Now.ID['module_spare_pools'],
    table: 'sys_app_module',
    data: {
        title: 'Spare pools',
        application: naasMenu,
        link_type: 'FILTER',
        name: 'alm_hardware',
        filter: FLEET_IN_STAGE.spare_pool,
        roles: providerStaff,
        active: true,
        order: 330,
    },
})

Record({
    $id: Now.ID['module_device_events'],
    table: 'sys_app_module',
    data: {
        title: 'Device events',
        application: naasMenu,
        link_type: 'LIST',
        name: 'x_daas_ham_device_event',
        roles: broadStaff,
        active: true,
        order: 340,
    },
})

Record({
    $id: Now.ID['module_sep_commercial'],
    table: 'sys_app_module',
    data: {
        title: 'Commercial',
        application: naasMenu,
        link_type: 'SEPARATOR',
        roles: broadStaff,
        active: true,
        order: 400,
    },
})

Record({
    $id: Now.ID['module_agreements'],
    table: 'sys_app_module',
    data: {
        title: 'Agreements',
        application: naasMenu,
        link_type: 'LIST',
        name: 'x_daas_ham_agreement',
        roles: broadStaff,
        active: true,
        order: 410,
    },
})

Record({
    $id: Now.ID['module_subscription_lines'],
    table: 'sys_app_module',
    data: {
        title: 'Subscription lines',
        application: naasMenu,
        link_type: 'LIST',
        name: 'x_daas_ham_subscription_line',
        roles: broadStaff,
        active: true,
        order: 420,
    },
})

Record({
    $id: Now.ID['module_catalog_entries'],
    table: 'sys_app_module',
    data: {
        title: 'Catalog entries',
        application: naasMenu,
        link_type: 'LIST',
        name: 'x_daas_ham_catalog_entry',
        roles: broadStaff,
        active: true,
        order: 430,
    },
})

Record({
    $id: Now.ID['module_site_templates'],
    table: 'sys_app_module',
    data: {
        title: 'Site templates',
        application: naasMenu,
        link_type: 'LIST',
        name: 'x_daas_ham_site_template',
        roles: broadStaff,
        active: true,
        order: 440,
    },
})

Record({
    $id: Now.ID['module_sep_models'],
    table: 'sys_app_module',
    data: {
        title: 'Models',
        application: naasMenu,
        link_type: 'SEPARATOR',
        roles: broadStaff,
        active: true,
        order: 500,
    },
})

// The platform's table (ADR 0017), kept to the rows the app reads: the manufacturer milestones (lifecycle type
// Publisher) of NaaS Models. The form's default type, Internal, is an organisation's own plan, which the app ignores.
Record({
    $id: Now.ID['module_model_lifecycle'],
    table: 'sys_app_module',
    data: {
        title: 'Model lifecycle',
        application: naasMenu,
        link_type: 'LIST',
        name: 'cmdb_model_lifecycle',
        filter: NAAS_MODEL_MILESTONES,
        roles: broadStaff,
        active: true,
        order: 510,
    },
})

Record({
    $id: Now.ID['module_norm_exceptions'],
    table: 'sys_app_module',
    data: {
        title: 'Normalization exceptions',
        application: naasMenu,
        link_type: 'FILTER',
        name: 'x_daas_ham_norm_exception',
        filter: OPEN_NORM_EXCEPTIONS_QUERY,
        roles: broadStaff,
        active: true,
        order: 520,
    },
})

Record({
    $id: Now.ID['module_match_rules'],
    table: 'sys_app_module',
    data: {
        title: 'Model match rules',
        application: naasMenu,
        link_type: 'LIST',
        name: 'x_daas_ham_model_match_rule',
        roles: [ROLE.assetManager],
        active: true,
        order: 530,
    },
})

Record({
    $id: Now.ID['module_aliases'],
    table: 'sys_app_module',
    data: {
        title: 'Manufacturer aliases',
        application: naasMenu,
        link_type: 'LIST',
        name: 'x_daas_ham_manufacturer_alias',
        roles: [ROLE.assetManager],
        active: true,
        order: 540,
    },
})

Record({
    $id: Now.ID['module_staging_templates'],
    table: 'sys_app_module',
    data: {
        title: 'Staging checklist templates',
        application: naasMenu,
        link_type: 'LIST',
        name: 'x_daas_ham_staging_template',
        roles: [ROLE.assetManager],
        active: true,
        order: 550,
    },
})

Record({
    $id: Now.ID['module_sep_imports'],
    table: 'sys_app_module',
    data: {
        title: 'Imports',
        application: naasMenu,
        link_type: 'SEPARATOR',
        roles: stockroomWorkers,
        active: true,
        order: 600,
    },
})

Record({
    $id: Now.ID['module_asn_import'],
    table: 'sys_app_module',
    data: {
        title: 'ASN import rows',
        application: naasMenu,
        link_type: 'LIST',
        name: 'x_daas_ham_asn_import',
        roles: stockroomWorkers,
        active: true,
        order: 610,
    },
})

Record({
    $id: Now.ID['module_eox_import'],
    table: 'sys_app_module',
    data: {
        title: 'Lifecycle import rows',
        application: naasMenu,
        link_type: 'LIST',
        name: 'x_daas_ham_eox_import',
        roles: [ROLE.assetManager],
        active: true,
        order: 620,
    },
})

Record({
    $id: Now.ID['module_load_data'],
    table: 'sys_app_module',
    data: {
        title: 'Load data',
        application: naasMenu,
        link_type: 'DIRECT',
        query: 'sys_import.do',
        roles: stockroomWorkers,
        active: true,
        order: 630,
    },
})

Record({
    $id: Now.ID['module_sep_admin'],
    table: 'sys_app_module',
    data: {
        title: 'Administration',
        application: naasMenu,
        link_type: 'SEPARATOR',
        roles: [ROLE.admin],
        active: true,
        order: 900,
    },
})

Record({
    $id: Now.ID['module_properties'],
    table: 'sys_app_module',
    data: {
        title: 'Properties',
        application: naasMenu,
        link_type: 'FILTER',
        name: 'sys_properties',
        filter: 'nameSTARTSWITHx_daas_ham.',
        roles: [ROLE.admin],
        active: true,
        order: 910,
    },
})

Record({
    $id: Now.ID['module_job_cursors'],
    table: 'sys_app_module',
    data: {
        title: 'Background jobs',
        application: naasMenu,
        link_type: 'LIST',
        name: 'x_daas_ham_job_cursor',
        roles: [ROLE.admin],
        active: true,
        order: 920,
    },
})

Record({
    $id: Now.ID['module_racks'],
    table: 'sys_app_module',
    data: {
        title: 'Rack elevations',
        application: naasMenu,
        link_type: 'DIRECT',
        query: 'x_daas_ham_racks.do',
        roles: providerStaff,
        active: true,
        order: 130,
    },
})

Record({
    $id: Now.ID['module_customer_page'],
    table: 'sys_app_module',
    data: {
        title: 'Customer self-service (preview)',
        application: naasMenu,
        link_type: 'DIRECT',
        query: 'x_daas_ham_customer.do',
        roles: [ROLE.assetManager],
        active: true,
        order: 140,
    },
})

Record({
    $id: Now.ID['module_request_return'],
    table: 'sys_app_module',
    data: {
        title: 'Return or decommission equipment',
        application: naasMenu,
        link_type: 'DIRECT',
        query: `com.glideapp.servicecatalog_cat_item_view.do?v=1&sysparm_id=${requestReturn.$id}`,
        roles: staffOrderRaisers,
        active: true,
        order: 150,
    },
})

Record({
    $id: Now.ID['module_sep_aftersales'],
    table: 'sys_app_module',
    data: {
        title: 'After-sales',
        application: naasMenu,
        link_type: 'SEPARATOR',
        roles: providerStaff,
        active: true,
        order: 350,
    },
})

Record({
    $id: Now.ID['module_returns_open'],
    table: 'sys_app_module',
    data: {
        title: 'Open returns',
        application: naasMenu,
        link_type: 'FILTER',
        name: 'x_daas_ham_return_order',
        filter: 'active=true',
        roles: providerStaff,
        active: true,
        order: 355,
    },
})

Record({
    $id: Now.ID['module_return_lines'],
    table: 'sys_app_module',
    data: {
        title: 'Return lines',
        application: naasMenu,
        link_type: 'LIST',
        name: 'x_daas_ham_return_order_line',
        roles: providerStaff,
        active: true,
        order: 357,
    },
})

Record({
    $id: Now.ID['module_oem_rmas'],
    table: 'sys_app_module',
    data: {
        title: 'OEM RMAs',
        application: naasMenu,
        link_type: 'LIST',
        name: 'x_daas_ham_oem_rma',
        roles: providerStaff,
        active: true,
        order: 360,
    },
})

Record({
    $id: Now.ID['module_oem_coverage'],
    table: 'sys_app_module',
    data: {
        title: 'OEM coverage',
        application: naasMenu,
        link_type: 'LIST',
        name: 'x_daas_ham_oem_coverage',
        roles: broadStaff,
        active: true,
        order: 365,
    },
})

Record({
    $id: Now.ID['module_disposals'],
    table: 'sys_app_module',
    data: {
        title: 'Disposal orders',
        application: naasMenu,
        link_type: 'LIST',
        name: 'x_daas_ham_disposal_order',
        roles: providerStaff,
        active: true,
        order: 370,
    },
})

Record({
    $id: Now.ID['module_fee_events'],
    table: 'sys_app_module',
    data: {
        title: 'Fee events',
        application: naasMenu,
        link_type: 'LIST',
        name: 'x_daas_ham_fee_event',
        roles: broadStaff,
        active: true,
        order: 375,
    },
})

Record({
    $id: Now.ID['module_sep_assurance'],
    table: 'sys_app_module',
    data: {
        title: 'Assurance',
        application: naasMenu,
        link_type: 'SEPARATOR',
        roles: providerStaff,
        active: true,
        order: 380,
    },
})

Record({
    $id: Now.ID['module_audits'],
    table: 'sys_app_module',
    data: {
        title: 'Audits',
        application: naasMenu,
        link_type: 'LIST',
        name: 'x_daas_ham_audit',
        roles: providerStaff,
        active: true,
        order: 382,
    },
})

Record({
    $id: Now.ID['module_attestations'],
    table: 'sys_app_module',
    data: {
        title: 'Attestations',
        application: naasMenu,
        link_type: 'LIST',
        name: 'x_daas_ham_attestation',
        roles: broadStaff,
        active: true,
        order: 384,
    },
})

Record({
    $id: Now.ID['module_exceptions'],
    table: 'sys_app_module',
    data: {
        title: 'Reconciliation exceptions',
        application: naasMenu,
        link_type: 'FILTER',
        name: 'x_daas_ham_recon_exception',
        filter: OPEN_EXCEPTIONS_QUERY,
        roles: broadStaff,
        active: true,
        order: 386,
    },
})

Record({
    $id: Now.ID['module_coverage_import'],
    table: 'sys_app_module',
    data: {
        title: 'OEM coverage import rows',
        application: naasMenu,
        link_type: 'LIST',
        name: 'x_daas_ham_coverage_import',
        roles: [ROLE.assetManager],
        active: true,
        order: 625,
    },
})
