import '@servicenow/sdk/global'
import { BusinessRule, Property, Record, ScheduledScript, ScriptAction, UiAction } from '@servicenow/sdk/core'
import { guardContactOrder, onAllocatedAssetStageChange, onOrderApprovalDecision, sourceOrder, uiCancelOrder, uiRecheckApprovals, uiSubmitOrder } from '../../server/entry/orders'
import { takeBackStageAfterTransfer } from '../../server/platform/transfers'
import { CURRENT_FLEET_STAGE_CHANGED, CURRENT_IS_FLEET } from '../../server/domain/fleet'
import { ORDER_STAGE } from '../../server/domain/vocabulary'
import { APPROVAL } from '../../server/domain/approvals'
import { raiseRefreshOrders } from '../../server/platform/refresh'
import { runSparePoolTopUp } from '../../server/platform/spare-pools'
import { EVENT } from '../../server/domain/events'
import { PROPERTY } from '../../server/domain/properties'
import { accountManager, admin, assetManager, commercialEditors, orderRaisers } from '../shared/roles.now'

/*
 * An Order saved in a Customer contact's session passes what Submit checks (their own Customer, with an Agreement and a
 * Site of that Customer), whatever inserts it (platform/orders `contactOrderInsertRefusal`). The customer admins'
 * create ACL looks at the Customer only (orders/access.now.ts). A contact's insert by hand (a form, the Table API)
 * keeps no posted value, as they are an external user, and fails that ACL; the rule guards the record producer and any
 * other insert that keeps the values. The table is the app's own, so the script refuses with current.setAbortAction
 * (platform/rule-api `abortWith`).
 */
BusinessRule({
    $id: Now.ID['br_order_contact_insert'],
    name: "NaaS - check a contact's Order",
    table: 'x_daas_ham_order',
    when: 'before',
    action: ['insert'],
    order: 100,
    script: guardContactOrder,
})

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

/* Stage transitions after "Submit" are derived from asset stages. */

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

/*
 * Rules on alm_hardware are written as
 * fluent/fleet/logic.now.ts says: the change test, then the Fleet flag.
 */

// Ahead of the lifecycle rule, so that it checks the stage the Asset takes back, not Inventory's In stock / Available.
BusinessRule({
    $id: Now.ID['br_asset_transfer_released'],
    name: 'NaaS - asset stage back after transfer',
    table: 'alm_hardware',
    when: 'before',
    action: ['update'],
    order: 80,
    condition: `current.active_to.changes() && ${CURRENT_IS_FLEET}`,
    script: takeBackStageAfterTransfer,
})

BusinessRule({
    $id: Now.ID['br_asset_stage_to_order_line'],
    name: 'NaaS - asset stage advances order line',
    table: 'alm_hardware',
    when: 'after',
    action: ['update'],
    order: 200,
    condition: `${CURRENT_FLEET_STAGE_CHANGED} && current.x_daas_ham_order_line != ''`,
    script: onAllocatedAssetStageChange,
})

ScheduledScript({
    $id: Now.ID['job_spare_pool_top_up'],
    name: 'NaaS - spare pool top-up',
    active: true,
    frequency: 'daily',
    executionTime: { hours: 2, minutes: 40, seconds: 0 },
    timeZone: 'UTC',
    script: runSparePoolTopUp,
})

Property({
    $id: Now.ID['prop_spare_auto_purchase'],
    name: PROPERTY.autoPurchaseSpares.name,
    type: 'boolean',
    value: PROPERTY.autoPurchaseSpares.default,
    description: 'When true, the spare-pool top-up job requests purchase orders for shortfalls central stock cannot cover.',
    roles: { read: [admin], write: [admin] },
})
