import '@servicenow/sdk/global'
import { BusinessRule, EmailNotification, Property, Record, ScheduledScript, ScriptAction, UiAction } from '@servicenow/sdk/core'
import {
    onAgreementEndChanged,
    onAssetLeaseChanged,
    onReturnedLeaseEndChanged,
    refreshLeaseAssets,
    reviewLeases,
    transferLeaseAssets,
    uiApplyLeaseDecision,
    uiRenewAgreement,
    warnRenewals,
} from '../../server/entry/leases'
import { admin, commercialEditors, leaseEditors } from '../security/roles.now'
import { CURRENT_IS_FLEET, FLEET_FIELD } from '../../server/domain/fleet'
import { LEASE_END_ACTION } from '../../server/domain/vocabulary'
import { EVENT } from '../../server/platform/events'
import { PROPERTY } from '../../server/platform/properties'

/* Leases, end-of-lease decisions and renewals (P3.23–P3.24). */

// Fleet assets only (ADR 0016): the condition tests the Fleet flag right after its change test, as the rules.now.ts
// header has it. A unit of the Provider IT's that joins the fleet with its Lease schedule already set (Add to fleet, a
// warehouse receipt) changes only its flag, so that change runs the rule too, in the save that adds it.
BusinessRule({
    $id: Now.ID['br_asset_lease'],
    name: 'NaaS - leased asset owned by the lessor',
    table: 'alm_hardware',
    when: 'before',
    action: ['insert', 'update'],
    order: 90,
    condition:
        `(current.x_daas_ham_lease.changes() || current.${FLEET_FIELD}.changes()) && ${CURRENT_IS_FLEET} && current.x_daas_ham_lease != ''`,
    script: onAssetLeaseChanged,
})

UiAction({
    $id: Now.ID['ua_lease_apply_decision'],
    name: 'Apply decision',
    table: 'x_daas_ham_lease_decision',
    actionName: 'x_daas_ham_lease_apply_decision',
    hint: 'Buy out (the Provider owns the assets), extend (the lease runs to the new end date) or return (stock to pending wipe for the lessor, deployed assets refreshed before the lease end). A lease being bought out or returned takes no further decision.',
    condition: 'current.active == true',
    roles: leaseEditors,
    form: { showButton: true, style: 'primary' },
    showUpdate: true,
    script: uiApplyLeaseDecision,
})

BusinessRule({
    $id: Now.ID['br_returned_lease_end_changed'],
    name: 'NaaS - refresh due follows lease end',
    table: 'x_daas_ham_lease_schedule',
    when: 'after',
    action: ['update'],
    order: 200,
    condition: `current.ends.changes() && current.end_action == '${LEASE_END_ACTION.return}'`,
    script: onReturnedLeaseEndChanged,
})

