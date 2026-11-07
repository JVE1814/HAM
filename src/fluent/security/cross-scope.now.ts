import '@servicenow/sdk/global'
import { CrossScopePrivilege } from '@servicenow/sdk/core'

/* Runtime access this app needs to tables owned by other scopes (ADR 0001). */

CrossScopePrivilege({
    $id: Now.ID['xsp_alm_hardware_read'],
    operation: 'read',
    status: 'allowed',
    targetName: 'alm_hardware',
    targetScope: 'global',
    targetType: 'sys_db_object',
})

CrossScopePrivilege({
    $id: Now.ID['xsp_alm_hardware_write'],
    operation: 'write',
    status: 'allowed',
    targetName: 'alm_hardware',
    targetScope: 'global',
    targetType: 'sys_db_object',
})

CrossScopePrivilege({
    $id: Now.ID['xsp_alm_hardware_create'],
    operation: 'create',
    status: 'allowed',
    targetName: 'alm_hardware',
    targetScope: 'global',
    targetType: 'sys_db_object',
})

CrossScopePrivilege({
    $id: Now.ID['xsp_alm_asset_read'],
    operation: 'read',
    status: 'allowed',
    targetName: 'alm_asset',
    targetScope: 'global',
    targetType: 'sys_db_object',
})

CrossScopePrivilege({
    $id: Now.ID['xsp_alm_asset_write'],
    operation: 'write',
    status: 'allowed',
    targetName: 'alm_asset',
    targetScope: 'global',
    targetType: 'sys_db_object',
})

CrossScopePrivilege({
    $id: Now.ID['xsp_alm_consumable_read'],
    operation: 'read',
    status: 'allowed',
    targetName: 'alm_consumable',
    targetScope: 'global',
    targetType: 'sys_db_object',
})

CrossScopePrivilege({
    $id: Now.ID['xsp_alm_consumable_write'],
    operation: 'write',
    status: 'allowed',
    targetName: 'alm_consumable',
    targetScope: 'global',
    targetType: 'sys_db_object',
})

CrossScopePrivilege({
    $id: Now.ID['xsp_alm_consumable_create'],
    operation: 'create',
    status: 'allowed',
    targetName: 'alm_consumable',
    targetScope: 'global',
    targetType: 'sys_db_object',
})

CrossScopePrivilege({
    $id: Now.ID['xsp_alm_stockroom_read'],
    operation: 'read',
    status: 'allowed',
    targetName: 'alm_stockroom',
    targetScope: 'global',
    targetType: 'sys_db_object',
})

CrossScopePrivilege({
    $id: Now.ID['xsp_alm_transfer_order_read'],
    operation: 'read',
    status: 'allowed',
    targetName: 'alm_transfer_order',
    targetScope: 'global',
    targetType: 'sys_db_object',
})

CrossScopePrivilege({
    $id: Now.ID['xsp_alm_transfer_order_write'],
    operation: 'write',
    status: 'allowed',
    targetName: 'alm_transfer_order',
    targetScope: 'global',
    targetType: 'sys_db_object',
})

CrossScopePrivilege({
    $id: Now.ID['xsp_alm_transfer_order_create'],
    operation: 'create',
    status: 'allowed',
    targetName: 'alm_transfer_order',
    targetScope: 'global',
    targetType: 'sys_db_object',
})

CrossScopePrivilege({
    $id: Now.ID['xsp_alm_transfer_order_line_read'],
    operation: 'read',
    status: 'allowed',
    targetName: 'alm_transfer_order_line',
    targetScope: 'global',
    targetType: 'sys_db_object',
})

CrossScopePrivilege({
    $id: Now.ID['xsp_alm_transfer_order_line_write'],
    operation: 'write',
    status: 'allowed',
    targetName: 'alm_transfer_order_line',
    targetScope: 'global',
    targetType: 'sys_db_object',
})

CrossScopePrivilege({
    $id: Now.ID['xsp_alm_transfer_order_line_create'],
    operation: 'create',
    status: 'allowed',
    targetName: 'alm_transfer_order_line',
    targetScope: 'global',
    targetType: 'sys_db_object',
})

CrossScopePrivilege({
    $id: Now.ID['xsp_cmdb_model_read'],
    operation: 'read',
    status: 'allowed',
    targetName: 'cmdb_model',
    targetScope: 'global',
    targetType: 'sys_db_object',
})

