import '@servicenow/sdk/global'
import { Acl } from '@servicenow/sdk/core'
import { admin, assetManager, customerRoles, inventoryTech, providerStaff } from './roles.now'

/* Access controls for shipping (P3.26). Customer contacts see their own shipments (labels for returns). */

const shippers = [assetManager, inventoryTech]

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
    roles: shippers,
})

Acl({
    $id: Now.ID['acl_shipment_create'],
    type: 'record',
    table: 'x_daas_ham_shipment',
    operation: 'create',
    roles: shippers,
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
    script: "answer = current.getValue('customer') == gs.getUser().getCompanyID();",
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
    script: "answer = current.shipment.customer + '' == gs.getUser().getCompanyID();",
})
