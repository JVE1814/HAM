import '@servicenow/sdk/global'
import { Acl } from '@servicenow/sdk/core'
import { BROAD_STAFF, CUSTOMER_CONTACTS } from '../../server/domain/roles'
import { grantsCustomerRecord } from '../../server/entry/visibility'
import { admin, assetManager, customerAdmin, orderRaisers, orderWorkers, providerStaff, serviceDesk } from '../shared/roles.now'

Acl({
    $id: Now.ID['acl_order_read_service_desk'],
    type: 'record',
    table: 'x_daas_ham_order',
    operation: 'read',
    roles: serviceDesk,
})

Acl({
    $id: Now.ID['acl_order_line_read_service_desk'],
    type: 'record',
    table: 'x_daas_ham_order_line',
    operation: 'read',
    roles: serviceDesk,
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
    roles: CUSTOMER_CONTACTS,
    script: grantsCustomerRecord,
})

Acl({
    $id: Now.ID['acl_order_create'],
    type: 'record',
    table: 'x_daas_ham_order',
    operation: 'create',
    roles: orderRaisers,
})

/*
 * A customer admin creates an Order of their own Customer only. Every Order rule check of a customer admin is asked
 * of an Order that names its Customer, so one naming none is refused.
 */
Acl({
    $id: Now.ID['acl_order_create_customer'],
    type: 'record',
    table: 'x_daas_ham_order',
    operation: 'create',
    roles: [customerAdmin],
    description: 'NaaS customer admins create Orders of their own Customer only.',
    script: grantsCustomerRecord,
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
    roles: CUSTOMER_CONTACTS,
    script: grantsCustomerRecord,
})

// No customer role: a customer admin's lines are the record producer's, which its script adds.
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

// Asset Management's ACL lets the platform's asset and procurement_user roles read purchase orders, which the NOC,
// account managers and finance do not hold: an Order line's purchase orders would show blank to them.
Acl({
    $id: Now.ID['acl_proc_po_read_staff'],
    type: 'record',
    table: 'proc_po',
    operation: 'read',
    roles: BROAD_STAFF,
    description: 'NaaS provider staff read the purchase orders an Order line names.',
})
