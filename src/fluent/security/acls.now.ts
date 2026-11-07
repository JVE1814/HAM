import '@servicenow/sdk/global'
import { Acl } from '@servicenow/sdk/core'
import {
    accountManager,
    finance,
    admin,
    assetManager,
    customerAdmin,
    customerRoles,
    fieldTech,
    integration,
    inventoryTech,
    noc,
    providerStaff,
} from './roles.now'

/*
 * Access controls for app tables. Reads are also narrowed by the before-query rules in
 * visibility.now.ts (ADR 0005); customer ACLs re-check the customer so a direct link cannot leak data.
 */

const commercialEditors = [accountManager, assetManager]
const orderRaisers = [assetManager, accountManager, noc, customerAdmin, 'sn_customerservice_agent']
const orderWorkers = [assetManager, accountManager, noc, inventoryTech, fieldTech, 'sn_customerservice_agent']
const stagingWorkers = [inventoryTech, assetManager]

Acl({
    $id: Now.ID['acl_agreement_read'],
    type: 'record',
    table: 'x_daas_ham_agreement',
    operation: 'read',
    roles: providerStaff,
})

Acl({
    $id: Now.ID['acl_agreement_write'],
    type: 'record',
    table: 'x_daas_ham_agreement',
    operation: 'write',
    roles: commercialEditors,
})

Acl({
    $id: Now.ID['acl_agreement_create'],
    type: 'record',
    table: 'x_daas_ham_agreement',
    operation: 'create',
    roles: commercialEditors,
})

Acl({
    $id: Now.ID['acl_agreement_delete'],
    type: 'record',
    table: 'x_daas_ham_agreement',
    operation: 'delete',
    roles: commercialEditors,
})

Acl({
    $id: Now.ID['acl_agreement_quantity_read'],
    type: 'record',
    table: 'x_daas_ham_agreement_quantity',
    operation: 'read',
    roles: providerStaff,
})

Acl({
    $id: Now.ID['acl_agreement_quantity_write'],
    type: 'record',
    table: 'x_daas_ham_agreement_quantity',
    operation: 'write',
    roles: commercialEditors,
})

Acl({
    $id: Now.ID['acl_agreement_quantity_create'],
    type: 'record',
    table: 'x_daas_ham_agreement_quantity',
    operation: 'create',
    roles: commercialEditors,
})

Acl({
    $id: Now.ID['acl_agreement_quantity_delete'],
    type: 'record',
    table: 'x_daas_ham_agreement_quantity',
    operation: 'delete',
    roles: commercialEditors,
})

Acl({
    $id: Now.ID['acl_subscription_line_read'],
    type: 'record',
    table: 'x_daas_ham_subscription_line',
    operation: 'read',
    roles: providerStaff,
})

Acl({
    $id: Now.ID['acl_subscription_line_write'],
    type: 'record',
    table: 'x_daas_ham_subscription_line',
    operation: 'write',
    roles: commercialEditors,
})

Acl({
    $id: Now.ID['acl_subscription_line_create'],
    type: 'record',
    table: 'x_daas_ham_subscription_line',
    operation: 'create',
    roles: commercialEditors,
})

Acl({
    $id: Now.ID['acl_subscription_line_delete'],
    type: 'record',
    table: 'x_daas_ham_subscription_line',
    operation: 'delete',
    roles: commercialEditors,
})

Acl({
    $id: Now.ID['acl_catalog_entry_read'],
    type: 'record',
    table: 'x_daas_ham_catalog_entry',
    operation: 'read',
    roles: providerStaff,
})

Acl({
    $id: Now.ID['acl_catalog_entry_write'],
    type: 'record',
    table: 'x_daas_ham_catalog_entry',
    operation: 'write',
    roles: commercialEditors,
})

Acl({
    $id: Now.ID['acl_catalog_entry_create'],
    type: 'record',
    table: 'x_daas_ham_catalog_entry',
    operation: 'create',
    roles: commercialEditors,
})

Acl({
    $id: Now.ID['acl_catalog_entry_delete'],
    type: 'record',
    table: 'x_daas_ham_catalog_entry',
    operation: 'delete',
    roles: commercialEditors,
})

