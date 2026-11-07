import '@servicenow/sdk/global'
import { BusinessRule } from '@servicenow/sdk/core'
import { enforceLifecycle, onAllocatedAssetStageChange, onAssetServiceChange } from '../../server/entry/assets'
import { guardWorkWindow, onWorkOrderClosed } from '../../server/entry/delivery'
import { onOrderApprovalDecision } from '../../server/entry/orders'
import { guardStagingClosure, onStagingClosed, releaseWaitingSteps, stampStagingStep } from '../../server/entry/staging'

/* Record-change rules driving the Order lifecycle (ADR 0004). */

BusinessRule({
    $id: Now.ID['br_asset_enforce_lifecycle'],
    name: 'NaaS - enforce asset lifecycle',
    table: 'alm_hardware',
    when: 'before',
    action: ['update'],
    order: 100,
    condition: 'current.install_status.changes() || current.substatus.changes()',
    script: enforceLifecycle,
})

BusinessRule({
    $id: Now.ID['br_asset_stage_to_order_line'],
    name: 'NaaS - advance order line on asset stage change',
    table: 'alm_hardware',
    when: 'after',
    action: ['update'],
    order: 200,
    condition: "(current.install_status.changes() || current.substatus.changes()) && current.x_daas_ham_order_line != ''",
    script: onAllocatedAssetStageChange,
})

BusinessRule({
    $id: Now.ID['br_asset_left_service'],
    name: 'NaaS - start or stop billing on service changes',
    table: 'alm_hardware',
    when: 'after',
    action: ['update'],
    order: 210,
    // Also when the same save clears the line, so a stop still closes the open interval.
    condition: "(current.install_status.changes() || current.substatus.changes()) && (current.x_daas_ham_subscription_line != '' || previous.x_daas_ham_subscription_line != '')",
    script: onAssetServiceChange,
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

BusinessRule({
    $id: Now.ID['br_staging_step_stamp'],
    name: 'NaaS - stamp staging step',
    table: 'x_daas_ham_staging_step',
    when: 'before',
    action: ['update'],
    order: 100,
    condition: 'current.done.changes()',
    script: stampStagingStep,
})

BusinessRule({
    $id: Now.ID['br_staging_step_release'],
    name: 'NaaS - release OEM steps waiting on a done step',
    table: 'x_daas_ham_staging_step',
    when: 'after',
    action: ['update'],
    order: 200,
    condition: "current.done.changes() && current.done == true && current.automation != ''",
    script: releaseWaitingSteps,
})

BusinessRule({
    $id: Now.ID['br_staging_guard_closure'],
    name: 'NaaS - require staging steps before closing',
    table: 'x_daas_ham_staging_task',
    when: 'before',
    action: ['update'],
    order: 100,
    condition: 'current.state.changes() && current.state == 3',
    script: guardStagingClosure,
})

BusinessRule({
    $id: Now.ID['br_staging_closed'],
    name: 'NaaS - staged asset on staging closure',
    table: 'x_daas_ham_staging_task',
    when: 'after',
    action: ['update'],
    order: 200,
    condition: 'current.state.changes() && current.state == 3',
    script: onStagingClosed,
})

BusinessRule({
    $id: Now.ID['br_work_order_window'],
    name: 'NaaS - work inside change and maintenance window',
    table: 'wm_order',
    when: 'before',
    action: ['insert', 'update'],
    order: 100,
    condition: "current.x_daas_ham_order != '' && (current.expected_start.changes() || current.estimated_end.changes())",
    script: guardWorkWindow,
})

BusinessRule({
    $id: Now.ID['br_work_order_closed'],
    name: 'NaaS - complete install on work order closure',
    table: 'wm_order',
    when: 'after',
    action: ['update'],
    order: 200,
    condition: "current.x_daas_ham_order != '' && current.state.changes() && current.state == 3",
    script: onWorkOrderClosed,
})
