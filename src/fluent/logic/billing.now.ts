import '@servicenow/sdk/global'
import { BusinessRule, Record, ScheduledScript, ScriptAction, UiAction } from '@servicenow/sdk/core'
import {
    exportBillingPeriod,
    generateBillingLines,
    guardClosedBillingLine,
    guardClosedBillingPeriod,
    openMonthlyBillingPeriod,
    uiCloseBillingPeriod,
    uiExportBillingPeriod,
    uiRegenerateBillingPeriod,
} from '../../server/entry/billing'
import { finance } from '../security/roles.now'

/* Billing periods (P3.25, D66): monthly generation, review, close and lock, CSV export. */

ScheduledScript({
    $id: Now.ID['job_open_billing_period'],
    name: 'NaaS - open last month billing period',
    active: true,
    frequency: 'monthly',
    dayOfMonth: 1,
    executionTime: { hours: 2, minutes: 40, seconds: 0 },
    timeZone: 'UTC',
    script: openMonthlyBillingPeriod,
})

export const billingGenerateEvent = Record({
    $id: Now.ID['event_billing_generate'],
    table: 'sysevent_register',
    data: {
        suffix: 'billing.generate',
        event_name: 'x_daas_ham.billing.generate',
        table: 'x_daas_ham_billing_period',
        description: 'Generate the lines of a billing period; parm1 = period, parm2 = cursor.',
        fired_by: 'entry/billing.ts openMonthlyBillingPeriod, uiRegenerateBillingPeriod',
        priority: 200,
    },
})

ScriptAction({
    $id: Now.ID['sa_billing_generate'],
    name: 'NaaS - generate billing lines',
    eventName: 'x_daas_ham.billing.generate',
    active: true,
    script: generateBillingLines,
    description: 'Prorates the active subscription lines of a billing period in time-boxed chunks, then adds open fee events.',
})

export const billingExportEvent = Record({
    $id: Now.ID['event_billing_export'],
    table: 'sysevent_register',
    data: {
        suffix: 'billing.export',
        event_name: 'x_daas_ham.billing.export',
        table: 'x_daas_ham_billing_period',
        description: 'Attach the CSV export of a closed billing period unless it is already attached; parm1 = period.',
        fired_by: 'entry/billing.ts uiCloseBillingPeriod, uiExportBillingPeriod',
        priority: 200,
    },
})

ScriptAction({
    $id: Now.ID['sa_billing_export'],
    name: 'NaaS - export billing period',
    eventName: 'x_daas_ham.billing.export',
    active: true,
    script: exportBillingPeriod,
    description: 'Builds billing-YYYY-MM.csv from the lines of a closed billing period and attaches it to the period, without updating the period.',
})

UiAction({
    $id: Now.ID['ua_billing_regenerate'],
    name: 'Regenerate',
    table: 'x_daas_ham_billing_period',
    actionName: 'x_daas_ham_billing_regenerate',
    hint: 'Rebuild the lines from the current subscription lines, service intervals and fee events.',
    condition: "current.status == 'ready'",
    roles: [finance],
    form: { showButton: true },
    showUpdate: true,
    script: uiRegenerateBillingPeriod,
})

UiAction({
    $id: Now.ID['ua_billing_close'],
    name: 'Close period',
    table: 'x_daas_ham_billing_period',
    actionName: 'x_daas_ham_billing_close',
    hint: 'Mark the fees billed and lock the period; the CSV export is attached in the background shortly after.',
    condition: "current.status == 'ready'",
    roles: [finance],
    form: { showButton: true, style: 'primary' },
    showUpdate: true,
    script: uiCloseBillingPeriod,
})

UiAction({
    $id: Now.ID['ua_billing_reexport'],
    name: 'Re-export CSV',
    table: 'x_daas_ham_billing_period',
    actionName: 'x_daas_ham_billing_reexport',
    hint: 'Attach the CSV export again if it is missing (delete the attached one first to rebuild it).',
    condition: "current.status == 'closed'",
    roles: [finance],
    form: { showButton: true },
    showUpdate: true,
    script: uiExportBillingPeriod,
})

BusinessRule({
    $id: Now.ID['br_billing_line_locked'],
    name: 'NaaS - closed billing lines are locked',
    table: 'x_daas_ham_billing_line',
    when: 'before',
    action: ['update', 'delete'],
    order: 100,
    script: guardClosedBillingLine,
})

BusinessRule({
    $id: Now.ID['br_billing_period_locked'],
    name: 'NaaS - closed billing periods are locked',
    table: 'x_daas_ham_billing_period',
    when: 'before',
    action: ['update', 'delete'],
    order: 100,
    script: guardClosedBillingPeriod,
})