Acl({
    $id: Now.ID['acl_site_template_read'],
    type: 'record',
    table: 'x_daas_ham_site_template',
    operation: 'read',
    roles: providerStaff,
})

Acl({
    $id: Now.ID['acl_site_template_write'],
    type: 'record',
    table: 'x_daas_ham_site_template',
    operation: 'write',
    roles: commercialEditors,
})

Acl({
    $id: Now.ID['acl_site_template_create'],
    type: 'record',
    table: 'x_daas_ham_site_template',
    operation: 'create',
    roles: commercialEditors,
})

Acl({
    $id: Now.ID['acl_site_template_delete'],
    type: 'record',
    table: 'x_daas_ham_site_template',
    operation: 'delete',
    roles: commercialEditors,
})

Acl({
    $id: Now.ID['acl_site_template_item_read'],
    type: 'record',
    table: 'x_daas_ham_site_template_item',
    operation: 'read',
    roles: providerStaff,
})

Acl({
    $id: Now.ID['acl_site_template_item_write'],
    type: 'record',
    table: 'x_daas_ham_site_template_item',
    operation: 'write',
    roles: commercialEditors,
})

Acl({
    $id: Now.ID['acl_site_template_item_create'],
    type: 'record',
    table: 'x_daas_ham_site_template_item',
    operation: 'create',
    roles: commercialEditors,
})

Acl({
    $id: Now.ID['acl_site_template_item_delete'],
    type: 'record',
    table: 'x_daas_ham_site_template_item',
    operation: 'delete',
    roles: commercialEditors,
})

Acl({
    $id: Now.ID['acl_agreement_read_customer'],
    type: 'record',
    table: 'x_daas_ham_agreement',
    operation: 'read',
    roles: [customerAdmin],
    script: "answer = current.getValue('customer') == gs.getUser().getCompanyID();",
})

Acl({
    $id: Now.ID['acl_subscription_line_read_customer'],
    type: 'record',
    table: 'x_daas_ham_subscription_line',
    operation: 'read',
    roles: [customerAdmin],
    script: "answer = current.getValue('customer') == gs.getUser().getCompanyID();",
})

Acl({
    $id: Now.ID['acl_catalog_entry_read_customer'],
    type: 'record',
    table: 'x_daas_ham_catalog_entry',
    operation: 'read',
    roles: [customerAdmin],
    script: "answer = current.getValue('customer') == gs.getUser().getCompanyID();",
})

Acl({
    $id: Now.ID['acl_site_template_read_customer'],
    type: 'record',
    table: 'x_daas_ham_site_template',
    operation: 'read',
    roles: [customerAdmin],
})

Acl({
    $id: Now.ID['acl_site_template_item_read_customer'],
    type: 'record',
    table: 'x_daas_ham_site_template_item',
    operation: 'read',
    roles: [customerAdmin],
})

Acl({
    $id: Now.ID['acl_order_read'],
    type: 'record',
    table: 'x_daas_ham_order',
    operation: 'read',
    roles: providerStaff,
})

Acl({
    $id: Now.ID['acl_order_read_customer'],
    type: 'record',
    table: 'x_daas_ham_order',
    operation: 'read',
    roles: customerRoles,
    script: "answer = current.getValue('customer') == gs.getUser().getCompanyID();",
})

Acl({
    $id: Now.ID['acl_order_create'],
    type: 'record',
    table: 'x_daas_ham_order',
    operation: 'create',
    roles: orderRaisers,
})

Acl({
    $id: Now.ID['acl_order_write'],
    type: 'record',
    table: 'x_daas_ham_order',
    operation: 'write',
    roles: orderWorkers,
})

Acl({
    $id: Now.ID['acl_order_delete'],
    type: 'record',
    table: 'x_daas_ham_order',
    operation: 'delete',
    roles: [admin],
})

Acl({
    $id: Now.ID['acl_order_line_read'],
    type: 'record',
    table: 'x_daas_ham_order_line',
    operation: 'read',
    roles: providerStaff,
})

