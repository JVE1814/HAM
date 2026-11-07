import '@servicenow/sdk/global'
import { BusinessRule, EmailNotification, Property, Record, ScheduledScript, ScriptAction, UiAction } from '@servicenow/sdk/core'
import { onAgreementEndChanged, onAssetLeaseChanged, refreshLeaseAssets, reviewLeases, transferLeaseAssets, uiApplyLeaseDecision, uiRenewAgreement, warnRenewals } from '../../server/entry/leases'
import { accountManager, admin, assetManager, finance } from '../security/roles.now'

/* Leases, end-of-lease decisions and renewals (P3.23–P3.24). */

BusinessRule({
    $id: Now.ID['br_asset_lease'],
    name: 'NaaS - leased asset owned by the lessor',
    table: 'alm_hardware',
    when: 'before',
    action: ['insert', 'update'],
    order: 90,
    condition: "current.x_daas_ham_lease.changes() && current.x_daas_ham_lease != ''",
    script: onAssetLeaseChanged,
})

UiAction({
    $id: Now.ID['ua_lease_apply_decision'],
    name: 'Apply decision',
    table: 'x_daas_ham_lease_decision',
    actionName: 'x_daas_ham_lease_apply_decision',
    hint: 'Buy out (the Provider owns the assets), extend (the lease runs to the new end date) or return (stock to the lessor, deployed assets refreshed before the lease end).',
    condition: 'current.active == true',
    roles: [assetManager, finance],
    form: { showButton: true, style: 'primary' },
    showUpdate: true,
    script: uiApplyLeaseDecision,
})

BusinessRule({
    $id: Now.ID['br_agreement_end_changed'],
    name: 'NaaS - re-arm renewal warning when the agreement end changes',
    table: 'x_daas_ham_agreement',
    when: 'before',
    action: ['update'],
    order: 100,
    condition: "current.ends.changes() && current.ends != ''",
    script: onAgreementEndChanged,
})

UiAction({
    $id: Now.ID['ua_agreement_renew'],
    name: 'Renew agreement',
    table: 'x_daas_ham_agreement',
    actionName: 'x_daas_ham_agreement_renew',
    hint: 'Extend the end date by the renewal term.',
    condition: "current.ends != ''",
    roles: [accountManager, assetManager],
    form: { showButton: true },
    showUpdate: true,
    script: uiRenewAgreement,
})

ScheduledScript({
    $id: Now.ID['job_review_leases'],
    name: 'NaaS - review leases',
    active: true,
    frequency: 'daily',
    executionTime: { hours: 5, minutes: 35, seconds: 0 },
    timeZone: 'UTC',
    script: reviewLeases,
})

ScheduledScript({
    $id: Now.ID['job_warn_renewals'],
    name: 'NaaS - agreement renewal and coverage expiry warnings',
    active: true,
    frequency: 'daily',
    executionTime: { hours: 5, minutes: 50, seconds: 0 },
    timeZone: 'UTC',
    script: warnRenewals,
})

export const leaseAssetsEvent = Record({
    $id: Now.ID['event_lease_assets'],
    table: 'sysevent_register',
    data: {
        suffix: 'lease.assets',
        event_name: 'x_daas_ham.lease.assets',
        table: 'x_daas_ham_lease_schedule',
        description: "A lease is being returned; recompute its deployed assets' refresh due dates. parm1 = lease, parm2 = cursor.",
        fired_by: 'entry/leases.ts uiApplyLeaseDecision',
        priority: 200,
    },
})

ScriptAction({
    $id: Now.ID['sa_lease_assets'],
    name: 'NaaS - refresh due dates of a returned lease',
    eventName: 'x_daas_ham.lease.assets',
    active: true,
    script: refreshLeaseAssets,
    description: 'Brings refresh due dates forward to the lease end so automatic refresh swaps the equipment out in time.',
})

export const leaseBuyoutEvent = Record({
    $id: Now.ID['event_lease_buyout'],
    table: 'sysevent_register',
    data: {
        suffix: 'lease.buyout',
        event_name: 'x_daas_ham.lease.buyout',
        table: 'x_daas_ham_lease_schedule',
        description: "A lease is being bought out; transfer its assets to the Provider at the lease's buyout cost per asset. parm1 = lease, parm2 = cursor.",
        fired_by: 'entry/leases.ts uiApplyLeaseDecision',
        priority: 200,
    },
})

