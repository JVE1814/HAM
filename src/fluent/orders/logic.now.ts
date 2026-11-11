import '@servicenow/sdk/global'
import { BusinessRule, Property, Record, ScheduledScript, ScriptAction, UiAction } from '@servicenow/sdk/core'
import { onOrderApprovalDecision, sourceOrder, uiCancelOrder, uiRecheckApprovals, uiSubmitOrder } from '../../server/entry/orders'
import { ORDER_STAGE } from '../../server/domain/vocabulary'
import { APPROVAL } from '../../server/domain/approvals'
import { raiseRefreshOrders } from '../../server/platform/refresh'
import { EVENT } from '../../server/domain/events'
import { PROPERTY } from '../../server/domain/properties'
import { accountManager, admin, assetManager, commercialEditors, orderRaisers } from '../shared/roles.now'

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
        `current.stage == '${ORDER_STAGE.awaiting_approval}' && !(function (a) { a.addEncodedQuery('state=${APPROVAL.requested}^sysapproval=' + current.getUniqueValue()); a.setLimit(1); a.query(); return a.hasNext() })(new GlideRecord('sysapproval_approver'))`,
    roles: [assetManager, accountManager, admin],
    form: { showButton: true },
    showUpdate: true,
    script: uiRecheckApprovals,
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
