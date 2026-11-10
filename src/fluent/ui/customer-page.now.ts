import '@servicenow/sdk/global'
import { Acl, UiPage } from '@servicenow/sdk/core'
import customerPage from '../../client/customer.html'
import { assetManager, customerAdmin, siteContact } from '../security/roles.now'

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
