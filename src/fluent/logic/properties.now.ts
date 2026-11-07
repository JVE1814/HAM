import '@servicenow/sdk/global'
import { Property } from '@servicenow/sdk/core'
import { admin } from '../security/roles.now'

/* Tunables read via platform/properties.ts. */

Property({
    $id: Now.ID['prop_job_batch_size'],
    name: 'x_daas_ham.job.batch_size',
    type: 'integer',
    value: 500,
    description: 'Records fetched per batch by chunked background jobs.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_job_budget_seconds'],
    name: 'x_daas_ham.job.budget_seconds',
    type: 'integer',
    value: 120,
    description: 'Seconds a chunked job may run before pausing; the next run resumes where it stopped.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_provider_company'],
    name: 'x_daas_ham.provider_company',
    type: 'string',
    value: '',
    description: "sys_id of the Provider's own core_company record (company of unassigned stock).",
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_tag_prefix'],
    name: 'x_daas_ham.tag.prefix',
    type: 'string',
    value: 'NAAS',
    description: 'Prefix of Provider tags printed at receiving (e.g. NAAS-0000042).',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_tag_digits'],
    name: 'x_daas_ham.tag.digits',
    type: 'integer',
    value: 7,
    description: 'Digits in the number part of a Provider tag.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_staging_stockroom'],
    name: 'x_daas_ham.staging.default_stockroom',
    type: 'string',
    value: '',
    description: 'sys_id of the staging-centre stockroom reserved stock is transferred to and purchases are shipped to.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_events_max_batch'],
    name: 'x_daas_ham.events.max_batch',
    type: 'integer',
    value: 500,
    description: 'Maximum device events accepted per REST request.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_events_retention_days'],
    name: 'x_daas_ham.events.retention_days',
    type: 'integer',
    value: 90,
    description: 'Days device events are kept.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_spare_auto_purchase'],
    name: 'x_daas_ham.spare_pool.auto_purchase',
    type: 'boolean',
    value: false,
    description: 'When true, the spare-pool top-up job requests purchase orders for shortfalls central stock cannot cover.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_unseen_days'],
    name: 'x_daas_ham.reconciliation.unseen_days',
    type: 'integer',
    value: 7,
    description: 'Days without a Seen signal before a deployed asset is reported as unseen.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_oem_cisco'],
    name: 'x_daas_ham.oem.cisco.enabled',
    type: 'boolean',
    value: false,
    description: 'Call the Cisco Support APIs (EoX, coverage, RMA status). Attach an OAuth profile to the "NaaS Cisco Support" REST message first.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_oem_meraki'],
    name: 'x_daas_ham.oem.meraki.enabled',
    type: 'boolean',
    value: false,
    description: 'Call the Meraki Dashboard API for EoX data.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_oem_fortinet'],
    name: 'x_daas_ham.oem.fortinet.enabled',
    type: 'boolean',
    value: false,
    description: 'Call the FortiCloud Asset Management API for coverage. Attach an OAuth profile to "NaaS FortiCare" first.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_oem_mist'],
    name: 'x_daas_ham.oem.mist.enabled',
    type: 'boolean',
    value: false,
    description: 'Call the HPE Mist API for lifecycle and warranty data.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_meraki_orgs'],
    name: 'x_daas_ham.meraki.org_ids',
    type: 'string',
    value: '',
    description: 'Comma-separated Meraki organisation ids searched for devices.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_mist_orgs'],
    name: 'x_daas_ham.mist.org_ids',
    type: 'string',
    value: '',
    description: 'Comma-separated Mist organisation ids searched for devices.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_meraki_key'],
    name: 'x_daas_ham.meraki.api_key',
    type: 'password2',
    value: '',
    description: 'Meraki Dashboard API key.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_mist_token'],
    name: 'x_daas_ham.mist.api_token',
    type: 'password2',
    value: '',
    description: 'HPE Mist API token.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_coverage_refresh'],
    name: 'x_daas_ham.oem.coverage_refresh_days',
    type: 'integer',
    value: 7,
    description: "Days before an asset's OEM coverage is checked again.",
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_return_grace'],
    name: 'x_daas_ham.returns.grace_days',
    type: 'integer',
    value: 14,
    description: 'Days after the due date before unreturned equipment is declared missing and charged as lost.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_temporary_lead'],
    name: 'x_daas_ham.returns.temporary_lead_days',
    type: 'integer',
    value: 7,
    description: 'Days before a temporary deployment ends that its return order is raised.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_refresh_horizon'],
    name: 'x_daas_ham.refresh.horizon_days',
    type: 'integer',
    value: 90,
    description: 'Assets whose refresh is due within this many days get refresh orders.',
    roles: { read: [admin], write: [admin] },
})
