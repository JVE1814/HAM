import '@servicenow/sdk/global'
import { Acl, UiPage } from '@servicenow/sdk/core'
import warehousePage from '../../client/warehouse.html'
import { scanners } from '../security/roles.now'

/* The warehouse scanning app (receive, put away, pick, look up, print labels). */

/** The page's name: its address is this with .do, and its ACL is named by it. */
export const WAREHOUSE_PAGE = 'x_daas_ham_warehouse'

export const warehouse = UiPage({
    $id: Now.ID['page_warehouse'],
    endpoint: `${WAREHOUSE_PAGE}.do`,
    description: 'NaaS warehouse scanning: receive, put away, pick, look up and print provider tags.',
    category: 'general',
    html: warehousePage,
    direct: true,
})

Acl({
    $id: Now.ID['acl_page_warehouse'],
    type: 'ui_page',
    name: WAREHOUSE_PAGE,
    operation: 'read',
    roles: scanners,
})