Acl({
    $id: Now.ID['acl_order_line_read_customer'],
    type: 'record',
    table: 'x_daas_ham_order_line',
    operation: 'read',
    roles: customerRoles,
    script: "answer = current.order.customer.toString() == gs.getUser().getCompanyID();",
})

Acl({
    $id: Now.ID['acl_order_line_create'],
    type: 'record',
    table: 'x_daas_ham_order_line',
    operation: 'create',
    roles: orderRaisers,
})

Acl({
    $id: Now.ID['acl_order_line_write'],
    type: 'record',
    table: 'x_daas_ham_order_line',
    operation: 'write',
    roles: orderWorkers,
})

Acl({
    $id: Now.ID['acl_order_line_delete'],
    type: 'record',
    table: 'x_daas_ham_order_line',
    operation: 'delete',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_staging_task_read'],
    type: 'record',
    table: 'x_daas_ham_staging_task',
    operation: 'read',
    roles: providerStaff,
})

Acl({
    $id: Now.ID['acl_staging_task_create'],
    type: 'record',
    table: 'x_daas_ham_staging_task',
    operation: 'create',
    roles: stagingWorkers,
})

Acl({
    $id: Now.ID['acl_staging_task_write'],
    type: 'record',
    table: 'x_daas_ham_staging_task',
    operation: 'write',
    roles: stagingWorkers,
})

Acl({
    $id: Now.ID['acl_staging_task_delete'],
    type: 'record',
    table: 'x_daas_ham_staging_task',
    operation: 'delete',
    roles: [admin],
})

Acl({
    $id: Now.ID['acl_staging_step_read'],
    type: 'record',
    table: 'x_daas_ham_staging_step',
    operation: 'read',
    roles: providerStaff,
})

Acl({
    $id: Now.ID['acl_staging_step_create'],
    type: 'record',
    table: 'x_daas_ham_staging_step',
    operation: 'create',
    roles: stagingWorkers,
})

Acl({
    $id: Now.ID['acl_staging_step_write'],
    type: 'record',
    table: 'x_daas_ham_staging_step',
    operation: 'write',
    roles: stagingWorkers,
})

Acl({
    $id: Now.ID['acl_staging_step_delete'],
    type: 'record',
    table: 'x_daas_ham_staging_step',
    operation: 'delete',
    roles: [admin],
})

Acl({
    $id: Now.ID['acl_staging_template_read'],
    type: 'record',
    table: 'x_daas_ham_staging_template',
    operation: 'read',
    roles: providerStaff,
})

Acl({
    $id: Now.ID['acl_staging_template_write'],
    type: 'record',
    table: 'x_daas_ham_staging_template',
    operation: 'write',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_staging_template_create'],
    type: 'record',
    table: 'x_daas_ham_staging_template',
    operation: 'create',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_staging_template_delete'],
    type: 'record',
    table: 'x_daas_ham_staging_template',
    operation: 'delete',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_staging_tmpl_item_read'],
    type: 'record',
    table: 'x_daas_ham_staging_tmpl_item',
    operation: 'read',
    roles: providerStaff,
})

Acl({
    $id: Now.ID['acl_staging_tmpl_item_write'],
    type: 'record',
    table: 'x_daas_ham_staging_tmpl_item',
    operation: 'write',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_staging_tmpl_item_create'],
    type: 'record',
    table: 'x_daas_ham_staging_tmpl_item',
    operation: 'create',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_staging_tmpl_item_delete'],
    type: 'record',
    table: 'x_daas_ham_staging_tmpl_item',
    operation: 'delete',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_manufacturer_alias_read'],
    type: 'record',
    table: 'x_daas_ham_manufacturer_alias',
    operation: 'read',
    roles: providerStaff,
})

Acl({
    $id: Now.ID['acl_manufacturer_alias_write'],
    type: 'record',
    table: 'x_daas_ham_manufacturer_alias',
    operation: 'write',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_manufacturer_alias_create'],
    type: 'record',
    table: 'x_daas_ham_manufacturer_alias',
    operation: 'create',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_manufacturer_alias_delete'],
    type: 'record',
    table: 'x_daas_ham_manufacturer_alias',
    operation: 'delete',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_model_match_rule_read'],
    type: 'record',
    table: 'x_daas_ham_model_match_rule',
    operation: 'read',
    roles: providerStaff,
})

