import '@servicenow/sdk/global'
import { Acl, Workspace } from '@servicenow/sdk/core'
import { accountManager, assetManager, fieldTech, finance, inventoryTech, noc } from '../security/roles.now'
import { naasListMenu } from './list-menu.now'

/*
 * The provider-staff workspace: /x/daas/naas-assets/home. The platform serves a custom scoped app's
 * workspace under x/<vendor prefix>/<path> (x_daas_ham: x/daas), not under now/<path> as the SDK's
 * workspace guide says: /now/naas-assets/... is "Page not found". Its route ACLs are named the same
 * way (x.daas.naas-assets.<route>); a now.naas-assets.* ACL matches no route and would leave the
 * workspace to the platform's catch-all ux_route ACL, which lets in every canvas_user.
 */

/** The vendor prefix of the scope (x_daas_ham). */
const VENDOR = 'daas'
const PATH = 'naas-assets'
const LANDING_PATH = 'home'

/** The workspace's landing page, as a navigator module links to it. */
export const WORKSPACE_HOME = `x/${VENDOR}/${PATH}/${LANDING_PATH}`

export const naasWorkspace = Workspace({
    $id: Now.ID['ws_naas_assets'],
    title: 'NaaS Asset Workspace',
    path: PATH,
    landingPath: LANDING_PATH,
    tables: [
        'x_daas_ham_order',
        'x_daas_ham_order_line',
        'x_daas_ham_staging_task',
        'alm_hardware',
        'x_daas_ham_agreement',
        'x_daas_ham_subscription_line',
        'cmdb_hardware_model_lifecycle',
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
    name: `x.${VENDOR}.${PATH}.*`,
})
