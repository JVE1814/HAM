import '@servicenow/sdk/global'
import { Acl } from '@servicenow/sdk/core'
import { grantsCustomerRecord } from '../../server/entry/visibility'
import { admin, customerRoles, providerStaff, stockroomWorkers } from '../shared/roles.now'

/*
 * Access controls for shipping (P3.26). Customer admins see their own Customer's shipments, site contacts those of
 * their Sites (entry/visibility `grantsCustomerRecord`, the check of every customer ACL).
 */

Acl({
    $id: Now.ID['acl_shipment_read'],
    type: 'record',
    table: 'x_daas_ham_shipment',
    operation: 'read',
    roles: providerStaff,
})

Acl({
    $id: Now.ID['acl_shipment_write'],
    type: 'record',
    table: 'x_daas_ham_shipment',
    operation: 'write',
    roles: stockroomWorkers,
})

Acl({
    $id: Now.ID['acl_shipment_create'],
    type: 'record',
    table: 'x_daas_ham_shipment',
    operation: 'create',
    roles: stockroomWorkers,
})

Acl({
    $id: Now.ID['acl_shipment_delete'],
    type: 'record',
    table: 'x_daas_ham_shipment',
    operation: 'delete',
    roles: [admin],
})

Acl({
    $id: Now.ID['acl_shipment_read_customer'],
    type: 'record',
    table: 'x_daas_ham_shipment',
    operation: 'read',
    roles: customerRoles,
    script: grantsCustomerRecord,
})

/*
 * The Provider's carrier cost of a label is not the Customer's to read: the customer read ACL above grants the whole
 * Shipment, and a field with no ACL of its own is read with its record. Provider staff, who read every Shipment, keep it.
 */
Acl({
    $id: Now.ID['acl_shipment_cost_read'],
    type: 'record',
    table: 'x_daas_ham_shipment',
    field: 'cost',
    operation: 'read',
    roles: providerStaff,
    description: "NaaS: a Shipment's carrier cost is the Provider's, read by provider staff only (not Customer contacts).",
})

Acl({
    $id: Now.ID['acl_shipment_event_read'],
    type: 'record',
    table: 'x_daas_ham_shipment_event',
    operation: 'read',
    roles: providerStaff,
})

Acl({
    $id: Now.ID['acl_shipment_event_write'],
    type: 'record',
    table: 'x_daas_ham_shipment_event',
    operation: 'write',
    roles: [admin],
})

Acl({
    $id: Now.ID['acl_shipment_event_create'],
    type: 'record',
    table: 'x_daas_ham_shipment_event',
    operation: 'create',
    roles: [admin],
})

Acl({
    $id: Now.ID['acl_shipment_event_delete'],
    type: 'record',
    table: 'x_daas_ham_shipment_event',
    operation: 'delete',
    roles: [admin],
})

Acl({
    $id: Now.ID['acl_shipment_event_read_customer'],
    type: 'record',
    table: 'x_daas_ham_shipment_event',
    operation: 'read',
    roles: customerRoles,
    script: grantsCustomerRecord,
})