Acl({
    $id: Now.ID['acl_model_match_rule_write'],
    type: 'record',
    table: 'x_daas_ham_model_match_rule',
    operation: 'write',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_model_match_rule_create'],
    type: 'record',
    table: 'x_daas_ham_model_match_rule',
    operation: 'create',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_model_match_rule_delete'],
    type: 'record',
    table: 'x_daas_ham_model_match_rule',
    operation: 'delete',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_model_lifecycle_read'],
    type: 'record',
    table: 'x_daas_ham_model_lifecycle',
    operation: 'read',
    roles: providerStaff,
})

Acl({
    $id: Now.ID['acl_model_lifecycle_write'],
    type: 'record',
    table: 'x_daas_ham_model_lifecycle',
    operation: 'write',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_model_lifecycle_create'],
    type: 'record',
    table: 'x_daas_ham_model_lifecycle',
    operation: 'create',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_model_lifecycle_delete'],
    type: 'record',
    table: 'x_daas_ham_model_lifecycle',
    operation: 'delete',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_norm_exception_read'],
    type: 'record',
    table: 'x_daas_ham_norm_exception',
    operation: 'read',
    roles: providerStaff,
})

Acl({
    $id: Now.ID['acl_norm_exception_write'],
    type: 'record',
    table: 'x_daas_ham_norm_exception',
    operation: 'write',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_norm_exception_create'],
    type: 'record',
    table: 'x_daas_ham_norm_exception',
    operation: 'create',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_norm_exception_delete'],
    type: 'record',
    table: 'x_daas_ham_norm_exception',
    operation: 'delete',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_stockroom_member_read'],
    type: 'record',
    table: 'x_daas_ham_stockroom_member',
    operation: 'read',
    roles: providerStaff,
})

Acl({
    $id: Now.ID['acl_stockroom_member_write'],
    type: 'record',
    table: 'x_daas_ham_stockroom_member',
    operation: 'write',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_stockroom_member_create'],
    type: 'record',
    table: 'x_daas_ham_stockroom_member',
    operation: 'create',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_stockroom_member_delete'],
    type: 'record',
    table: 'x_daas_ham_stockroom_member',
    operation: 'delete',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_device_event_read'],
    type: 'record',
    table: 'x_daas_ham_device_event',
    operation: 'read',
    roles: providerStaff,
})

Acl({
    $id: Now.ID['acl_device_event_create'],
    type: 'record',
    table: 'x_daas_ham_device_event',
    operation: 'create',
    roles: [integration, assetManager],
})

Acl({
    $id: Now.ID['acl_device_event_write'],
    type: 'record',
    table: 'x_daas_ham_device_event',
    operation: 'write',
    roles: [admin],
})

Acl({
    $id: Now.ID['acl_device_event_delete'],
    type: 'record',
    table: 'x_daas_ham_device_event',
    operation: 'delete',
    roles: [admin],
})

Acl({
    $id: Now.ID['acl_job_cursor_read'],
    type: 'record',
    table: 'x_daas_ham_job_cursor',
    operation: 'read',
    roles: [admin],
})

Acl({
    $id: Now.ID['acl_job_cursor_write'],
    type: 'record',
    table: 'x_daas_ham_job_cursor',
    operation: 'write',
    roles: [admin],
})

Acl({
    $id: Now.ID['acl_job_cursor_create'],
    type: 'record',
    table: 'x_daas_ham_job_cursor',
    operation: 'create',
    roles: [admin],
})

Acl({
    $id: Now.ID['acl_job_cursor_delete'],
    type: 'record',
    table: 'x_daas_ham_job_cursor',
    operation: 'delete',
    roles: [admin],
})

Acl({
    $id: Now.ID['acl_alm_hardware_read_staff'],
    type: 'record',
    table: 'alm_hardware',
    operation: 'read',
    roles: providerStaff,
})

