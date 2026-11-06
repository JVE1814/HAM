import '@servicenow/sdk/global'
import { UiAction } from '@servicenow/sdk/core'
import { uiCancelOrder, uiConfirmInstalled, uiShipOrder, uiSubmitOrder } from '../../server/entry/ui-actions'
import { accountManager, assetManager, customerAdmin, fieldTech, inventoryTech, noc, siteContact } from '../security/roles.now'

/* Form buttons on Orders. Stage transitions after "Submit" are derived from asset stages. */

UiAction({
    $id: Now.ID['ua_order_submit'],
    name: 'Submit',
    table: 'x_daas_ham_order',
    actionName: 'x_daas_ham_submit_order',
    condition: "current.stage == 'draft'",
    roles: [assetManager, accountManager, noc, 'sn_customerservice_agent'],
    form: { showButton: true, style: 'primary' },
    showUpdate: true,
    script: uiSubmitOrder,
})

UiAction({
    $id: Now.ID['ua_order_ship'],
    name: 'Ship',
    table: 'x_daas_ham_order',
    actionName: 'x_daas_ham_ship_order',
    hint: 'Ship all staged assets to the site and open the on-site work (change + work order).',
    condition: "current.stage == 'delivering'",
    roles: [inventoryTech, assetManager],
    form: { showButton: true, style: 'primary' },
    showUpdate: true,
    script: uiShipOrder,
})

UiAction({
    $id: Now.ID['ua_order_confirm_installed'],
    name: 'Confirm installed',
    table: 'x_daas_ham_order',
    actionName: 'x_daas_ham_confirm_installed',
    hint: 'Record that the shipped equipment is installed (self-install, or when the work order is closed elsewhere).',
    condition: "current.stage == 'installing'",
    roles: [assetManager, fieldTech, customerAdmin, siteContact],
    form: { showButton: true },
    showUpdate: true,
    script: uiConfirmInstalled,
})

UiAction({
    $id: Now.ID['ua_order_cancel'],
    name: 'Cancel order',
    table: 'x_daas_ham_order',
    actionName: 'x_daas_ham_cancel_order',
    condition: "['draft','awaiting_approval','sourcing','preparing','delivering'].indexOf(current.stage + '') >= 0",
    roles: [assetManager, accountManager],
    form: { showButton: true, style: 'destructive' },
    showUpdate: true,
    script: uiCancelOrder,
})
