import '@servicenow/sdk/global'
import { RestMessage } from '@servicenow/sdk/core'

/*
 * Outbound REST messages for OEM data (ADR 0008). Credentials are instance configuration:
 * - Cisco Support APIs and FortiCare: attach an OAuth 2.0 profile to the message (client credentials
 *   via id.cisco.com; FortiCloud IAM API user with client_id "assetmanagement").
 * - Meraki and Mist: API key / token in the password2 properties x_daas_ham.meraki.api_key and
 *   x_daas_ham.mist.api_token (substituted into the header at call time).
 * Function names are the ones domain/oem/adapters.ts calls.
 */

RestMessage({
    $id: Now.ID['rm_cisco_support'],
    name: 'NaaS Cisco Support',
    endpoint: 'https://apix.cisco.com',
    description: 'Cisco Support APIs: EoX v5, Serial Number to Information v2, Service Order Return (requires SNTC/PSS).',
    authenticationType: 'oauth2',
    headers: [{ $id: Now.ID['rm_cisco_accept'], name: 'Accept', value: 'application/json' }],
    functions: [
        {
            name: 'eox_by_pid',
            httpMethod: 'GET',
            endpoint: 'https://apix.cisco.com/supporttools/eox/rest/5/EOXByProductID/1/${pids}?responseencoding=json',
            variables: [{ $id: Now.ID['rm_cisco_eox_pids'], name: 'pids' }],
        },
        {
            name: 'coverage_by_serial',
            httpMethod: 'GET',
            endpoint: 'https://apix.cisco.com/sn2info/v2/coverage/summary/serial_numbers/${serials}',
            variables: [{ $id: Now.ID['rm_cisco_cov_serials'], name: 'serials' }],
        },
        {
            name: 'rma_status',
            httpMethod: 'GET',
            endpoint: 'https://apix.cisco.com/return/v1.0/returns/rma_numbers/${rma}',
            variables: [{ $id: Now.ID['rm_cisco_rma'], name: 'rma' }],
        },
    ],
})

RestMessage({
    $id: Now.ID['rm_meraki'],
    name: 'NaaS Meraki Dashboard',
    endpoint: 'https://api.meraki.com/api/v1',
    description: 'Meraki Dashboard API v1: organisation inventory with EoX fields.',
    headers: [{ $id: Now.ID['rm_meraki_accept'], name: 'Accept', value: 'application/json' }],
    functions: [
        {
            name: 'inventory_by_model',
            httpMethod: 'GET',
            endpoint: 'https://api.meraki.com/api/v1/organizations/${org_id}/inventory/devices?models[]=${model}',
            headers: [{ $id: Now.ID['rm_meraki_auth'], name: 'Authorization', value: 'Bearer ${api_key}' }],
            variables: [
                { $id: Now.ID['rm_meraki_org'], name: 'org_id' },
                { $id: Now.ID['rm_meraki_model'], name: 'model' },
                { $id: Now.ID['rm_meraki_key'], name: 'api_key' },
            ],
        },
    ],
})

RestMessage({
    $id: Now.ID['rm_forticare'],
    name: 'NaaS FortiCare',
    endpoint: 'https://support.fortinet.com/ES/api/registration/v3',
    description: 'FortiCloud Asset Management API v3: registered products and entitlements by serial.',
    authenticationType: 'oauth2',
    headers: [
        { $id: Now.ID['rm_forti_accept'], name: 'Accept', value: 'application/json' },
        { $id: Now.ID['rm_forti_ct'], name: 'Content-Type', value: 'application/json' },
    ],
    functions: [
        {
            name: 'products_list',
            httpMethod: 'POST',
            endpoint: 'https://support.fortinet.com/ES/api/registration/v3/products/list',
            content: '{ "serialNumber": "${serial}" }',
            variables: [{ $id: Now.ID['rm_forti_serial'], name: 'serial' }],
        },
    ],
})

RestMessage({
    $id: Now.ID['rm_mist'],
    name: 'NaaS HPE Mist',
    endpoint: 'https://api.mist.com/api/v1',
    description: 'HPE Mist API: JSI inventory with lifecycle and warranty fields.',
    headers: [{ $id: Now.ID['rm_mist_accept'], name: 'Accept', value: 'application/json' }],
    functions: [
        {
            name: 'jsi_by_model',
            httpMethod: 'GET',
            endpoint: 'https://api.mist.com/api/v1/orgs/${org_id}/jsi/inventory?model=${model}',
            headers: [{ $id: Now.ID['rm_mist_auth_model'], name: 'Authorization', value: 'Token ${api_token}' }],
            variables: [
                { $id: Now.ID['rm_mist_org_m'], name: 'org_id' },
                { $id: Now.ID['rm_mist_model'], name: 'model' },
                { $id: Now.ID['rm_mist_token_m'], name: 'api_token' },
            ],
        },
        {
            name: 'jsi_by_serial',
            httpMethod: 'GET',
            endpoint: 'https://api.mist.com/api/v1/orgs/${org_id}/jsi/inventory?serial=${serial}',
            headers: [{ $id: Now.ID['rm_mist_auth_serial'], name: 'Authorization', value: 'Token ${api_token}' }],
            variables: [
                { $id: Now.ID['rm_mist_org_s'], name: 'org_id' },
                { $id: Now.ID['rm_mist_serial'], name: 'serial' },
                { $id: Now.ID['rm_mist_token_s'], name: 'api_token' },
            ],
        },
    ],
})
