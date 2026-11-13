import '@servicenow/sdk/global'
import { Acl } from '@servicenow/sdk/core'
import { BROAD_STAFF } from '../../server/domain/roles'
import { admin, leaseEditors } from '../shared/roles.now'

Acl({
    $id: Now.ID['acl_lease_schedule_read'],
    type: 'record',
    table: 'x_daas_ham_lease_schedule',
    operation: 'read',
    roles: BROAD_STAFF,
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
    roles: BROAD_STAFF,
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

/*
 * A Lease schedule extends ast_contract, whose field ACLs let only contract_manager read or search its fields (see
 * agreements/access.now.ts): these let its readers read and search them, the vendor and its contract number too.
 */
Acl({
    $id: Now.ID['acl_lease_schedule_fields_read'],
    type: 'record',
    table: 'x_daas_ham_lease_schedule',
    field: '*',
    operation: 'read',
    roles: BROAD_STAFF,
})

Acl({
    $id: Now.ID['acl_lease_schedule_number_read'],
    type: 'record',
    table: 'x_daas_ham_lease_schedule',
    field: 'number',
    operation: 'read',
    roles: BROAD_STAFF,
})

Acl({
    $id: Now.ID['acl_lease_schedule_short_description_read'],
    type: 'record',
    table: 'x_daas_ham_lease_schedule',
    field: 'short_description',
    operation: 'read',
    roles: BROAD_STAFF,
})

Acl({
    $id: Now.ID['acl_lease_schedule_state_read'],
    type: 'record',
    table: 'x_daas_ham_lease_schedule',
    field: 'state',
    operation: 'read',
    roles: BROAD_STAFF,
})

Acl({
    $id: Now.ID['acl_lease_schedule_starts_read'],
    type: 'record',
    table: 'x_daas_ham_lease_schedule',
    field: 'starts',
    operation: 'read',
    roles: BROAD_STAFF,
})

Acl({
    $id: Now.ID['acl_lease_schedule_ends_read'],
    type: 'record',
    table: 'x_daas_ham_lease_schedule',
    field: 'ends',
    operation: 'read',
    roles: BROAD_STAFF,
})

Acl({
    $id: Now.ID['acl_lease_schedule_vendor_read'],
    type: 'record',
    table: 'x_daas_ham_lease_schedule',
    field: 'vendor',
    operation: 'read',
    roles: BROAD_STAFF,
})

Acl({
    $id: Now.ID['acl_lease_schedule_vendor_contract_read'],
    type: 'record',
    table: 'x_daas_ham_lease_schedule',
    field: 'vendor_contract',
    operation: 'read',
    roles: BROAD_STAFF,
})

Acl({
    $id: Now.ID['acl_lease_schedule_fields_query_range'],
    type: 'record',
    table: 'x_daas_ham_lease_schedule',
    field: '*',
    operation: 'query_range',
    roles: BROAD_STAFF,
})

Acl({
    $id: Now.ID['acl_lease_schedule_starts_query_range'],
    type: 'record',
    table: 'x_daas_ham_lease_schedule',
    field: 'starts',
    operation: 'query_range',
    roles: BROAD_STAFF,
})

Acl({
    $id: Now.ID['acl_lease_schedule_vendor_query_range'],
    type: 'record',
    table: 'x_daas_ham_lease_schedule',
    field: 'vendor',
    operation: 'query_range',
    roles: BROAD_STAFF,
})

Acl({
    $id: Now.ID['acl_lease_schedule_vendor_contract_query_range'],
    type: 'record',
    table: 'x_daas_ham_lease_schedule',
    field: 'vendor_contract',
    operation: 'query_range',
    roles: BROAD_STAFF,
})
