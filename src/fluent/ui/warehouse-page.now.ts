import '@servicenow/sdk/global'
import { Acl, UiPage } from '@servicenow/sdk/core'
import warehousePage from '../../client/warehouse.html'
import { assetManager, fieldTech, inventoryTech } from '../security/roles.now'

/* The warehouse scanning app (receive, put away, pick, look up, print labels). */

export const warehouse = UiPage({
    $id: Now.ID['page_warehouse'],
    endpoint: 'x_daas_ham_warehouse.do',
    description: 'NaaS warehouse scanning: receive, put away, pick, look up and print provider tags.',
    category: 'general',
    html: warehousePage,
    direct: true,
})

Acl({
    $id: Now.ID['acl_page_warehouse'],
    type: 'ui_page',
    name: 'x_daas_ham_warehouse',
    operation: 'read',
    roles: [inventoryTech, fieldTech, assetManager],
})
