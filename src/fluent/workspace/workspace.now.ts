import '@servicenow/sdk/global'
import { Acl, UiPage } from '@servicenow/sdk/core'
import workspacePage from '../../client/workspace.html'
import { providerStaff } from '../shared/roles.now'

/*
 * The provider-staff workspace: the lists and the dashboard of src/client/workspace, which read every table through
 * the platform's Table and Stats APIs, so the tables' ACLs decide what each user sees there.
 */

/** The page's name: its address is this with .do, and its ACL is named by it. */
export const WORKSPACE_PAGE = 'x_daas_ham_workspace'

UiPage({
    $id: Now.ID['page_workspace'],
    endpoint: `${WORKSPACE_PAGE}.do`,
    description: 'NaaS Asset Workspace: lists of orders, fulfilment, installed base, stock, models and commercial data, and the overview dashboard.',
    category: 'general',
    html: workspacePage,
    direct: true,
})

Acl({
    $id: Now.ID['acl_page_workspace'],
    type: 'ui_page',
    name: WORKSPACE_PAGE,
    operation: 'read',
    roles: providerStaff,
})
