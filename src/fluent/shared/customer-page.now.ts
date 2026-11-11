import '@servicenow/sdk/global'
import { Acl, Record, UiPage } from '@servicenow/sdk/core'
import customerPage from '../../client/customer.html'
import { ROLE } from '../../server/domain/visibility'
import { assetManager, customerAdmin, siteContact } from './roles.now'
import { naasMenu } from './menu.now'

/* Customer self-service (P2.9): link it from the CSM portal menu as /x_daas_ham_customer.do. */

/** The page's name: its address is this with .do, and its ACL is named by it. */
export const CUSTOMER_PAGE = 'x_daas_ham_customer'

export const customerSelfService = UiPage({
    $id: Now.ID['page_customer'],
    endpoint: `${CUSTOMER_PAGE}.do`,
    description: 'Customer self-service: equipment by site, faults, returns and decommissions, orders, attestations.',
    category: 'general',
    html: customerPage,
    direct: true,
})

Acl({
    $id: Now.ID['acl_page_customer'],
    type: 'ui_page',
    name: CUSTOMER_PAGE,
    operation: 'read',
    roles: [customerAdmin, siteContact, assetManager],
})

Record({
    $id: Now.ID['module_customer_page'],
    table: 'sys_app_module',
    data: {
        title: 'Customer self-service (preview)',
        application: naasMenu,
        link_type: 'DIRECT',
        query: `${CUSTOMER_PAGE}.do`,
        roles: [ROLE.assetManager],
        active: true,
        order: 140,
    },
})
