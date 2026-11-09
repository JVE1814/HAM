import '@servicenow/sdk/global'
import { BusinessRule } from '@servicenow/sdk/core'
import {
    clearVoidedWipeEvidence,
    explainLifecycleRefusal,
    onAllocatedAssetStageChange,
    onAssetServiceChange,
    onTransferReleased,
} from '../../server/entry/assets'
import { explainWorkWindowRefusal, onWorkOrderClosed } from '../../server/entry/delivery'
import { onOrderApprovalDecision } from '../../server/entry/orders'
import { guardStagingClosure, onStagingClosed, releaseWaitingSteps, stampStagingStep } from '../../server/entry/staging'

/* Record-change rules driving the Order lifecycle (ADR 0004). */

/*
 * alm_hardware and wm_order are global tables: the platform refuses current.setAbortAction from this scope on their
 * records and saves anyway. So a before rule there refuses with its Abort action when its condition (the module's
 * check) holds, and its script only says why. The platform runs a condition on every save of the table, whether or not
 * the rule's filter matches, so each condition starts with its change test: the module loads only when that holds. The
 * condition field holds at most 254 characters.
 *
 * alm_hardware also holds the Provider IT's own equipment, which the app leaves alone (ADR 0016): each rule on it
 * tests the Fleet flag right after its change test, before anything else it checks or loads.
 */

// Ahead of the lifecycle rule, so that it checks the stage the Asset takes back, not Inventory's In stock / Available.
BusinessRule({
    $id: Now.ID['br_asset_transfer_released'],
    name: 'NaaS - asset stage back after transfer',
    table: 'alm_hardware',
    when: 'before',
    action: ['update'],
    order: 80,
    condition: 'current.active_to.changes() && current.x_daas_ham_fleet == true',
    script: onTransferReleased,
})

BusinessRule({
    $id: Now.ID['br_asset_enforce_lifecycle'],
    name: 'NaaS - enforce asset lifecycle',
    table: 'alm_hardware',
    when: 'before',
    action: ['update'],
    order: 100,
    condition:
        "(current.install_status.changes() || current.substatus.changes()) && current.x_daas_ham_fleet == true && require('x_daas_ham/naas-ham/0.1.0/src/server/entry/assets.ts').refusesLifecycleChange(current, previous)",
    abortAction: true,
    script: explainLifecycleRefusal,
})

// Not part of the rule above, which runs its script only on a save it refuses: every save into staging, whoever makes
// it, clears the wipe evidence.
BusinessRule({
    $id: Now.ID['br_asset_staging_voids_wipe'],
    name: 'NaaS - staging voids wipe evidence',
    table: 'alm_hardware',
    when: 'before',
    action: ['update'],
    order: 100,
    condition: '(current.install_status.changes() || current.substatus.changes()) && current.x_daas_ham_fleet == true',
    script: clearVoidedWipeEvidence,
})

// Also takes a unit that left its line in transit off it.
BusinessRule({
    $id: Now.ID['br_asset_stage_to_order_line'],
    name: 'NaaS - asset stage advances order line',
    table: 'alm_hardware',
    when: 'after',
    action: ['update'],
    order: 200,
    condition:
        "(current.install_status.changes() || current.substatus.changes()) && current.x_daas_ham_fleet == true && current.x_daas_ham_order_line != ''",
    script: onAllocatedAssetStageChange,
})

BusinessRule({
    $id: Now.ID['br_asset_left_service'],
    name: 'NaaS - start or stop billing on service',
    table: 'alm_hardware',
    when: 'after',
    action: ['update'],
    order: 210,
    condition: '(current.install_status.changes() || current.substatus.changes()) && current.x_daas_ham_fleet == true',
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
    name: 'NaaS - release waiting OEM steps',
    table: 'x_daas_ham_staging_step',
    when: 'after',
    action: ['update'],
    order: 200,
    condition: "current.done.changes() && current.done == true && current.automation != ''",
    script: releaseWaitingSteps,
})

BusinessRule({
    $id: Now.ID['br_staging_guard_closure'],
    name: 'NaaS - staging steps done before close',
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
    name: 'NaaS - work inside the change window',
    table: 'wm_order',
    when: 'before',
    action: ['insert', 'update'],
    order: 100,
    condition:
        "current.x_daas_ham_order != '' && (current.expected_start.changes() || current.estimated_end.changes()) && require('x_daas_ham/naas-ham/0.1.0/src/server/entry/delivery.ts').refusesWorkWindow(current)",
    abortAction: true,
    script: explainWorkWindowRefusal,
})

BusinessRule({
    $id: Now.ID['br_work_order_closed'],
    name: 'NaaS - install done on work order close',
    table: 'wm_order',
    when: 'after',
    action: ['update'],
    order: 200,
    condition: "current.x_daas_ham_order != '' && current.state.changes() && current.state == 3",
    script: onWorkOrderClosed,
})
