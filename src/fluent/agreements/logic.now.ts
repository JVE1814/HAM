import '@servicenow/sdk/global'
import { BusinessRule, EmailNotification, Property, Record, ScheduledScript, ScriptAction, UiAction } from '@servicenow/sdk/core'
import { EVENT } from '../../server/domain/events'
import { PROPERTY } from '../../server/domain/properties'
import {
    guardAgreementCurrency,
    onAgreementTermsChanged,
    refreshAgreementAssets,
    uiRenewAgreement,
    warnRenewals,
} from '../../server/entry/agreements'
import { rearmForNewEnd } from '../../server/platform/renewals'
import { admin, commercialEditors } from '../shared/roles.now'

// A mistyped currency is refused as it is entered, not at the next generation (owner decision: one currency per Agreement).
BusinessRule({
    $id: Now.ID['br_agreement_currency'],
    name: 'NaaS - check the agreement currency',
    table: 'x_daas_ham_agreement',
    when: 'before',
    action: ['insert', 'update'],
    order: 100,
    condition: 'current.currency.changes()',
    script: guardAgreementCurrency,
})

BusinessRule({
    $id: Now.ID['br_agreement_end_changed'],
    name: 'NaaS - re-arm renewal warning on new end',
    table: 'x_daas_ham_agreement',
    when: 'before',
    action: ['update'],
    order: 100,
    condition: "current.ends.changes() && current.ends != ''",
    script: rearmForNewEnd,
})

BusinessRule({
    $id: Now.ID['br_agreement_terms_changed'],
    name: 'NaaS - agreement refresh terms changed',
    table: 'x_daas_ham_agreement',
    when: 'after',
    action: ['update'],
    order: 200,
    condition: 'current.refresh_cycle_months.changes() || current.refresh_basis.changes()',
    script: onAgreementTermsChanged,
})

Record({
    $id: Now.ID['event_agreement_terms'],
    table: 'sysevent_register',
    data: {
        suffix: 'agreement.terms',
        event_name: EVENT.agreementTermsChanged,
        table: 'x_daas_ham_agreement',
        description: "An agreement's refresh terms changed; parm1 = agreement, parm2 = cursor.",
        priority: 200,
    },
})

ScriptAction({
    $id: Now.ID['sa_agreement_terms'],
    name: 'NaaS - refresh due of agreement assets',
    eventName: EVENT.agreementTermsChanged,
    active: true,
    script: refreshAgreementAssets,
    description: "Recomputes refresh due dates for an agreement's deployed assets in time-boxed chunks.",
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
    $id: Now.ID['job_warn_renewals'],
    name: 'NaaS - agreement renewal and coverage expiry warnings',
    active: true,
    frequency: 'daily',
    executionTime: { hours: 5, minutes: 50, seconds: 0 },
    timeZone: 'UTC',
    script: warnRenewals,
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
