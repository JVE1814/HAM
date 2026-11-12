import '@servicenow/sdk/global'
import { Acl } from '@servicenow/sdk/core'
import { BROAD_STAFF } from '../../server/domain/roles'
import { grantsCustomerRecord } from '../../server/entry/visibility'
import { commercialEditors, customerAdmin, serviceDesk } from '../shared/roles.now'

Acl({
    $id: Now.ID['acl_agreement_read'],
    type: 'record',
    table: 'x_daas_ham_agreement',
    operation: 'read',
    roles: BROAD_STAFF,
})

Acl({
    $id: Now.ID['acl_agreement_write'],
    type: 'record',
    table: 'x_daas_ham_agreement',
    operation: 'write',
    roles: commercialEditors,
})

Acl({
    $id: Now.ID['acl_agreement_create'],
    type: 'record',
    table: 'x_daas_ham_agreement',
    operation: 'create',
    roles: commercialEditors,
})

Acl({
    $id: Now.ID['acl_agreement_delete'],
    type: 'record',
    table: 'x_daas_ham_agreement',
    operation: 'delete',
    roles: commercialEditors,
})

Acl({
    $id: Now.ID['acl_agreement_quantity_read'],
    type: 'record',
    table: 'x_daas_ham_agreement_quantity',
    operation: 'read',
    roles: BROAD_STAFF,
})

Acl({
    $id: Now.ID['acl_agreement_quantity_write'],
    type: 'record',
    table: 'x_daas_ham_agreement_quantity',
    operation: 'write',
    roles: commercialEditors,
})

Acl({
    $id: Now.ID['acl_agreement_quantity_create'],
    type: 'record',
    table: 'x_daas_ham_agreement_quantity',
    operation: 'create',
    roles: commercialEditors,
})

Acl({
    $id: Now.ID['acl_agreement_quantity_delete'],
    type: 'record',
    table: 'x_daas_ham_agreement_quantity',
    operation: 'delete',
    roles: commercialEditors,
})

Acl({
    $id: Now.ID['acl_subscription_line_read'],
    type: 'record',
    table: 'x_daas_ham_subscription_line',
    operation: 'read',
    roles: BROAD_STAFF,
})

Acl({
    $id: Now.ID['acl_subscription_line_write'],
    type: 'record',
    table: 'x_daas_ham_subscription_line',
    operation: 'write',
    roles: commercialEditors,
})

Acl({
    $id: Now.ID['acl_subscription_line_create'],
    type: 'record',
    table: 'x_daas_ham_subscription_line',
    operation: 'create',
    roles: commercialEditors,
})

Acl({
    $id: Now.ID['acl_subscription_line_delete'],
    type: 'record',
    table: 'x_daas_ham_subscription_line',
    operation: 'delete',
    roles: commercialEditors,
})

Acl({
    $id: Now.ID['acl_catalog_entry_read'],
    type: 'record',
    table: 'x_daas_ham_catalog_entry',
    operation: 'read',
    roles: BROAD_STAFF,
})

Acl({
    $id: Now.ID['acl_catalog_entry_write'],
    type: 'record',
    table: 'x_daas_ham_catalog_entry',
    operation: 'write',
    roles: commercialEditors,
})

Acl({
    $id: Now.ID['acl_catalog_entry_create'],
    type: 'record',
    table: 'x_daas_ham_catalog_entry',
    operation: 'create',
    roles: commercialEditors,
})

Acl({
    $id: Now.ID['acl_catalog_entry_delete'],
    type: 'record',
    table: 'x_daas_ham_catalog_entry',
    operation: 'delete',
    roles: commercialEditors,
})

Acl({
    $id: Now.ID['acl_site_template_read'],
    type: 'record',
    table: 'x_daas_ham_site_template',
    operation: 'read',
    roles: BROAD_STAFF,
})

Acl({
    $id: Now.ID['acl_site_template_write'],
    type: 'record',
    table: 'x_daas_ham_site_template',
    operation: 'write',
    roles: commercialEditors,
})

Acl({
    $id: Now.ID['acl_site_template_create'],
    type: 'record',
    table: 'x_daas_ham_site_template',
    operation: 'create',
    roles: commercialEditors,
})

Acl({
    $id: Now.ID['acl_site_template_delete'],
    type: 'record',
    table: 'x_daas_ham_site_template',
    operation: 'delete',
    roles: commercialEditors,
})

Acl({
    $id: Now.ID['acl_site_template_item_read'],
    type: 'record',
    table: 'x_daas_ham_site_template_item',
    operation: 'read',
    roles: BROAD_STAFF,
})

Acl({
    $id: Now.ID['acl_site_template_item_write'],
    type: 'record',
    table: 'x_daas_ham_site_template_item',
    operation: 'write',
    roles: commercialEditors,
})

Acl({
    $id: Now.ID['acl_site_template_item_create'],
    type: 'record',
    table: 'x_daas_ham_site_template_item',
    operation: 'create',
    roles: commercialEditors,
})

Acl({
    $id: Now.ID['acl_site_template_item_delete'],
    type: 'record',
    table: 'x_daas_ham_site_template_item',
    operation: 'delete',
    roles: commercialEditors,
})

Acl({
    $id: Now.ID['acl_agreement_read_customer'],
    type: 'record',
    table: 'x_daas_ham_agreement',
    operation: 'read',
    roles: [customerAdmin],
    script: grantsCustomerRecord,
})

Acl({
    $id: Now.ID['acl_subscription_line_read_customer'],
    type: 'record',
    table: 'x_daas_ham_subscription_line',
    operation: 'read',
    roles: [customerAdmin],
    script: grantsCustomerRecord,
})

Acl({
    $id: Now.ID['acl_catalog_entry_read_customer'],
    type: 'record',
    table: 'x_daas_ham_catalog_entry',
    operation: 'read',
    roles: [customerAdmin],
    script: grantsCustomerRecord,
})

Acl({
    $id: Now.ID['acl_site_template_read_customer'],
    type: 'record',
    table: 'x_daas_ham_site_template',
    operation: 'read',
    roles: [customerAdmin],
    // A Site template with no Customer is offered to every Customer (SCOPED_TABLES `sharedWithoutCustomer`).
    script: grantsCustomerRecord,
})

Acl({
    $id: Now.ID['acl_site_template_item_read_customer'],
    type: 'record',
    table: 'x_daas_ham_site_template_item',
    operation: 'read',
    roles: [customerAdmin],
    script: grantsCustomerRecord,
})

/*
 * The service desk (serviceDesk) raises Orders and Returns for any Customer (orderRaisers): it reads the Agreements and
 * Site templates the record producers offer, and the Orders, Order lines and Returns it raises, submits and follows.
 * It holds no NaaS role, so the before-query rules leave it every Customer's (ADR 0005). Nothing else of the app's is
 * its to read: not the commercial lines, catalog, fees or money tables.
 */
Acl({
    $id: Now.ID['acl_agreement_read_service_desk'],
    type: 'record',
    table: 'x_daas_ham_agreement',
    operation: 'read',
    roles: serviceDesk,
})

Acl({
    $id: Now.ID['acl_site_template_read_service_desk'],
    type: 'record',
    table: 'x_daas_ham_site_template',
    operation: 'read',
    roles: serviceDesk,
})

Acl({
    $id: Now.ID['acl_site_template_item_read_service_desk'],
    type: 'record',
    table: 'x_daas_ham_site_template_item',
    operation: 'read',
    roles: serviceDesk,
})
