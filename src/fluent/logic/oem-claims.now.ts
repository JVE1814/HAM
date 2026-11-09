import '@servicenow/sdk/global'
import { Property, ScheduledScript } from '@servicenow/sdk/core'
import { runOemClaims } from '../../server/entry/oem-claims'
import { admin } from '../security/roles.now'
import { PROPERTY } from '../../server/platform/properties'

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
