import '@servicenow/sdk/global'
import { Acl } from '@servicenow/sdk/core'
import { accountManager, admin, assetManager, broadStaff, finance } from './roles.now'

/* Access controls for the contracts and money tables (P3): leases, billing, costs and margin. */

const leaseEditors = [assetManager, finance]
const moneyReaders = [finance, accountManager, assetManager]

Acl({
    $id: Now.ID['acl_lease_schedule_read'],
    type: 'record',
    table: 'x_daas_ham_lease_schedule',
    operation: 'read',
    roles: broadStaff,
})

Acl({
    $id: Now.ID['acl_lease_schedule_write'],
    type: 'record',
    table: 'x_daas_ham_lease_schedule',
    operation: 'write',
    roles: leaseEditors,
})

Acl({
    $id: Now.ID['acl_lease_schedule_create'],
    type: 'record',
    table: 'x_daas_ham_lease_schedule',
    operation: 'create',
    roles: leaseEditors,
})

Acl({
    $id: Now.ID['acl_lease_schedule_delete'],
    type: 'record',
    table: 'x_daas_ham_lease_schedule',
    operation: 'delete',
    roles: leaseEditors,
})

Acl({
    $id: Now.ID['acl_lease_decision_read'],
    type: 'record',
    table: 'x_daas_ham_lease_decision',
    operation: 'read',
    roles: broadStaff,
})

Acl({
    $id: Now.ID['acl_lease_decision_write'],
    type: 'record',
    table: 'x_daas_ham_lease_decision',
    operation: 'write',
    roles: leaseEditors,
})

Acl({
    $id: Now.ID['acl_lease_decision_create'],
    type: 'record',
    table: 'x_daas_ham_lease_decision',
    operation: 'create',
    roles: leaseEditors,
})

Acl({
    $id: Now.ID['acl_lease_decision_delete'],
    type: 'record',
    table: 'x_daas_ham_lease_decision',
    operation: 'delete',
    roles: [admin],
})

Acl({
    $id: Now.ID['acl_service_interval_read'],
    type: 'record',
    table: 'x_daas_ham_service_interval',
    operation: 'read',
    roles: moneyReaders,
})

Acl({
    $id: Now.ID['acl_service_interval_write'],
    type: 'record',
    table: 'x_daas_ham_service_interval',
    operation: 'write',
    roles: [assetManager, finance],
})

Acl({
    $id: Now.ID['acl_service_interval_create'],
    type: 'record',
    table: 'x_daas_ham_service_interval',
    operation: 'create',
    roles: [assetManager, finance],
})

Acl({
    $id: Now.ID['acl_service_interval_delete'],
    type: 'record',
    table: 'x_daas_ham_service_interval',
    operation: 'delete',
    roles: [admin],
})

Acl({
    $id: Now.ID['acl_billing_period_read'],
    type: 'record',
    table: 'x_daas_ham_billing_period',
    operation: 'read',
    roles: moneyReaders,
})

Acl({
    $id: Now.ID['acl_billing_period_write'],
    type: 'record',
    table: 'x_daas_ham_billing_period',
    operation: 'write',
    roles: [finance],
})

Acl({
    $id: Now.ID['acl_billing_period_create'],
    type: 'record',
    table: 'x_daas_ham_billing_period',
    operation: 'create',
    roles: [finance],
})

Acl({
    $id: Now.ID['acl_billing_period_delete'],
    type: 'record',
    table: 'x_daas_ham_billing_period',
    operation: 'delete',
    roles: [finance],
})

Acl({
    $id: Now.ID['acl_billing_line_read'],
    type: 'record',
    table: 'x_daas_ham_billing_line',
    operation: 'read',
    roles: moneyReaders,
})

Acl({
    $id: Now.ID['acl_billing_line_write'],
    type: 'record',
    table: 'x_daas_ham_billing_line',
    operation: 'write',
    roles: [finance],
})

Acl({
    $id: Now.ID['acl_billing_line_create'],
    type: 'record',
    table: 'x_daas_ham_billing_line',
    operation: 'create',
    roles: [admin],
})

Acl({
    $id: Now.ID['acl_billing_line_delete'],
    type: 'record',
    table: 'x_daas_ham_billing_line',
    operation: 'delete',
    roles: [admin],
})

Acl({
    $id: Now.ID['acl_cost_fact_read'],
    type: 'record',
    table: 'x_daas_ham_cost_fact',
    operation: 'read',
    roles: moneyReaders,
})

Acl({
    $id: Now.ID['acl_cost_fact_write'],
    type: 'record',
    table: 'x_daas_ham_cost_fact',
    operation: 'write',
    roles: [finance],
})

Acl({
    $id: Now.ID['acl_cost_fact_create'],
    type: 'record',
    table: 'x_daas_ham_cost_fact',
    operation: 'create',
    roles: [finance],
})

Acl({
    $id: Now.ID['acl_cost_fact_delete'],
    type: 'record',
    table: 'x_daas_ham_cost_fact',
    operation: 'delete',
    roles: [finance],
})

Acl({
    $id: Now.ID['acl_margin_read'],
    type: 'record',
    table: 'x_daas_ham_margin',
    operation: 'read',
    roles: moneyReaders,
})

Acl({
    $id: Now.ID['acl_margin_write'],
    type: 'record',
    table: 'x_daas_ham_margin',
    operation: 'write',
    roles: [admin],
})

Acl({
    $id: Now.ID['acl_margin_create'],
    type: 'record',
    table: 'x_daas_ham_margin',
    operation: 'create',
    roles: [admin],
})

Acl({
    $id: Now.ID['acl_margin_delete'],
    type: 'record',
    table: 'x_daas_ham_margin',
    operation: 'delete',
    roles: [admin],
})
