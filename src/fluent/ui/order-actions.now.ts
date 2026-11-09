import '@servicenow/sdk/global'
import { UiAction } from '@servicenow/sdk/core'
import {
    uiCancelOrder,
    uiConfirmInstalled,
    uiRecheckApprovals,
    uiShipOrder,
    uiSubmitOrder,
} from '../../server/entry/ui-actions'
import {
    accountManager,
    admin,
    assetManager,
    customerAdmin,
    fieldTech,
    inventoryTech,
    noc,
    siteContact,
} from '../security/roles.now'

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
    $id: Now.ID['ua_order_recheck_approvals'],
    name: 'Re-check approvals',
    table: 'x_daas_ham_order',
    actionName: 'x_daas_ham_recheck_approvals',
    hint: 'Roll the approvals up again, for an Order whose last decision could not be saved.',
    // Only while no request is waiting: a waiting request's decision rolls the approvals up itself. The condition
    // column holds at most 254 characters (a longer one is cut off on the instance), hence the terse query.
    condition:
        "current.stage == 'awaiting_approval' && !(function (a) { a.addEncodedQuery('state=requested^sysapproval=' + current.getUniqueValue()); a.setLimit(1); a.query(); return a.hasNext() })(new GlideRecord('sysapproval_approver'))",
    roles: [assetManager, accountManager, admin],
    form: { showButton: true },
    showUpdate: true,
    script: uiRecheckApprovals,
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
    // Customer contacts confirm only a self-install, staff any install: one installing, or one a line filled again
    // holds back while units already shipped wait at the Site (uiConfirmInstalled checks domain/install-confirmation
    // on the server). The condition column holds at most 254 characters, hence the terse script: staff are told apart
    // by the platform's asset role, which asset managers and field techs contain and Customer roles do not, and the
    // stage of an Order held back goes unchecked, as only one preparing, delivering or installing has units shipped.
    condition:
        "(current.install_mode=='self_install'||gs.hasRole('asset'))&&(current.stage=='installing'||(function(a){a.addQuery('substatus','shipped_to_site');a.query('x_daas_ham_order_line.order',current.sys_id);return a.next()})(new GlideRecord('alm_hardware')))",
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
