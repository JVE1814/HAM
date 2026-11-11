import '@servicenow/sdk/global'
import { Acl } from '@servicenow/sdk/core'
import { admin, finance, intervalEditors, moneyReaders } from '../shared/roles.now'

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
    roles: intervalEditors,
})

Acl({
    $id: Now.ID['acl_service_interval_create'],
    type: 'record',
    table: 'x_daas_ham_service_interval',
    operation: 'create',
    roles: intervalEditors,
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
