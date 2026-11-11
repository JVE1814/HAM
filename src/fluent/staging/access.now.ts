import '@servicenow/sdk/global'
import { Acl } from '@servicenow/sdk/core'
import { admin, assetManager, providerStaff, stockroomWorkers } from '../shared/roles.now'

Acl({
    $id: Now.ID['acl_staging_task_read'],
    type: 'record',
    table: 'x_daas_ham_staging_task',
    operation: 'read',
    roles: providerStaff,
})

Acl({
    $id: Now.ID['acl_staging_task_create'],
    type: 'record',
    table: 'x_daas_ham_staging_task',
    operation: 'create',
    roles: stockroomWorkers,
})

Acl({
    $id: Now.ID['acl_staging_task_write'],
    type: 'record',
    table: 'x_daas_ham_staging_task',
    operation: 'write',
    roles: stockroomWorkers,
})

Acl({
    $id: Now.ID['acl_staging_task_delete'],
    type: 'record',
    table: 'x_daas_ham_staging_task',
    operation: 'delete',
    roles: [admin],
})

Acl({
    $id: Now.ID['acl_staging_step_read'],
    type: 'record',
    table: 'x_daas_ham_staging_step',
    operation: 'read',
    roles: providerStaff,
})

Acl({
    $id: Now.ID['acl_staging_step_create'],
    type: 'record',
    table: 'x_daas_ham_staging_step',
    operation: 'create',
    roles: stockroomWorkers,
})

Acl({
    $id: Now.ID['acl_staging_step_write'],
    type: 'record',
    table: 'x_daas_ham_staging_step',
    operation: 'write',
    roles: stockroomWorkers,
})

Acl({
    $id: Now.ID['acl_staging_step_delete'],
    type: 'record',
    table: 'x_daas_ham_staging_step',
    operation: 'delete',
    roles: [admin],
})

Acl({
    $id: Now.ID['acl_staging_template_read'],
    type: 'record',
    table: 'x_daas_ham_staging_template',
    operation: 'read',
    roles: providerStaff,
})

Acl({
    $id: Now.ID['acl_staging_template_write'],
    type: 'record',
    table: 'x_daas_ham_staging_template',
    operation: 'write',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_staging_template_create'],
    type: 'record',
    table: 'x_daas_ham_staging_template',
    operation: 'create',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_staging_template_delete'],
    type: 'record',
    table: 'x_daas_ham_staging_template',
    operation: 'delete',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_staging_tmpl_item_read'],
    type: 'record',
    table: 'x_daas_ham_staging_tmpl_item',
    operation: 'read',
    roles: providerStaff,
})

Acl({
    $id: Now.ID['acl_staging_tmpl_item_write'],
    type: 'record',
    table: 'x_daas_ham_staging_tmpl_item',
    operation: 'write',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_staging_tmpl_item_create'],
    type: 'record',
    table: 'x_daas_ham_staging_tmpl_item',
    operation: 'create',
    roles: [assetManager],
})

Acl({
    $id: Now.ID['acl_staging_tmpl_item_delete'],
    type: 'record',
    table: 'x_daas_ham_staging_tmpl_item',
    operation: 'delete',
    roles: [assetManager],
})
