import '@servicenow/sdk/global'
import { Acl } from '@servicenow/sdk/core'
import { BROAD_STAFF } from '../../server/domain/roles'
import { assetManager } from '../shared/roles.now'

Acl({
    $id: Now.ID['acl_manufacturer_alias_read'],
    type: 'record',
    table: 'x_daas_ham_manufacturer_alias',
    operation: 'read',
    roles: BROAD_STAFF,
})

Acl({
    $id: Now.ID['acl_manufacturer_alias_write'],
    type: 'record',
    table: 'x_daas_ham_manufacturer_alias',
    operation: 'write',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_manufacturer_alias_create'],
    type: 'record',
    table: 'x_daas_ham_manufacturer_alias',
    operation: 'create',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_manufacturer_alias_delete'],
    type: 'record',
    table: 'x_daas_ham_manufacturer_alias',
    operation: 'delete',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_model_match_rule_read'],
    type: 'record',
    table: 'x_daas_ham_model_match_rule',
    operation: 'read',
    roles: BROAD_STAFF,
})

Acl({
    $id: Now.ID['acl_model_match_rule_write'],
    type: 'record',
    table: 'x_daas_ham_model_match_rule',
    operation: 'write',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_model_match_rule_create'],
    type: 'record',
    table: 'x_daas_ham_model_match_rule',
    operation: 'create',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_model_match_rule_delete'],
    type: 'record',
    table: 'x_daas_ham_model_match_rule',
    operation: 'delete',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_norm_exception_read'],
    type: 'record',
    table: 'x_daas_ham_norm_exception',
    operation: 'read',
    roles: BROAD_STAFF,
})

Acl({
    $id: Now.ID['acl_norm_exception_write'],
    type: 'record',
    table: 'x_daas_ham_norm_exception',
    operation: 'write',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_norm_exception_create'],
    type: 'record',
    table: 'x_daas_ham_norm_exception',
    operation: 'create',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_norm_exception_delete'],
    type: 'record',
    table: 'x_daas_ham_norm_exception',
    operation: 'delete',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_eox_import_read'],
    type: 'record',
    table: 'x_daas_ham_eox_import',
    operation: 'read',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_eox_import_create'],
    type: 'record',
    table: 'x_daas_ham_eox_import',
    operation: 'create',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_eox_import_write'],
    type: 'record',
    table: 'x_daas_ham_eox_import',
    operation: 'write',
    roles: [assetManager],
})
