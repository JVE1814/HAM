import '@servicenow/sdk/global'
import { BusinessRule, ScheduledScript, UiAction } from '@servicenow/sdk/core'
import {
    guardDisposalLine,
    guardDisposalOrder,
    onDisposalApprovalDecision,
    uiCompleteDisposal,
    uiSubmitDisposal,
} from '../../server/entry/disposal'
import { raiseRefreshOrders } from '../../server/entry/refresh'
import { assetManager, inventoryTech } from '../security/roles.now'

/* Hardware refresh (D48) and disposal (D61). */

ScheduledScript({
    $id: Now.ID['job_raise_refresh_orders'],
    name: 'NaaS - raise refresh orders',
    active: true,
    frequency: 'daily',
    executionTime: { hours: 3, minutes: 50, seconds: 0 },
    timeZone: 'UTC',
    script: raiseRefreshOrders,
})

UiAction({
    $id: Now.ID['ua_disposal_submit'],
    name: 'Submit for approval',
    table: 'x_daas_ham_disposal_order',
    actionName: 'x_daas_ham_submit_disposal',
    condition: "current.stage == 'draft'",
    roles: [assetManager, inventoryTech],
    form: { showButton: true, style: 'primary' },
    showUpdate: true,
    script: uiSubmitDisposal,
})

UiAction({
    $id: Now.ID['ua_disposal_complete'],
    name: 'Complete disposal',
    table: 'x_daas_ham_disposal_order',
    actionName: 'x_daas_ham_complete_disposal',
    hint: 'Retire every wiped asset by its method; lines that are not ready are marked blocked with the reason.',
    condition: "current.stage == 'approved'",
    roles: [assetManager, inventoryTech],
    form: { showButton: true, style: 'primary' },
    showUpdate: true,
    script: uiCompleteDisposal,
})

BusinessRule({
    $id: Now.ID['br_disposal_approval_decision'],
    name: 'NaaS - roll up disposal approvals',
    table: 'sysapproval_approver',
    when: 'after',
    action: ['update'],
    order: 200,
    condition: "current.state.changes() && current.source_table == 'x_daas_ham_disposal_order'",
    script: onDisposalApprovalDecision,
})

BusinessRule({
    $id: Now.ID['br_disposal_line_frozen'],
    name: 'NaaS - submitted disposal lines are frozen',
    table: 'x_daas_ham_disposal_line',
    when: 'before',
    action: ['insert', 'update', 'delete'],
    order: 100,
    script: guardDisposalLine,
})

BusinessRule({
    $id: Now.ID['br_disposal_order_frozen'],
    name: 'NaaS - submitted disposal method and customer are frozen',
    table: 'x_daas_ham_disposal_order',
    when: 'before',
    action: ['update'],
    order: 100,
    condition: 'current.method.changes() || current.customer.changes()',
    script: guardDisposalOrder,
})
