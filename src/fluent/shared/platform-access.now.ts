import '@servicenow/sdk/global'
import { Acl } from '@servicenow/sdk/core'
import { BROAD_STAFF } from '../../server/domain/roles'
import { providerStaff } from './roles.now'

/*
 * Nearly every app table points at a Customer (customer_account) or a company (core_company), whose platform ACLs name
 * Customer Service and Asset Management roles that no NaaS role holds. A reference shows and is searched only when its
 * table and its display field are readable, so these grant provider staff the table and the Customer's name, and no
 * other field of the account (ADR 0005).
 */
Acl({
    $id: Now.ID['acl_customer_account_read_staff'],
    type: 'record',
    table: 'customer_account',
    operation: 'read',
    roles: providerStaff,
    description: "NaaS provider staff read the Customers the app's records name.",
})

Acl({
    $id: Now.ID['acl_customer_account_name_read_staff'],
    type: 'record',
    table: 'customer_account',
    field: 'name',
    operation: 'read',
    roles: providerStaff,
    description: "NaaS provider staff read a Customer's name, which a reference to it shows.",
})

Acl({
    $id: Now.ID['acl_core_company_read_staff'],
    type: 'record',
    table: 'core_company',
    operation: 'read',
    roles: BROAD_STAFF,
    description: "NaaS provider staff read the companies the app's records name: Customers, manufacturers, vendors.",
})
