import '@servicenow/sdk/global'
import { BusinessRule, Property, Record, ScheduledScript, ScriptAction, UiAction } from '@servicenow/sdk/core'
import { onOrderApprovalDecision, sourceOrder, uiCancelOrder, uiRecheckApprovals, uiSubmitOrder } from '../../server/entry/orders'
import { INSTALL_MODE, ORDER_STAGE, STAGE_FIELDS } from '../../server/domain/vocabulary'
import { APPROVAL_REQUESTED } from '../../server/domain/approvals'
import { uiConfirmInstalled, uiShipOrder } from '../../server/entry/delivery'
import { PLATFORM_ROLE } from '../../server/domain/visibility'
import { raiseRefreshOrders } from '../../server/entry/refresh'
import { EVENT } from '../../server/platform/events'
import { PROPERTY } from '../../server/platform/properties'
import {
    accountManager,
    admin,
    assetManager,
    commercialEditors,
    customerAdmin,
    fieldTech,
    orderRaisers,
    siteContact,
    stockroomWorkers,
} from '../shared/roles.now'

/* Orders: the approval roll-up, the form's buttons, hardware refresh and sourcing. */

BusinessRule({
    $id: Now.ID['br_order_approval_decision'],
    name: 'NaaS - roll up order approvals',
    table: 'sysapproval_approver',
    when: 'after',
    action: ['update'],
    order: 200,
    condition: "current.state.changes() && current.source_table == 'x_daas_ham_order'",
    script: onOrderApprovalDecision,
})

/* Form buttons on Orders. Stage transitions after "Submit" are derived from asset stages. */

UiAction({
    $id: Now.ID['ua_order_submit'],
    name: 'Submit',
    table: 'x_daas_ham_order',
    actionName: 'x_daas_ham_submit_order',
    condition: `current.stage == '${ORDER_STAGE.draft}'`,
    roles: orderRaisers,
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
        `current.stage == '${ORDER_STAGE.awaiting_approval}' && !(function (a) { a.addEncodedQuery('state=${APPROVAL_REQUESTED}^sysapproval=' + current.getUniqueValue()); a.setLimit(1); a.query(); return a.hasNext() })(new GlideRecord('sysapproval_approver'))`,
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
    condition: `current.stage == '${ORDER_STAGE.delivering}'`,
    roles: stockroomWorkers,
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
        `(current.install_mode=='${INSTALL_MODE.self_install}'||gs.hasRole('${PLATFORM_ROLE.asset}'))&&(current.stage=='${ORDER_STAGE.installing}'||(function(a){a.addQuery('substatus','${STAGE_FIELDS.shipped.substatus}');a.query('x_daas_ham_order_line.order',current.sys_id);return a.next()})(new GlideRecord('alm_hardware')))`,
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
    // domain/fulfilment CANCELLABLE_ORDER_STAGES, which built-metadata.test.ts holds the built condition to.
    condition: `['${ORDER_STAGE.draft}','${ORDER_STAGE.awaiting_approval}','${ORDER_STAGE.sourcing}','${ORDER_STAGE.preparing}','${ORDER_STAGE.delivering}'].indexOf(current.stage + '') >= 0`,
    roles: commercialEditors,
    form: { showButton: true, style: 'destructive' },
    showUpdate: true,
    script: uiCancelOrder,
})

/* Hardware refresh (Q48). */

ScheduledScript({
    $id: Now.ID['job_raise_refresh_orders'],
    name: 'NaaS - raise refresh orders',
    active: true,
    frequency: 'daily',
    executionTime: { hours: 3, minutes: 50, seconds: 0 },
    timeZone: 'UTC',
    script: raiseRefreshOrders,
})

Record({
    $id: Now.ID['event_order_source'],
    table: 'sysevent_register',
    data: {
        suffix: 'order.source',
        event_name: EVENT.sourceOrder,
        table: 'x_daas_ham_order',
        description: 'An approved Order needs its lines sourced.',
        priority: 100,
    },
})

ScriptAction({
    $id: Now.ID['sa_order_source'],
    name: 'NaaS - source order',
    eventName: EVENT.sourceOrder,
    active: true,
    script: sourceOrder,
    description: 'Allocates stock, requests transfers and purchases, and opens staging tasks for an approved Order.',
})

Property({
    $id: Now.ID['prop_refresh_horizon'],
    name: PROPERTY.refreshHorizonDays.name,
    type: 'integer',
    value: PROPERTY.refreshHorizonDays.default,
    description: 'Assets whose refresh is due within this many days get refresh orders.',
    roles: { read: [admin], write: [admin] },
})