Acl({
    $id: Now.ID['acl_alm_hardware_read_customer'],
    type: 'record',
    table: 'alm_hardware',
    operation: 'read',
    roles: customerRoles,
    script: "answer = current.getValue('company') == gs.getUser().getCompanyID();",
})
Acl({
    $id: Now.ID['acl_asn_import_read'],
    type: 'record',
    table: 'x_daas_ham_asn_import',
    operation: 'read',
    roles: [inventoryTech, assetManager],
})

Acl({
    $id: Now.ID['acl_asn_import_create'],
    type: 'record',
    table: 'x_daas_ham_asn_import',
    operation: 'create',
    roles: [inventoryTech, assetManager],
})

Acl({
    $id: Now.ID['acl_asn_import_write'],
    type: 'record',
    table: 'x_daas_ham_asn_import',
    operation: 'write',
    roles: [inventoryTech, assetManager],
})

Acl({
    $id: Now.ID['acl_eox_import_read'],
    type: 'record',
    table: 'x_daas_ham_eox_import',
    operation: 'read',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_eox_import_create'],
    type: 'record',
    table: 'x_daas_ham_eox_import',
    operation: 'create',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_eox_import_write'],
    type: 'record',
    table: 'x_daas_ham_eox_import',
    operation: 'write',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_oem_coverage_read'],
    type: 'record',
    table: 'x_daas_ham_oem_coverage',
    operation: 'read',
    roles: providerStaff,
})

Acl({
    $id: Now.ID['acl_oem_coverage_create'],
    type: 'record',
    table: 'x_daas_ham_oem_coverage',
    operation: 'create',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_oem_coverage_write'],
    type: 'record',
    table: 'x_daas_ham_oem_coverage',
    operation: 'write',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_oem_coverage_delete'],
    type: 'record',
    table: 'x_daas_ham_oem_coverage',
    operation: 'delete',
    roles: [admin],
})

Acl({
    $id: Now.ID['acl_oem_rma_read'],
    type: 'record',
    table: 'x_daas_ham_oem_rma',
    operation: 'read',
    roles: providerStaff,
})

Acl({
    $id: Now.ID['acl_oem_rma_create'],
    type: 'record',
    table: 'x_daas_ham_oem_rma',
    operation: 'create',
    roles: [assetManager, inventoryTech, noc],
})

Acl({
    $id: Now.ID['acl_oem_rma_write'],
    type: 'record',
    table: 'x_daas_ham_oem_rma',
    operation: 'write',
    roles: [assetManager, inventoryTech, noc],
})

Acl({
    $id: Now.ID['acl_oem_rma_delete'],
    type: 'record',
    table: 'x_daas_ham_oem_rma',
    operation: 'delete',
    roles: [admin],
})

Acl({
    $id: Now.ID['acl_coverage_import_read'],
    type: 'record',
    table: 'x_daas_ham_coverage_import',
    operation: 'read',
    roles: providerStaff,
})

Acl({
    $id: Now.ID['acl_coverage_import_create'],
    type: 'record',
    table: 'x_daas_ham_coverage_import',
    operation: 'create',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_coverage_import_write'],
    type: 'record',
    table: 'x_daas_ham_coverage_import',
    operation: 'write',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_coverage_import_delete'],
    type: 'record',
    table: 'x_daas_ham_coverage_import',
    operation: 'delete',
    roles: [admin],
})

Acl({
    $id: Now.ID['acl_disposal_order_read'],
    type: 'record',
    table: 'x_daas_ham_disposal_order',
    operation: 'read',
    roles: providerStaff,
})

Acl({
    $id: Now.ID['acl_disposal_order_create'],
    type: 'record',
    table: 'x_daas_ham_disposal_order',
    operation: 'create',
    roles: [assetManager, inventoryTech],
})

Acl({
    $id: Now.ID['acl_disposal_order_write'],
    type: 'record',
    table: 'x_daas_ham_disposal_order',
    operation: 'write',
    roles: [assetManager, inventoryTech],
})

Acl({
    $id: Now.ID['acl_disposal_order_delete'],
    type: 'record',
    table: 'x_daas_ham_disposal_order',
    operation: 'delete',
    roles: [admin],
})

Acl({
    $id: Now.ID['acl_disposal_line_read'],
    type: 'record',
    table: 'x_daas_ham_disposal_line',
    operation: 'read',
    roles: providerStaff,
})