CrossScopePrivilege({
    $id: Now.ID['xsp_cmdb_model_write'],
    operation: 'write',
    status: 'allowed',
    targetName: 'cmdb_model',
    targetScope: 'global',
    targetType: 'sys_db_object',
})

CrossScopePrivilege({
    $id: Now.ID['xsp_cmdb_hardware_product_model_read'],
    operation: 'read',
    status: 'allowed',
    targetName: 'cmdb_hardware_product_model',
    targetScope: 'global',
    targetType: 'sys_db_object',
})

CrossScopePrivilege({
    $id: Now.ID['xsp_cmdb_ci_read'],
    operation: 'read',
    status: 'allowed',
    targetName: 'cmdb_ci',
    targetScope: 'global',
    targetType: 'sys_db_object',
})

CrossScopePrivilege({
    $id: Now.ID['xsp_cmdb_ci_rack_read'],
    operation: 'read',
    status: 'allowed',
    targetName: 'cmdb_ci_rack',
    targetScope: 'global',
    targetType: 'sys_db_object',
})

CrossScopePrivilege({
    $id: Now.ID['xsp_cmn_location_read'],
    operation: 'read',
    status: 'allowed',
    targetName: 'cmn_location',
    targetScope: 'global',
    targetType: 'sys_db_object',
})

CrossScopePrivilege({
    $id: Now.ID['xsp_cmn_schedule_read'],
    operation: 'read',
    status: 'allowed',
    targetName: 'cmn_schedule',
    targetScope: 'global',
    targetType: 'sys_db_object',
})

CrossScopePrivilege({
    $id: Now.ID['xsp_core_company_read'],
    operation: 'read',
    status: 'allowed',
    targetName: 'core_company',
    targetScope: 'global',
    targetType: 'sys_db_object',
})

CrossScopePrivilege({
    $id: Now.ID['xsp_customer_account_read'],
    operation: 'read',
    status: 'allowed',
    targetName: 'customer_account',
    targetScope: 'global',
    targetType: 'sys_db_object',
})

CrossScopePrivilege({
    $id: Now.ID['xsp_customer_contact_read'],
    operation: 'read',
    status: 'allowed',
    targetName: 'customer_contact',
    targetScope: 'global',
    targetType: 'sys_db_object',
})

CrossScopePrivilege({
    $id: Now.ID['xsp_sys_user_read'],
    operation: 'read',
    status: 'allowed',
    targetName: 'sys_user',
    targetScope: 'global',
    targetType: 'sys_db_object',
})

CrossScopePrivilege({
    $id: Now.ID['xsp_sysapproval_approver_read'],
    operation: 'read',
    status: 'allowed',
    targetName: 'sysapproval_approver',
    targetScope: 'global',
    targetType: 'sys_db_object',
})

CrossScopePrivilege({
    $id: Now.ID['xsp_sysapproval_approver_write'],
    operation: 'write',
    status: 'allowed',
    targetName: 'sysapproval_approver',
    targetScope: 'global',
    targetType: 'sys_db_object',
})

CrossScopePrivilege({
    $id: Now.ID['xsp_sysapproval_approver_create'],
    operation: 'create',
    status: 'allowed',
    targetName: 'sysapproval_approver',
    targetScope: 'global',
    targetType: 'sys_db_object',
})

CrossScopePrivilege({
    $id: Now.ID['xsp_change_request_read'],
    operation: 'read',
    status: 'allowed',
    targetName: 'change_request',
    targetScope: 'global',
    targetType: 'sys_db_object',
})

CrossScopePrivilege({
    $id: Now.ID['xsp_change_request_write'],
    operation: 'write',
    status: 'allowed',
    targetName: 'change_request',
    targetScope: 'global',
    targetType: 'sys_db_object',
})

CrossScopePrivilege({
    $id: Now.ID['xsp_change_request_create'],
    operation: 'create',
    status: 'allowed',
    targetName: 'change_request',
    targetScope: 'global',
    targetType: 'sys_db_object',
})

CrossScopePrivilege({
    $id: Now.ID['xsp_std_change_record_producer_read'],
    operation: 'read',
    status: 'allowed',
    targetName: 'std_change_record_producer',
    targetScope: 'global',
    targetType: 'sys_db_object',
})

