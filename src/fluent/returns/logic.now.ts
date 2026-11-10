import '@servicenow/sdk/global'
import { BusinessRule, EmailNotification, Property, Record, ScheduledScript } from '@servicenow/sdk/core'
import { chaseOverdueReturns, onReturnEvaluated, raiseScheduledReturns } from '../../server/entry/returns'
import { RETURN_LINE_STATUS } from '../../server/domain/vocabulary'
import { EVENT } from '../../server/platform/events'
import { PROPERTY } from '../../server/platform/properties'
import { admin } from '../shared/roles.now'

/* Returns (D60): rules, jobs and notifications. */

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

Record({
    $id: Now.ID['event_return_overdue'],
    table: 'sysevent_register',
    data: {
        suffix: 'return.overdue',
        event_name: EVENT.returnOverdue,
        table: 'x_daas_ham_return_order',
        description: 'Equipment on a return order was not received by its due date; parm1 = recipients, parm2 = asset.',
        priority: 100,
    },
})

EmailNotification({
    $id: Now.ID['mail_return_overdue'],
    table: 'x_daas_ham_return_order',
    name: 'NaaS - return overdue',
    description: 'Tells the customer admins and the account manager that equipment is overdue for return.',
    active: true,
    triggerConditions: { generationType: 'event', eventName: EVENT.returnOverdue },
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

Property({
    $id: Now.ID['prop_return_grace'],
    name: PROPERTY.returnGraceDays.name,
    type: 'integer',
    value: PROPERTY.returnGraceDays.default,
    description: 'Days after the due date before unreturned equipment is declared missing and charged as lost.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_temporary_lead'],
    name: PROPERTY.temporaryReturnLeadDays.name,
    type: 'integer',
    value: PROPERTY.temporaryReturnLeadDays.default,
    description: 'Days before a temporary deployment ends that its return order is raised.',
    roles: { read: [admin], write: [admin] },
})