Acl({
    $id: Now.ID['acl_disposal_line_create'],
    type: 'record',
    table: 'x_daas_ham_disposal_line',
    operation: 'create',
    roles: [assetManager, inventoryTech],
})

Acl({
    $id: Now.ID['acl_disposal_line_write'],
    type: 'record',
    table: 'x_daas_ham_disposal_line',
    operation: 'write',
    roles: [assetManager, inventoryTech],
})

Acl({
    $id: Now.ID['acl_disposal_line_delete'],
    type: 'record',
    table: 'x_daas_ham_disposal_line',
    operation: 'delete',
    roles: [admin],
})

Acl({
    $id: Now.ID['acl_audit_read'],
    type: 'record',
    table: 'x_daas_ham_audit',
    operation: 'read',
    roles: providerStaff,
})

Acl({
    $id: Now.ID['acl_audit_create'],
    type: 'record',
    table: 'x_daas_ham_audit',
    operation: 'create',
    roles: [assetManager, inventoryTech, fieldTech],
})

Acl({
    $id: Now.ID['acl_audit_write'],
    type: 'record',
    table: 'x_daas_ham_audit',
    operation: 'write',
    roles: [assetManager, inventoryTech, fieldTech],
})

Acl({
    $id: Now.ID['acl_audit_delete'],
    type: 'record',
    table: 'x_daas_ham_audit',
    operation: 'delete',
    roles: [admin],
})

Acl({
    $id: Now.ID['acl_audit_line_read'],
    type: 'record',
    table: 'x_daas_ham_audit_line',
    operation: 'read',
    roles: providerStaff,
})

Acl({
    $id: Now.ID['acl_audit_line_create'],
    type: 'record',
    table: 'x_daas_ham_audit_line',
    operation: 'create',
    roles: [assetManager, inventoryTech, fieldTech],
})

Acl({
    $id: Now.ID['acl_audit_line_write'],
    type: 'record',
    table: 'x_daas_ham_audit_line',
    operation: 'write',
    roles: [assetManager, inventoryTech, fieldTech],
})

Acl({
    $id: Now.ID['acl_audit_line_delete'],
    type: 'record',
    table: 'x_daas_ham_audit_line',
    operation: 'delete',
    roles: [admin],
})

Acl({
    $id: Now.ID['acl_recon_exception_read'],
    type: 'record',
    table: 'x_daas_ham_recon_exception',
    operation: 'read',
    roles: providerStaff,
})

Acl({
    $id: Now.ID['acl_recon_exception_create'],
    type: 'record',
    table: 'x_daas_ham_recon_exception',
    operation: 'create',
    roles: [assetManager, noc],
})

Acl({
    $id: Now.ID['acl_recon_exception_write'],
    type: 'record',
    table: 'x_daas_ham_recon_exception',
    operation: 'write',
    roles: [assetManager, noc],
})

Acl({
    $id: Now.ID['acl_recon_exception_delete'],
    type: 'record',
    table: 'x_daas_ham_recon_exception',
    operation: 'delete',
    roles: [admin],
})

Acl({
    $id: Now.ID['acl_return_order_read'],
    type: 'record',
    table: 'x_daas_ham_return_order',
    operation: 'read',
    roles: providerStaff,
})

Acl({
    $id: Now.ID['acl_return_order_read_customer'],
    type: 'record',
    table: 'x_daas_ham_return_order',
    operation: 'read',
    roles: customerRoles,
    script: "answer = current.getValue('customer') == gs.getUser().getCompanyID();",
})

Acl({
    $id: Now.ID['acl_attestation_read'],
    type: 'record',
    table: 'x_daas_ham_attestation',
    operation: 'read',
    roles: providerStaff,
})

Acl({
    $id: Now.ID['acl_attestation_read_customer'],
    type: 'record',
    table: 'x_daas_ham_attestation',
    operation: 'read',
    roles: customerRoles,
    script: "answer = current.getValue('customer') == gs.getUser().getCompanyID();",
})

Acl({
    $id: Now.ID['acl_fee_event_read'],
    type: 'record',
    table: 'x_daas_ham_fee_event',
    operation: 'read',
    roles: providerStaff,
})