BusinessRule({
    $id: Now.ID['br_agreement_end_changed'],
    name: 'NaaS - re-arm renewal warning on new end',
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
    roles: commercialEditors,
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

Record({
    $id: Now.ID['event_lease_assets'],
    table: 'sysevent_register',
    data: {
        suffix: 'lease.assets',
        event_name: EVENT.leaseAssets,
        table: 'x_daas_ham_lease_schedule',
        description: 'Recompute refresh due dates of a returned lease\'s assets. parm1 = lease, parm2 = cursor.',
        priority: 200,
    },
})

ScriptAction({
    $id: Now.ID['sa_lease_assets'],
    name: 'NaaS - refresh due of a returned lease',
    eventName: EVENT.leaseAssets,
    active: true,
    script: refreshLeaseAssets,
    description: "Sets refresh due dates no later than the lease end (again when a returned lease's end moves) so automatic refresh swaps the equipment out in time.",
})

Record({
    $id: Now.ID['event_lease_buyout'],
    table: 'sysevent_register',
    data: {
        suffix: 'lease.buyout',
        event_name: EVENT.leaseBuyout,
        table: 'x_daas_ham_lease_schedule',
        description: 'Transfer a bought-out lease\'s assets to the Provider. parm1 = lease, parm2 = cursor.',
        priority: 200,
    },
})

ScriptAction({
    $id: Now.ID['sa_lease_buyout'],
    name: 'NaaS - transfer a bought-out lease',
    eventName: EVENT.leaseBuyout,
    active: true,
    script: transferLeaseAssets,
    description: 'Takes each asset off the lease, makes the Provider its legal owner and sets its cost to its share of the buyout price.',
})

Record({
    $id: Now.ID['event_lease_mismatch'],
    table: 'sysevent_register',
    data: {
        suffix: 'lease.mismatch',
        event_name: EVENT.leaseMismatch,
        table: 'x_daas_ham_lease_schedule',
        description: 'A lease ends before the agreements its deployed assets serve; parm1 = recipients.',
        priority: 200,
    },
})

EmailNotification({
    $id: Now.ID['mail_lease_mismatch'],
    table: 'x_daas_ham_lease_schedule',
    name: 'NaaS - lease ends before the service',
    description: 'Tells the asset managers that a lease ends while its equipment still serves customers.',
    active: true,
    triggerConditions: { generationType: 'event', eventName: EVENT.leaseMismatch },
    recipientDetails: { eventParm1WithRecipient: true },
    emailContent: {
        subject: 'Lease ${number} ends before the service it supports',
        messageHtml:
            '<p>Lease schedule ${number} with ${vendor} ends on ${ends}, but some of its equipment serves agreements that run longer (or have no end date).</p><p>Plan a buyout, an extension or a refresh before the lease end.</p>',
        importance: 'high',
    },
})

Record({
    $id: Now.ID['event_agreement_renewal'],
    table: 'sysevent_register',
    data: {
        suffix: 'agreement.renewal',
        event_name: EVENT.agreementRenewal,
        table: 'x_daas_ham_agreement',
        description: 'An agreement is within its renewal lead time; parm1 = recipients.',
        priority: 200,
    },
})

EmailNotification({
    $id: Now.ID['mail_agreement_renewal'],
    table: 'x_daas_ham_agreement',
    name: 'NaaS - agreement up for renewal',
    description: 'Tells the account manager (or the asset managers) that an agreement ends soon.',
    active: true,
    triggerConditions: { generationType: 'event', eventName: EVENT.agreementRenewal },
    recipientDetails: { eventParm1WithRecipient: true },
    emailContent: {
        subject: 'Agreement ${number} (${customer}) ends on ${ends}',
        messageHtml:
            '<p>Agreement ${number} with ${customer} ends on ${ends}.</p><p>Renew it (Renew agreement) or let it end: at the end date all installed equipment is recovered automatically.</p>',
    },
})

Record({
    $id: Now.ID['event_coverage_expiring'],
    table: 'sysevent_register',
    data: {
        suffix: 'coverage.expiring',
        event_name: EVENT.coverageExpiring,
        table: 'customer_account',
        description: 'OEM coverage of deployed assets ends soon; parm1 = recipients, parm2 = summary.',
        priority: 200,
    },
})

EmailNotification({
    $id: Now.ID['mail_coverage_expiring'],
    table: 'customer_account',
    name: 'NaaS - OEM coverage expiring',
    description: 'Tells the asset managers that OEM coverage of a customer’s deployed equipment ends soon.',
    active: true,
    triggerConditions: { generationType: 'event', eventName: EVENT.coverageExpiring },
    recipientDetails: { eventParm1WithRecipient: true },
    emailContent: {
        subject: 'OEM coverage expiring for ${name}',
        messageHtml:
            '<p>${event.parm2} for equipment deployed at ${name}.</p><p>Renew the coverage with the manufacturer; the next coverage sync or CSV import picks up the new end dates.</p>',
    },
})

Property({
    $id: Now.ID['prop_coverage_warning_days'],
    name: PROPERTY.coverageWarningDays.name,
    type: 'integer',
    value: PROPERTY.coverageWarningDays.default,
    description: 'Days before an OEM coverage contract of deployed equipment ends that the asset managers are warned.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_lease_decision_group'],
    name: PROPERTY.leaseDecisionGroup.name,
    type: 'string',
    value: PROPERTY.leaseDecisionGroup.default,
    description: 'sys_id of the group that end-of-lease decisions are assigned to (blank = unassigned).',
    roles: { read: [admin], write: [admin] },
})
