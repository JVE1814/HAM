import '@servicenow/sdk/global'
import { Acl } from '@servicenow/sdk/core'
import { BROAD_STAFF } from '../../server/domain/roles'
import { admin, assetManager } from '../shared/roles.now'

Acl({
    $id: Now.ID['acl_oem_coverage_read'],
    type: 'record',
    table: 'x_daas_ham_oem_coverage',
    operation: 'read',
    roles: BROAD_STAFF,
})

Acl({
    $id: Now.ID['acl_oem_coverage_create'],
    type: 'record',
    table: 'x_daas_ham_oem_coverage',
    operation: 'create',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_oem_coverage_write'],
    type: 'record',
    table: 'x_daas_ham_oem_coverage',
    operation: 'write',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_oem_coverage_delete'],
    type: 'record',
    table: 'x_daas_ham_oem_coverage',
    operation: 'delete',
    roles: [admin],
})

Acl({
    $id: Now.ID['acl_coverage_import_read'],
    type: 'record',
    table: 'x_daas_ham_coverage_import',
    operation: 'read',
    roles: BROAD_STAFF,
})

Acl({
    $id: Now.ID['acl_coverage_import_create'],
    type: 'record',
    table: 'x_daas_ham_coverage_import',
    operation: 'create',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_coverage_import_write'],
    type: 'record',
    table: 'x_daas_ham_coverage_import',
    operation: 'write',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_coverage_import_delete'],
    type: 'record',
    table: 'x_daas_ham_coverage_import',
    operation: 'delete',
    roles: [admin],
})

Acl({
    $id: Now.ID['acl_cloud_account_read'],
    type: 'record',
    table: 'x_daas_ham_cloud_account',
    operation: 'read',
    roles: BROAD_STAFF,
})

Acl({
    $id: Now.ID['acl_cloud_account_write'],
    type: 'record',
    table: 'x_daas_ham_cloud_account',
    operation: 'write',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_cloud_account_create'],
    type: 'record',
    table: 'x_daas_ham_cloud_account',
    operation: 'create',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_cloud_account_delete'],
    type: 'record',
    table: 'x_daas_ham_cloud_account',
    operation: 'delete',
    roles: [assetManager],
})
