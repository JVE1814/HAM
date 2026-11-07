import '@servicenow/sdk/global'
import { Acl, Workspace } from '@servicenow/sdk/core'
import { accountManager, assetManager, fieldTech, finance, inventoryTech, noc } from '../security/roles.now'
import { naasListMenu } from './list-menu.now'

/* The provider-staff workspace: /now/naas-assets/home */

export const naasWorkspace = Workspace({
    $id: Now.ID['ws_naas_assets'],
    title: 'NaaS Asset Workspace',
    path: 'naas-assets',
    landingPath: 'home',
    tables: [
        'x_daas_ham_order',
        'x_daas_ham_order_line',
        'x_daas_ham_staging_task',
        'alm_hardware',
        'x_daas_ham_agreement',
        'x_daas_ham_subscription_line',
        'x_daas_ham_model_lifecycle',
        'x_daas_ham_norm_exception',
    ],
    listConfig: naasListMenu,
})

Acl({
    $id: Now.ID['acl_ws_naas_assets'],
    localOrExisting: 'Existing',
    type: 'ux_route',
    operation: 'read',
    roles: [assetManager, inventoryTech, fieldTech, noc, accountManager, finance],
    name: 'now.naas-assets.*',
})