ScriptAction({
    $id: Now.ID['sa_lease_buyout'],
    name: 'NaaS - transfer a bought-out lease to the Provider',
    eventName: 'x_daas_ham.lease.buyout',
    active: true,
    script: transferLeaseAssets,
    description: 'Takes each asset off the lease, makes the Provider its legal owner and sets its cost to its share of the buyout price.',
})

export const leaseMismatchEvent = Record({
    $id: Now.ID['event_lease_mismatch'],
    table: 'sysevent_register',
    data: {
        suffix: 'lease.mismatch',
        event_name: 'x_daas_ham.lease.mismatch',
        table: 'x_daas_ham_lease_schedule',
        description: 'A lease ends before the agreements its deployed assets serve; parm1 = recipients.',
        fired_by: 'entry/leases.ts reviewLeases',
        priority: 200,
    },
})

EmailNotification({
    $id: Now.ID['mail_lease_mismatch'],
    table: 'x_daas_ham_lease_schedule',
    name: 'NaaS - lease ends before the service',
    description: 'Tells the asset managers that a lease ends while its equipment still serves customers.',
    active: true,
    triggerConditions: { generationType: 'event', eventName: 'x_daas_ham.lease.mismatch' },
    recipientDetails: { eventParm1WithRecipient: true },
    emailContent: {
        subject: 'Lease ${number} ends before the service it supports',
        messageHtml:
            '<p>Lease schedule ${number} with ${lessor} ends on ${ends}, but some of its equipment serves agreements that run longer (or have no end date).</p><p>Plan a buyout, an extension or a refresh before the lease end.</p>',
        importance: 'high',
    },
})

export const agreementRenewalEvent = Record({
    $id: Now.ID['event_agreement_renewal'],
    table: 'sysevent_register',
    data: {
        suffix: 'agreement.renewal',
        event_name: 'x_daas_ham.agreement.renewal',
        table: 'x_daas_ham_agreement',
        description: 'An agreement is within its renewal lead time; parm1 = recipients.',
        fired_by: 'entry/leases.ts warnRenewals',
        priority: 200,
    },
})

EmailNotification({
    $id: Now.ID['mail_agreement_renewal'],
    table: 'x_daas_ham_agreement',
    name: 'NaaS - agreement up for renewal',
    description: 'Tells the account manager (or the asset managers) that an agreement ends soon.',
    active: true,
    triggerConditions: { generationType: 'event', eventName: 'x_daas_ham.agreement.renewal' },
    recipientDetails: { eventParm1WithRecipient: true },
    emailContent: {
        subject: 'Agreement ${number} (${customer}) ends on ${ends}',
        messageHtml:
            '<p>Agreement ${number} with ${customer} ends on ${ends}.</p><p>Renew it (Renew agreement) or let it end: at the end date all installed equipment is recovered automatically.</p>',
    },
})

export const coverageExpiringEvent = Record({
    $id: Now.ID['event_coverage_expiring'],
    table: 'sysevent_register',
    data: {
        suffix: 'coverage.expiring',
        event_name: 'x_daas_ham.coverage.expiring',
        table: 'customer_account',
        description: 'OEM coverage of deployed assets ends soon; parm1 = recipients, parm2 = summary.',
        fired_by: 'entry/leases.ts warnRenewals',
        priority: 200,
    },
})

EmailNotification({
    $id: Now.ID['mail_coverage_expiring'],
    table: 'customer_account',
    name: 'NaaS - OEM coverage expiring',
    description: 'Tells the asset managers that OEM coverage of a customer’s deployed equipment ends soon.',
    active: true,
    triggerConditions: { generationType: 'event', eventName: 'x_daas_ham.coverage.expiring' },
    recipientDetails: { eventParm1WithRecipient: true },
    emailContent: {
        subject: 'OEM coverage expiring for ${name}',
        messageHtml:
            '<p>${event.parm2} for equipment deployed at ${name}.</p><p>Renew the coverage with the manufacturer; the next coverage sync or CSV import picks up the new end dates.</p>',
    },
})

Property({
    $id: Now.ID['prop_coverage_warning_days'],
    name: 'x_daas_ham.oem.coverage_warning_days',
    type: 'integer',
    value: 60,
    description: 'Days before an OEM coverage contract of deployed equipment ends that the asset managers are warned.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_lease_decision_group'],
    name: 'x_daas_ham.leases.decision_group',
    type: 'string',
    value: '',
    description: 'sys_id of the group that end-of-lease decisions are assigned to (blank = unassigned).',
    roles: { read: [admin], write: [admin] },
})