CrossScopePrivilege({
    $id: Now.ID['xsp_wm_order_read'],
    operation: 'read',
    status: 'allowed',
    targetName: 'wm_order',
    targetScope: 'global',
    targetType: 'sys_db_object',
})

CrossScopePrivilege({
    $id: Now.ID['xsp_wm_order_write'],
    operation: 'write',
    status: 'allowed',
    targetName: 'wm_order',
    targetScope: 'global',
    targetType: 'sys_db_object',
})

CrossScopePrivilege({
    $id: Now.ID['xsp_wm_order_create'],
    operation: 'create',
    status: 'allowed',
    targetName: 'wm_order',
    targetScope: 'global',
    targetType: 'sys_db_object',
})

CrossScopePrivilege({
    $id: Now.ID['xsp_proc_po_read'],
    operation: 'read',
    status: 'allowed',
    targetName: 'proc_po',
    targetScope: 'global',
    targetType: 'sys_db_object',
})

CrossScopePrivilege({
    $id: Now.ID['xsp_proc_po_write'],
    operation: 'write',
    status: 'allowed',
    targetName: 'proc_po',
    targetScope: 'global',
    targetType: 'sys_db_object',
})

CrossScopePrivilege({
    $id: Now.ID['xsp_proc_po_create'],
    operation: 'create',
    status: 'allowed',
    targetName: 'proc_po',
    targetScope: 'global',
    targetType: 'sys_db_object',
})

CrossScopePrivilege({
    $id: Now.ID['xsp_proc_po_item_read'],
    operation: 'read',
    status: 'allowed',
    targetName: 'proc_po_item',
    targetScope: 'global',
    targetType: 'sys_db_object',
})

CrossScopePrivilege({
    $id: Now.ID['xsp_proc_po_item_write'],
    operation: 'write',
    status: 'allowed',
    targetName: 'proc_po_item',
    targetScope: 'global',
    targetType: 'sys_db_object',
})

CrossScopePrivilege({
    $id: Now.ID['xsp_proc_po_item_create'],
    operation: 'create',
    status: 'allowed',
    targetName: 'proc_po_item',
    targetScope: 'global',
    targetType: 'sys_db_object',
})

CrossScopePrivilege({
    $id: Now.ID['xsp_sn_customerservice_case_read'],
    operation: 'read',
    status: 'allowed',
    targetName: 'sn_customerservice_case',
    targetScope: 'sn_customerservice',
    targetType: 'sys_db_object',
})

CrossScopePrivilege({
    $id: Now.ID['xsp_sn_customerservice_case_write'],
    operation: 'write',
    status: 'allowed',
    targetName: 'sn_customerservice_case',
    targetScope: 'sn_customerservice',
    targetType: 'sys_db_object',
})

CrossScopePrivilege({
    $id: Now.ID['xsp_sn_customerservice_case_create'],
    operation: 'create',
    status: 'allowed',
    targetName: 'sn_customerservice_case',
    targetScope: 'sn_customerservice',
    targetType: 'sys_db_object',
})

CrossScopePrivilege({
    $id: Now.ID['xsp_cmdb_ci_netgear_read'],
    operation: 'read',
    status: 'allowed',
    targetName: 'cmdb_ci_netgear',
    targetScope: 'global',
    targetType: 'sys_db_object',
})

CrossScopePrivilege({
    $id: Now.ID['xsp_sys_user_has_role_read'],
    operation: 'read',
    status: 'allowed',
    targetName: 'sys_user_has_role',
    targetScope: 'global',
    targetType: 'sys_db_object',
})

CrossScopePrivilege({
    $id: Now.ID['xsp_sys_user_role_read'],
    operation: 'read',
    status: 'allowed',
    targetName: 'sys_user_role',
    targetScope: 'global',
    targetType: 'sys_db_object',
})

CrossScopePrivilege({
    $id: Now.ID['xsp_sys_attachment_read'],
    operation: 'read',
    status: 'allowed',
    targetName: 'sys_attachment',
    targetScope: 'global',
    targetType: 'sys_db_object',
})

CrossScopePrivilege({
    $id: Now.ID['xsp_sys_attachment_delete'],
    operation: 'delete',
    status: 'allowed',
    targetName: 'sys_attachment',
    targetScope: 'global',
    targetType: 'sys_db_object',
})
