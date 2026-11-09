import '@servicenow/sdk/global'
import { BusinessRule, EmailNotification, Record, ScheduledScript, Sla, UiAction } from '@servicenow/sdk/core'
import { onCaseFailedAsset, uiDefectiveReturnedToOem, uiRaiseReplacement } from '../../server/entry/breakfix'
import { chaseOverdueReturns, onReturnEvaluated, raiseScheduledReturns } from '../../server/entry/returns'
import { assetManager, inventoryTech, noc } from '../security/roles.now'
import { ORDER_STAGE, RETURN_LINE_STATUS, RMA_STATE } from '../../server/domain/vocabulary'

/* Break-fix (D58) and returns (D60): rules, actions, SLAs, jobs and notifications. */

BusinessRule({
    $id: Now.ID['br_case_failed_asset'],
    name: 'NaaS - case failed asset service level',
    table: 'sn_customerservice_case',
    when: 'before',
    action: ['insert', 'update'],
    order: 100,
    condition: "current.x_daas_ham_failed_asset.changes() && current.x_daas_ham_failed_asset != ''",
    script: onCaseFailedAsset,
})

UiAction({
    $id: Now.ID['ua_case_raise_replacement'],
    name: 'Raise replacement',
    table: 'sn_customerservice_case',
    actionName: 'x_daas_ham_raise_replacement',
    hint: 'Order a like-for-like replacement of the failed asset (spare at the site, spare pool, stock, OEM advance replacement or purchase).',
    // Offered while no replacement goes ahead: none linked, or the linked one ended unfulfilled (domain/breakfix
    // replacementStep, which built-metadata.test.ts holds the built condition to).
    condition:
        `current.x_daas_ham_failed_asset != '' && current.active == true && (current.x_daas_ham_replacement_order == '' || ['${ORDER_STAGE.rejected}', '${ORDER_STAGE.cancelled}'].indexOf(String(current.x_daas_ham_replacement_order.stage)) >= 0)`,
    roles: [noc, assetManager, 'sn_customerservice_agent'],
    form: { showButton: true, style: 'primary' },
    showUpdate: true,
    script: uiRaiseReplacement,
})

UiAction({
    $id: Now.ID['ua_rma_defective_returned'],
    name: 'Defective returned to OEM',
    table: 'x_daas_ham_oem_rma',
    actionName: 'x_daas_ham_rma_defective_returned',
    hint: 'Record that the defective unit was shipped back to the manufacturer (needs wipe evidence on the asset).',
    // domain/sourcing RMA_AT_OEM, which built-metadata.test.ts holds the built condition to.
    condition: `['${RMA_STATE.open}','${RMA_STATE.replacement_received}'].indexOf(current.state + '') >= 0`,
    roles: [inventoryTech, assetManager],
    form: { showButton: true },
    showUpdate: true,
    script: uiDefectiveReturnedToOem,
})

Sla({
    $id: Now.ID['sla_replace_nbd'],
    name: 'NaaS replacement - next business day',
    table: 'sn_customerservice_case',
    target: 'resolution',
    duration: Duration({ days: 1 }),
    scheduleSource: 'no_schedule',
    conditions: {
        start: 'x_daas_ham_failed_assetISNOTEMPTY^x_daas_ham_replacement_tier=nbd',
        stop: `x_daas_ham_replacement_order.stage=${ORDER_STAGE.complete}`,
        cancel: `active=false^x_daas_ham_replacement_order.stage!=${ORDER_STAGE.complete}`,
    },
})

Sla({
    $id: Now.ID['sla_replace_same_day'],
    name: 'NaaS replacement - same day (8 hours)',
    table: 'sn_customerservice_case',
    target: 'resolution',
    duration: Duration({ hours: 8 }),
    scheduleSource: 'no_schedule',
    conditions: {
        start: 'x_daas_ham_failed_assetISNOTEMPTY^x_daas_ham_replacement_tier=same_day',
        stop: `x_daas_ham_replacement_order.stage=${ORDER_STAGE.complete}`,
        cancel: `active=false^x_daas_ham_replacement_order.stage!=${ORDER_STAGE.complete}`,
    },
})

Sla({
    $id: Now.ID['sla_replace_four_hour'],
    name: 'NaaS replacement - 24x7x4',
    table: 'sn_customerservice_case',
    target: 'resolution',
    duration: Duration({ hours: 4 }),
    scheduleSource: 'no_schedule',
    conditions: {
        start: 'x_daas_ham_failed_assetISNOTEMPTY^x_daas_ham_replacement_tier=four_hour',
        stop: `x_daas_ham_replacement_order.stage=${ORDER_STAGE.complete}`,
        cancel: `active=false^x_daas_ham_replacement_order.stage!=${ORDER_STAGE.complete}`,
    },
})

BusinessRule({
    $id: Now.ID['br_return_evaluated'],
    name: 'NaaS - route evaluated return',
    table: 'x_daas_ham_return_order_line',
    when: 'after',
    action: ['update'],
    order: 200,
    condition: `current.evaluation.changes() && current.evaluation != '' && current.status == '${RETURN_LINE_STATUS.received}'`,
    script: onReturnEvaluated,
})

export const returnOverdueEvent = Record({
    $id: Now.ID['event_return_overdue'],
    table: 'sysevent_register',
    data: {
        suffix: 'return.overdue',
        event_name: 'x_daas_ham.return.overdue',
        table: 'x_daas_ham_return_order',
        description: 'Equipment on a return order was not received by its due date; parm1 = recipients, parm2 = asset.',
        fired_by: 'entry/returns.ts chaseOverdueReturns',
        priority: 100,
    },
})

EmailNotification({
    $id: Now.ID['mail_return_overdue'],
    table: 'x_daas_ham_return_order',
    name: 'NaaS - return overdue',
    description: 'Tells the customer admins and the account manager that equipment is overdue for return.',
    active: true,
    triggerConditions: { generationType: 'event', eventName: 'x_daas_ham.return.overdue' },
    recipientDetails: { eventParm1WithRecipient: true },
    emailContent: {
        subject: 'Equipment overdue for return: ${number}',
        messageHtml:
            '<p>Equipment on return order ${number} (${site}) was due back by ${due_back} and has not arrived.</p><p>Please ship it back or arrange collection. Equipment not returned within the grace period is charged as lost under your agreement.</p>',
        importance: 'high',
    },
})

ScheduledScript({
    $id: Now.ID['job_chase_overdue_returns'],
    name: 'NaaS - chase overdue returns',
    active: true,
    frequency: 'daily',
    executionTime: { hours: 5, minutes: 20, seconds: 0 },
    timeZone: 'UTC',
    script: chaseOverdueReturns,
})

ScheduledScript({
    $id: Now.ID['job_scheduled_returns'],
    name: 'NaaS - raise agreement-end and temporary-end returns',
    active: true,
    frequency: 'daily',
    executionTime: { hours: 4, minutes: 45, seconds: 0 },
    timeZone: 'UTC',
    script: raiseScheduledReturns,
})