Acl({
    $id: Now.ID['acl_fee_event_read_customer'],
    type: 'record',
    table: 'x_daas_ham_fee_event',
    operation: 'read',
    roles: customerRoles,
    script: "answer = current.getValue('customer') == gs.getUser().getCompanyID();",
})

Acl({
    $id: Now.ID['acl_return_order_create'],
    type: 'record',
    table: 'x_daas_ham_return_order',
    operation: 'create',
    roles: [assetManager, accountManager, noc, customerAdmin, 'sn_customerservice_agent'],
})

Acl({
    $id: Now.ID['acl_return_order_write'],
    type: 'record',
    table: 'x_daas_ham_return_order',
    operation: 'write',
    roles: [assetManager, accountManager, noc, inventoryTech, fieldTech],
})

Acl({
    $id: Now.ID['acl_return_order_delete'],
    type: 'record',
    table: 'x_daas_ham_return_order',
    operation: 'delete',
    roles: [admin],
})

Acl({
    $id: Now.ID['acl_return_order_line_read'],
    type: 'record',
    table: 'x_daas_ham_return_order_line',
    operation: 'read',
    roles: providerStaff,
})

Acl({
    $id: Now.ID['acl_return_order_line_read_customer'],
    type: 'record',
    table: 'x_daas_ham_return_order_line',
    operation: 'read',
    roles: customerRoles,
    script: "answer = current.return_order.customer.toString() == gs.getUser().getCompanyID();",
})

Acl({
    $id: Now.ID['acl_return_order_line_create'],
    type: 'record',
    table: 'x_daas_ham_return_order_line',
    operation: 'create',
    roles: [assetManager, inventoryTech, noc],
})

Acl({
    $id: Now.ID['acl_return_order_line_write'],
    type: 'record',
    table: 'x_daas_ham_return_order_line',
    operation: 'write',
    roles: [assetManager, inventoryTech],
})

Acl({
    $id: Now.ID['acl_return_order_line_delete'],
    type: 'record',
    table: 'x_daas_ham_return_order_line',
    operation: 'delete',
    roles: [admin],
})

Acl({
    $id: Now.ID['acl_attestation_create'],
    type: 'record',
    table: 'x_daas_ham_attestation',
    operation: 'create',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_attestation_write'],
    type: 'record',
    table: 'x_daas_ham_attestation',
    operation: 'write',
    roles: [assetManager, accountManager],
})

Acl({
    $id: Now.ID['acl_attestation_delete'],
    type: 'record',
    table: 'x_daas_ham_attestation',
    operation: 'delete',
    roles: [admin],
})

Acl({
    $id: Now.ID['acl_attestation_item_read'],
    type: 'record',
    table: 'x_daas_ham_attestation_item',
    operation: 'read',
    roles: providerStaff,
})

Acl({
    $id: Now.ID['acl_attestation_item_read_customer'],
    type: 'record',
    table: 'x_daas_ham_attestation_item',
    operation: 'read',
    roles: customerRoles,
    script: "answer = current.attestation.customer.toString() == gs.getUser().getCompanyID();",
})

Acl({
    $id: Now.ID['acl_attestation_item_create'],
    type: 'record',
    table: 'x_daas_ham_attestation_item',
    operation: 'create',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_attestation_item_write'],
    type: 'record',
    table: 'x_daas_ham_attestation_item',
    operation: 'write',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_attestation_item_delete'],
    type: 'record',
    table: 'x_daas_ham_attestation_item',
    operation: 'delete',
    roles: [admin],
})

Acl({
    $id: Now.ID['acl_fee_event_create'],
    type: 'record',
    table: 'x_daas_ham_fee_event',
    operation: 'create',
    roles: [finance, assetManager],
})

Acl({
    $id: Now.ID['acl_fee_event_write'],
    type: 'record',
    table: 'x_daas_ham_fee_event',
    operation: 'write',
    roles: [finance, assetManager],
})

Acl({
    $id: Now.ID['acl_fee_event_delete'],
    type: 'record',
    table: 'x_daas_ham_fee_event',
    operation: 'delete',
    roles: [admin],
})
