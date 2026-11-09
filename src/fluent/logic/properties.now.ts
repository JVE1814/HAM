import '@servicenow/sdk/global'
import { Property } from '@servicenow/sdk/core'
import { admin } from '../security/roles.now'
import { PROPERTY } from '../../server/platform/properties'

/* The app's general settings; each takes its name and value from platform/properties PROPERTY, as every other Property record does. */

Property({
    $id: Now.ID['prop_job_batch_size'],
    name: PROPERTY.jobBatchSize.name,
    type: 'integer',
    value: PROPERTY.jobBatchSize.default,
    description: 'Records fetched per batch by chunked background jobs.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_job_budget_seconds'],
    name: PROPERTY.jobBudgetSeconds.name,
    type: 'integer',
    value: PROPERTY.jobBudgetSeconds.default,
    description: 'Seconds a chunked job may run before pausing; the next run resumes where it stopped.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_provider_company'],
    name: PROPERTY.providerCompany.name,
    type: 'string',
    value: PROPERTY.providerCompany.default,
    description: "sys_id of the Provider's own core_company record (company of unassigned stock).",
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_tag_prefix'],
    name: PROPERTY.tagPrefix.name,
    type: 'string',
    value: PROPERTY.tagPrefix.default,
    description: 'Prefix of Provider tags printed at receiving (e.g. NAAS-0000042).',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_tag_digits'],
    name: PROPERTY.tagDigits.name,
    type: 'integer',
    value: PROPERTY.tagDigits.default,
    description: 'Digits in the number part of a Provider tag.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_staging_stockroom'],
    name: PROPERTY.stagingStockroom.name,
    type: 'string',
    value: PROPERTY.stagingStockroom.default,
    description: 'sys_id of the staging-centre stockroom reserved stock is transferred to and purchases are shipped to.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_events_max_batch'],
    name: PROPERTY.eventsMaxBatch.name,
    type: 'integer',
    value: PROPERTY.eventsMaxBatch.default,
    description: 'Maximum device events accepted per REST request.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_events_retention_days'],
    name: PROPERTY.eventsRetentionDays.name,
    type: 'integer',
    value: PROPERTY.eventsRetentionDays.default,
    description: 'Days device events are kept.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_spare_auto_purchase'],
    name: PROPERTY.autoPurchaseSpares.name,
    type: 'boolean',
    value: PROPERTY.autoPurchaseSpares.default,
    description: 'When true, the spare-pool top-up job requests purchase orders for shortfalls central stock cannot cover.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_unseen_days'],
    name: PROPERTY.unseenDays.name,
    type: 'integer',
    value: PROPERTY.unseenDays.default,
    description: 'Days without a Seen signal before a deployed asset is reported as unseen.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_oem_cisco'],
    name: PROPERTY.oemEnabled.cisco.name,
    type: 'boolean',
    value: PROPERTY.oemEnabled.cisco.default,
    description: 'Call the Cisco Support APIs (EoX, coverage, RMA status). Attach an OAuth profile to the "NaaS Cisco Support" REST message first.',
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
    description: 'Call the FortiCloud Asset Management API for coverage. Attach an OAuth profile to "NaaS FortiCare" first.',
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
        'HPE Mist API host of the cloud the orgs are on: the portal host with "manage" replaced by "api" (e.g. api.mist.com Global 01, api.gc1.mist.com Global 02, api.eu.mist.com EMEA 01, api.ac5.mist.com APAC 01). All orgs in x_daas_ham.mist.org_ids must be on this cloud.',
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

Property({
    $id: Now.ID['prop_refresh_horizon'],
    name: PROPERTY.refreshHorizonDays.name,
    type: 'integer',
    value: PROPERTY.refreshHorizonDays.default,
    description: 'Assets whose refresh is due within this many days get refresh orders.',
    roles: { read: [admin], write: [admin] },
})
