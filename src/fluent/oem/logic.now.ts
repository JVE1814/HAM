import '@servicenow/sdk/global'
import { BusinessRule, EmailNotification, Property, Record, ScheduledScript } from '@servicenow/sdk/core'
import { processCoverageRow, syncOemCoverage, syncOemLifecycle, syncOemRmaStatus } from '../../server/entry/oem-sync'
import { EVENT } from '../../server/platform/events'
import { PROPERTY } from '../../server/platform/properties'
import { runOemClaims } from '../../server/entry/oem-claims'
import { REST_MESSAGE } from '../../server/domain/rest-message-names'
import { admin } from '../shared/roles.now'

/* OEM data (ADR 0008): coverage imports and expiry warnings, the sync jobs, claims, and each vendor's settings. */

BusinessRule({
    $id: Now.ID['br_coverage_row'],
    name: 'NaaS - process OEM coverage import row',
    table: 'x_daas_ham_coverage_import',
    when: 'after',
    action: ['insert'],
    order: 200,
    script: processCoverageRow,
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

ScheduledScript({
    $id: Now.ID['job_oem_lifecycle'],
    name: 'NaaS - sync OEM lifecycle (EoX)',
    active: true,
    frequency: 'daily',
    executionTime: { hours: 1, minutes: 35, seconds: 0 },
    timeZone: 'UTC',
    script: syncOemLifecycle,
})

ScheduledScript({
    $id: Now.ID['job_oem_coverage'],
    name: 'NaaS - sync OEM coverage',
    active: true,
    frequency: 'periodically',
    executionInterval: { hours: 4 },
    executionStart: '2026-01-01 00:50:00',
    timeZone: 'UTC',
    script: syncOemCoverage,
})

ScheduledScript({
    $id: Now.ID['job_oem_rma_status'],
    name: 'NaaS - sync OEM RMA status',
    active: true,
    frequency: 'periodically',
    executionInterval: { hours: 1 },
    executionStart: '2026-01-01 00:05:00',
    timeZone: 'UTC',
    script: syncOemRmaStatus,
})

/* OEM claim and provisioning of staging steps (P3.27, D70). Every vendor is off until enabled. */

ScheduledScript({
    $id: Now.ID['job_oem_claims'],
    name: 'NaaS - OEM claim and provisioning',
    active: true,
    frequency: 'periodically',
    executionInterval: { minutes: 5 },
    executionStart: '2026-01-01 00:02:00',
    timeZone: 'UTC',
    script: runOemClaims,
})

Property({
    $id: Now.ID['prop_claim_max_calls'],
    name: PROPERTY.claimMaxCalls.name,
    type: 'integer',
    value: PROPERTY.claimMaxCalls.default,
    description: 'API calls per vendor per 5-minute run (Meraki allows 10 claim calls per 5 minutes).',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_claim_meraki'],
    name: PROPERTY.claimEnabled.meraki.name,
    type: 'boolean',
    value: PROPERTY.claimEnabled.meraki.default,
    description: 'Claim Meraki devices into the customer organization during staging.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_claim_mist'],
    name: PROPERTY.claimEnabled.mist.name,
    type: 'boolean',
    value: PROPERTY.claimEnabled.mist.default,
    description: 'Claim Mist devices (by claim code) into the customer org during staging.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_claim_aruba'],
    name: PROPERTY.claimEnabled.aruba.name,
    type: 'boolean',
    value: PROPERTY.claimEnabled.aruba.default,
    description: 'Add Aruba devices to the GreenLake workspace and assign the customer subscription during staging.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_claim_fortinet'],
    name: PROPERTY.claimEnabled.fortinet.name,
    type: 'boolean',
    value: PROPERTY.claimEnabled.fortinet.default,
    description: 'Register FortiGates in FortiCloud and provision them through FortiZTP during staging.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_claim_checkpoint'],
    name: PROPERTY.claimEnabled.checkpoint.name,
    type: 'boolean',
    value: PROPERTY.claimEnabled.checkpoint.default,
    description: 'Claim Check Point gateways in Zero Touch with their customer template during staging.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_checkpoint_client_id'],
    name: PROPERTY.checkpointApiClientId.name,
    type: 'password2',
    value: PROPERTY.checkpointApiClientId.default,
    description: 'Check Point Zero Touch API Client ID.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_checkpoint_key'],
    name: PROPERTY.checkpointApiKey.name,
    type: 'password2',
    value: PROPERTY.checkpointApiKey.default,
    description: 'Check Point Zero Touch API Key (expires after 1-180 days; regenerate in Zero Touch portal > Manage API Key).',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_oem_cisco'],
    name: PROPERTY.oemEnabled.cisco.name,
    type: 'boolean',
    value: PROPERTY.oemEnabled.cisco.default,
    description: `Call the Cisco Support APIs (EoX, coverage, RMA status). Attach an OAuth profile to the "${REST_MESSAGE.ciscoSupport.name}" REST message first.`,
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_oem_meraki'],
    name: PROPERTY.oemEnabled.meraki.name,
    type: 'boolean',
    value: PROPERTY.oemEnabled.meraki.default,
    description: 'Call the Meraki Dashboard API for EoX data.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_oem_fortinet'],
    name: PROPERTY.oemEnabled.fortinet.name,
    type: 'boolean',
    value: PROPERTY.oemEnabled.fortinet.default,
    description: `Call the FortiCloud Asset Management API for coverage. Attach an OAuth profile to "${REST_MESSAGE.fortiCare.name}" first.`,
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_oem_mist'],
    name: PROPERTY.oemEnabled.mist.name,
    type: 'boolean',
    value: PROPERTY.oemEnabled.mist.default,
    description: 'Call the HPE Mist API for lifecycle and warranty data.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_meraki_orgs'],
    name: PROPERTY.oemOrgIds.meraki.name,
    type: 'string',
    value: PROPERTY.oemOrgIds.meraki.default,
    description: 'Comma-separated Meraki organisation ids searched for devices.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_mist_orgs'],
    name: PROPERTY.oemOrgIds.mist.name,
    type: 'string',
    value: PROPERTY.oemOrgIds.mist.default,
    description: 'Comma-separated Mist organisation ids searched for devices.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_meraki_host'],
    name: PROPERTY.merakiApiHost.name,
    type: 'string',
    value: PROPERTY.merakiApiHost.default,
    description:
        'Meraki Dashboard API host: api.meraki.com in most of the world; api.meraki.ca (Canada), api.meraki.cn (China), api.meraki.in (India), api.gov-meraki.com (US FedRAMP).',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_mist_host'],
    name: PROPERTY.mistApiHost.name,
    type: 'string',
    value: PROPERTY.mistApiHost.default,
    description:
        `HPE Mist API host of the cloud the orgs are on: the portal host with "manage" replaced by "api" (e.g. api.mist.com Global 01, api.gc1.mist.com Global 02, api.eu.mist.com EMEA 01, api.ac5.mist.com APAC 01). All orgs in ${PROPERTY.oemOrgIds.mist.name} must be on this cloud.`,
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_meraki_key'],
    name: PROPERTY.merakiApiKey.name,
    type: 'password2',
    value: PROPERTY.merakiApiKey.default,
    description: 'Meraki Dashboard API key.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_mist_token'],
    name: PROPERTY.mistApiToken.name,
    type: 'password2',
    value: PROPERTY.mistApiToken.default,
    description: 'HPE Mist org API token (Mist removes a token unused for 90 days).',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_coverage_refresh'],
    name: PROPERTY.coverageRefreshDays.name,
    type: 'integer',
    value: PROPERTY.coverageRefreshDays.default,
    description: "Days before an asset's OEM coverage is checked again.",
    roles: { read: [admin], write: [admin] },
})
