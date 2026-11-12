import '@servicenow/sdk/global'
import { Acl } from '@servicenow/sdk/core'
import { BROAD_STAFF, CUSTOMER_CONTACTS, EQUIPMENT_HANDLERS } from '../../server/domain/roles'
import { grantsCustomerRecord } from '../../server/entry/visibility'
import { admin, assetManager, attestationEditors, noc, providerStaff } from '../shared/roles.now'

Acl({
    $id: Now.ID['acl_audit_read'],
    type: 'record',
    table: 'x_daas_ham_audit',
    operation: 'read',
    roles: providerStaff,
})

Acl({
    $id: Now.ID['acl_audit_create'],
    type: 'record',
    table: 'x_daas_ham_audit',
    operation: 'create',
    roles: EQUIPMENT_HANDLERS,
})

Acl({
    $id: Now.ID['acl_audit_write'],
    type: 'record',
    table: 'x_daas_ham_audit',
    operation: 'write',
    roles: EQUIPMENT_HANDLERS,
})

Acl({
    $id: Now.ID['acl_audit_delete'],
    type: 'record',
    table: 'x_daas_ham_audit',
    operation: 'delete',
    roles: [admin],
})

Acl({
    $id: Now.ID['acl_audit_line_read'],
    type: 'record',
    table: 'x_daas_ham_audit_line',
    operation: 'read',
    roles: providerStaff,
})

Acl({
    $id: Now.ID['acl_audit_line_create'],
    type: 'record',
    table: 'x_daas_ham_audit_line',
    operation: 'create',
    roles: EQUIPMENT_HANDLERS,
})

Acl({
    $id: Now.ID['acl_audit_line_write'],
    type: 'record',
    table: 'x_daas_ham_audit_line',
    operation: 'write',
    roles: EQUIPMENT_HANDLERS,
})

Acl({
    $id: Now.ID['acl_audit_line_delete'],
    type: 'record',
    table: 'x_daas_ham_audit_line',
    operation: 'delete',
    roles: [admin],
})

Acl({
    $id: Now.ID['acl_recon_exception_read'],
    type: 'record',
    table: 'x_daas_ham_recon_exception',
    operation: 'read',
    roles: BROAD_STAFF,
})

Acl({
    $id: Now.ID['acl_recon_exception_create'],
    type: 'record',
    table: 'x_daas_ham_recon_exception',
    operation: 'create',
    roles: [assetManager, noc],
})

Acl({
    $id: Now.ID['acl_recon_exception_write'],
    type: 'record',
    table: 'x_daas_ham_recon_exception',
    operation: 'write',
    roles: [assetManager, noc],
})

Acl({
    $id: Now.ID['acl_recon_exception_delete'],
    type: 'record',
    table: 'x_daas_ham_recon_exception',
    operation: 'delete',
    roles: [admin],
})

Acl({
    $id: Now.ID['acl_attestation_read'],
    type: 'record',
    table: 'x_daas_ham_attestation',
    operation: 'read',
    roles: BROAD_STAFF,
})

Acl({
    $id: Now.ID['acl_attestation_read_customer'],
    type: 'record',
    table: 'x_daas_ham_attestation',
    operation: 'read',
    roles: CUSTOMER_CONTACTS,
    script: grantsCustomerRecord,
})

Acl({
    $id: Now.ID['acl_attestation_create'],
    type: 'record',
    table: 'x_daas_ham_attestation',
    operation: 'create',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_attestation_write'],
    type: 'record',
    table: 'x_daas_ham_attestation',
    operation: 'write',
    roles: attestationEditors,
})

Acl({
    $id: Now.ID['acl_attestation_delete'],
    type: 'record',
    table: 'x_daas_ham_attestation',
    operation: 'delete',
    roles: [admin],
})

Acl({
    $id: Now.ID['acl_attestation_item_read'],
    type: 'record',
    table: 'x_daas_ham_attestation_item',
    operation: 'read',
    roles: BROAD_STAFF,
})

Acl({
    $id: Now.ID['acl_attestation_item_read_customer'],
    type: 'record',
    table: 'x_daas_ham_attestation_item',
    operation: 'read',
    roles: CUSTOMER_CONTACTS,
    script: grantsCustomerRecord,
})

Acl({
    $id: Now.ID['acl_attestation_item_create'],
    type: 'record',
    table: 'x_daas_ham_attestation_item',
    operation: 'create',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_attestation_item_write'],
    type: 'record',
    table: 'x_daas_ham_attestation_item',
    operation: 'write',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_attestation_item_delete'],
    type: 'record',
    table: 'x_daas_ham_attestation_item',
    operation: 'delete',
    roles: [admin],
})
