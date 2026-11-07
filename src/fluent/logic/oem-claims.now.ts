import '@servicenow/sdk/global'
import { Property, ScheduledScript } from '@servicenow/sdk/core'
import { runOemClaims } from '../../server/entry/oem-claims'
import { admin } from '../security/roles.now'

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
    name: 'x_daas_ham.oem.claim.max_calls',
    type: 'integer',
    value: 8,
    description: 'API calls per vendor per 5-minute run (Meraki allows 10 claim calls per 5 minutes).',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_claim_meraki'],
    name: 'x_daas_ham.oem.claim.meraki.enabled',
    type: 'boolean',
    value: false,
    description: 'Claim Meraki devices into the customer organization during staging.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_claim_mist'],
    name: 'x_daas_ham.oem.claim.mist.enabled',
    type: 'boolean',
    value: false,
    description: 'Claim Mist devices (by claim code) into the customer org during staging.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_claim_aruba'],
    name: 'x_daas_ham.oem.claim.aruba.enabled',
    type: 'boolean',
    value: false,
    description: 'Add Aruba devices to the GreenLake workspace and assign the customer subscription during staging.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_claim_fortinet'],
    name: 'x_daas_ham.oem.claim.fortinet.enabled',
    type: 'boolean',
    value: false,
    description: 'Register FortiGates in FortiCloud and provision them through FortiZTP during staging.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_claim_checkpoint'],
    name: 'x_daas_ham.oem.claim.checkpoint.enabled',
    type: 'boolean',
    value: false,
    description: 'Claim Check Point gateways in Zero Touch with their customer template during staging.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_checkpoint_client_id'],
    name: 'x_daas_ham.checkpoint.api_client_id',
    type: 'password2',
    value: '',
    description: 'Check Point Zero Touch API Client ID.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_checkpoint_key'],
    name: 'x_daas_ham.checkpoint.api_key',
    type: 'password2',
    value: '',
    description: 'Check Point Zero Touch API Key (expires after 1-180 days; regenerate in Zero Touch portal > Manage API Key).',
    roles: { read: [admin], write: [admin] },
})
