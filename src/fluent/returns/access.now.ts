import '@servicenow/sdk/global'
import { Acl } from '@servicenow/sdk/core'
import { createsCustomerReturn, grantsCustomerRecord } from '../../server/entry/visibility'
import {
    admin,
    broadStaff,
    customerAdmin,
    customerRoles,
    feeEditors,
    orderRaisers,
    providerStaff,
    returnEditors,
    returnWorkers,
    serviceDesk,
    stockroomWorkers,
} from '../shared/roles.now'

Acl({
    $id: Now.ID['acl_return_order_read_service_desk'],
    type: 'record',
    table: 'x_daas_ham_return_order',
    operation: 'read',
    roles: serviceDesk,
})

Acl({
    $id: Now.ID['acl_return_order_line_read_service_desk'],
    type: 'record',
    table: 'x_daas_ham_return_order_line',
    operation: 'read',
    roles: serviceDesk,
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
    script: grantsCustomerRecord,
})

Acl({
    $id: Now.ID['acl_fee_event_read'],
    type: 'record',
    table: 'x_daas_ham_fee_event',
    operation: 'read',
    roles: broadStaff,
})

Acl({
    $id: Now.ID['acl_fee_event_read_customer'],
    type: 'record',
    table: 'x_daas_ham_fee_event',
    operation: 'read',
    // Fee events carry no Site, so site contacts get none (ADR 0005).
    roles: [customerAdmin],
    script: grantsCustomerRecord,
})

Acl({
    $id: Now.ID['acl_return_order_create'],
    type: 'record',
    table: 'x_daas_ham_return_order',
    operation: 'create',
    roles: orderRaisers,
})

/*
 * A customer admin creates a Return of their own Customer only. One that names no Customer yet passes: the customer
 * page asks whether a Return may be raised at all (platform/returns, canCreate() of an empty record) before it names
 * the Customer, and a Return with none is no Customer's, which no customer contact reads.
 */
Acl({
    $id: Now.ID['acl_return_order_create_customer'],
    type: 'record',
    table: 'x_daas_ham_return_order',
    operation: 'create',
    roles: [customerAdmin],
    description: 'NaaS customer admins create Returns of their own Customer only.',
    script: createsCustomerReturn,
})

Acl({
    $id: Now.ID['acl_return_order_write'],
    type: 'record',
    table: 'x_daas_ham_return_order',
    operation: 'write',
    roles: returnEditors,
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
    script: grantsCustomerRecord,
})

Acl({
    $id: Now.ID['acl_return_order_line_create'],
    type: 'record',
    table: 'x_daas_ham_return_order_line',
    operation: 'create',
    roles: returnWorkers,
})

Acl({
    $id: Now.ID['acl_return_order_line_write'],
    type: 'record',
    table: 'x_daas_ham_return_order_line',
    operation: 'write',
    roles: stockroomWorkers,
})

Acl({
    $id: Now.ID['acl_return_order_line_delete'],
    type: 'record',
    table: 'x_daas_ham_return_order_line',
    operation: 'delete',
    roles: [admin],
})

Acl({
    $id: Now.ID['acl_fee_event_create'],
    type: 'record',
    table: 'x_daas_ham_fee_event',
    operation: 'create',
    roles: feeEditors,
})

Acl({
    $id: Now.ID['acl_fee_event_write'],
    type: 'record',
    table: 'x_daas_ham_fee_event',
    operation: 'write',
    roles: feeEditors,
})

Acl({
    $id: Now.ID['acl_fee_event_delete'],
    type: 'record',
    table: 'x_daas_ham_fee_event',
    operation: 'delete',
    roles: [admin],
})
