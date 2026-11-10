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
import { CURRENT_IS_FLEET } from '../../server/domain/fleet'
import { ENTRY_MODULES } from './server-modules.now'
import { STAGING_TASK_STATE } from '../../server/domain/staging'
import { TASK_STATE } from '../../server/domain/vocabulary'

/* Record-change rules driving the Order lifecycle (ADR 0004). */

/** A fleet asset changed its stage: the change test and the Fleet flag every stage rule on alm_hardware starts with. */
const FLEET_ASSET_STAGE_CHANGED = `(current.install_status.changes() || current.substatus.changes()) && ${CURRENT_IS_FLEET}`

/*
 * alm_hardware and wm_order are global tables: the platform refuses current.setAbortAction from this scope on their
 * records and saves anyway. So a before rule there refuses with its Abort action when its condition (the module's
 * check) holds, and its script only says why. The platform runs a condition on every save of the table, whether or not
 * the rule's filter matches, so each condition starts with its change test: the module loads only when that holds. The
 * condition field holds at most 254 characters.
 *
 * alm_hardware also holds the Provider IT's own equipment, which the app leaves alone (ADR 0016): each rule on it
 * tests the Fleet flag right after its change test, before anything else it checks or loads.
 *
 * wm_order holds the Provider IT's own field work too. A work order of a NaaS Order is one initiated from it (the
 * platform's Initiated from, a reference to any task, ADR 0018), so each rule on it tests the class of that task right
 * after its change test.
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
`${FLEET_ASSET_STAGE_CHANGED} && require('${ENTRY_MODULES}/assets.ts').refusesLifecycleChange(current, previous)`,
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
    condition: FLEET_ASSET_STAGE_CHANGED,
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
    condition: `${FLEET_ASSET_STAGE_CHANGED} && current.x_daas_ham_order_line != ''`,
    script: onAllocatedAssetStageChange,
})

BusinessRule({
    $id: Now.ID['br_asset_left_service'],
    name: 'NaaS - start or stop billing on service',
    table: 'alm_hardware',
    when: 'after',
    action: ['update'],
    order: 210,
    condition: FLEET_ASSET_STAGE_CHANGED,
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
    condition: `current.state.changes() && current.state == ${STAGING_TASK_STATE.closed}`,
    script: guardStagingClosure,
})

BusinessRule({
    $id: Now.ID['br_staging_closed'],
    name: 'NaaS - staged asset on staging closure',
    table: 'x_daas_ham_staging_task',
    when: 'after',
    action: ['update'],
    order: 200,
    condition: `current.state.changes() && current.state == ${STAGING_TASK_STATE.closed}`,
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
        `(current.expected_start.changes() || current.estimated_end.changes()) && current.initiated_from.sys_class_name == 'x_daas_ham_order' && require('${ENTRY_MODULES}/delivery.ts').refusesWorkWindow(current)`,
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
    condition: `current.state.changes() && current.state == ${TASK_STATE.closedComplete} && current.initiated_from.sys_class_name == 'x_daas_ham_order'`,
    script: onWorkOrderClosed,
})
