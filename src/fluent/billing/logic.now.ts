import '@servicenow/sdk/global'
import { BusinessRule, Record, ScheduledScript, ScriptAction, UiAction } from '@servicenow/sdk/core'
import {
    exportBillingPeriod,
    onAssetServiceChange,
    generateBillingLines,
    guardBillingPeriodMonth,
    guardClosedBillingLine,
    guardClosedBillingPeriod,
    openMonthlyBillingPeriod,
    uiCloseBillingPeriod,
    uiExportBillingPeriod,
    uiRegenerateBillingPeriod,
    uiResetBillingGeneration,
} from '../../server/entry/billing'
import { generateNewPeriod } from '../../server/platform/billing'
import { EVENT } from '../../server/domain/events'
import { CURRENT_FLEET_STAGE_CHANGED } from '../../server/domain/fleet'
import { BILLING_PERIOD_STATUS } from '../../server/domain/vocabulary'
import { RESET_AFTER_IDLE_MINUTES } from '../../server/domain/billing'
import { admin, finance } from '../shared/roles.now'

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

Record({
    $id: Now.ID['event_billing_generate'],
    table: 'sysevent_register',
    data: {
        suffix: 'billing.generate',
        event_name: EVENT.billingGenerate,
        table: 'x_daas_ham_billing_period',
        // Holds 100 characters at most; the pass token is kept on job cursor billing_generate_<period>.
        description: 'Generate the lines of a billing period; parm1 = period, parm2 = pass token:cursor.',
        priority: 200,
    },
})

ScriptAction({
    $id: Now.ID['sa_billing_generate'],
    name: 'NaaS - generate billing lines',
    eventName: EVENT.billingGenerate,
    active: true,
    script: generateBillingLines,
    description: 'Prorates the active subscription lines of a billing period in time-boxed chunks, then adds open fee events.',
})

Record({
    $id: Now.ID['event_billing_export'],
    table: 'sysevent_register',
    data: {
        suffix: 'billing.export',
        event_name: EVENT.billingExport,
        table: 'x_daas_ham_billing_period',
        description: 'Attach the CSV export of a closed billing period unless it is already attached; parm1 = period.',
        priority: 200,
    },
})

ScriptAction({
    $id: Now.ID['sa_billing_export'],
    name: 'NaaS - export billing period',
    eventName: EVENT.billingExport,
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
    condition: `current.status == '${BILLING_PERIOD_STATUS.ready}'`,
    roles: [finance],
    form: { showButton: true },
    showUpdate: true,
    script: uiRegenerateBillingPeriod,
})

// A generation that stopped without being held for review (e.g. its chunk died) is left Generating.
UiAction({
    $id: Now.ID['ua_billing_reset_generation'],
    name: 'Reset generation',
    table: 'x_daas_ham_billing_period',
    actionName: 'x_daas_ham_billing_reset_generation',
    hint: `Hold a generation that has shown no activity for ${RESET_AFTER_IDLE_MINUTES} minutes as Ready for review, to Regenerate; deletes and bills nothing.`,
    condition: `current.status == '${BILLING_PERIOD_STATUS.generating}'`,
    roles: [admin],
    form: { showButton: true },
    showUpdate: true,
    script: uiResetBillingGeneration,
})

UiAction({
    $id: Now.ID['ua_billing_close'],
    name: 'Close period',
    table: 'x_daas_ham_billing_period',
    actionName: 'x_daas_ham_billing_close',
    hint: 'Mark the fees billed and lock the period; the CSV export is attached in the background shortly after.',
    condition: `current.status == '${BILLING_PERIOD_STATUS.ready}'`,
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
    condition: `current.status == '${BILLING_PERIOD_STATUS.closed}'`,
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

BusinessRule({
    $id: Now.ID['br_billing_period_month'],
    name: 'NaaS - check billing period month',
    table: 'x_daas_ham_billing_period',
    when: 'before',
    action: ['insert', 'update'],
    order: 100,
    condition: 'current.period.changes()',
    script: guardBillingPeriodMonth,
})

BusinessRule({
    $id: Now.ID['br_billing_period_generate'],
    name: 'NaaS - generate a new billing period',
    table: 'x_daas_ham_billing_period',
    when: 'after',
    action: ['insert'],
    order: 200,
    condition: `current.status == '${BILLING_PERIOD_STATUS.generating}'`,
    script: generateNewPeriod,
})

BusinessRule({
    $id: Now.ID['br_asset_left_service'],
    name: 'NaaS - start or stop billing on service',
    table: 'alm_hardware',
    when: 'after',
    action: ['update'],
    order: 210,
    condition: CURRENT_FLEET_STAGE_CHANGED,
    script: onAssetServiceChange,
})

