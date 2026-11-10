import '@servicenow/sdk/global'
import { Acl } from '@servicenow/sdk/core'
import { admin, broadStaff, leaseEditors } from '../shared/roles.now'

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
