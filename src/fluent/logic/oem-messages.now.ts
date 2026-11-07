import '@servicenow/sdk/global'
import { RestMessage } from '@servicenow/sdk/core'

/*
 * Outbound REST messages for OEM data (ADR 0008). Credentials are instance configuration:
 * - Cisco Support APIs and FortiCare: attach an OAuth 2.0 profile to the message (client credentials
 *   via id.cisco.com; FortiCloud IAM API user with client_id "assetmanagement").
 * - Meraki and Mist: API key / token in the password2 properties x_daas_ham.meraki.api_key and
 *   x_daas_ham.mist.api_token (substituted into the header at call time).
 * - Meraki and Mist API hosts: ${meraki_host} / ${mist_host} in each function endpoint, from the string
 *   properties x_daas_ham.meraki.api_host and x_daas_ham.mist.api_host (regional clouds); the message
 *   endpoint is the documented default.
 * Function names are the ones domain/oem/adapters.ts and domain/oem/claims.ts call.
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
            endpoint: 'https://${meraki_host}/api/v1/organizations/${org_id}/inventory/devices?models[]=${model}',
            headers: [{ $id: Now.ID['rm_meraki_auth'], name: 'Authorization', value: 'Bearer ${api_key}' }],
            variables: [
                { $id: Now.ID['rm_meraki_host'], name: 'meraki_host' },
                { $id: Now.ID['rm_meraki_org'], name: 'org_id' },
                { $id: Now.ID['rm_meraki_model'], name: 'model' },
                { $id: Now.ID['rm_meraki_key'], name: 'api_key' },
            ],
        },
        {
            name: 'claim_inventory',
            httpMethod: 'POST',
            endpoint: 'https://${meraki_host}/api/v1/organizations/${org_id}/inventory/claim',
            headers: [
                { $id: Now.ID['rm_meraki_claim_auth'], name: 'Authorization', value: 'Bearer ${api_key}' },
                { $id: Now.ID['rm_meraki_claim_ct'], name: 'Content-Type', value: 'application/json' },
            ],
            variables: [
                { $id: Now.ID['rm_meraki_claim_host'], name: 'meraki_host' },
                { $id: Now.ID['rm_meraki_claim_org'], name: 'org_id' },
                { $id: Now.ID['rm_meraki_claim_key'], name: 'api_key' },
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
        {
            name: 'register_products',
            httpMethod: 'POST',
            endpoint: 'https://support.fortinet.com/ES/api/registration/v3/products/register',
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
            endpoint: 'https://${mist_host}/api/v1/orgs/${org_id}/jsi/inventory?model=${model}',
            headers: [{ $id: Now.ID['rm_mist_auth_model'], name: 'Authorization', value: 'Token ${api_token}' }],
            variables: [
                { $id: Now.ID['rm_mist_host_m'], name: 'mist_host' },
                { $id: Now.ID['rm_mist_org_m'], name: 'org_id' },
                { $id: Now.ID['rm_mist_model'], name: 'model' },
                { $id: Now.ID['rm_mist_token_m'], name: 'api_token' },
            ],
        },
        {
            name: 'jsi_by_serial',
            httpMethod: 'GET',
            endpoint: 'https://${mist_host}/api/v1/orgs/${org_id}/jsi/inventory?serial=${serial}',
            headers: [{ $id: Now.ID['rm_mist_auth_serial'], name: 'Authorization', value: 'Token ${api_token}' }],
            variables: [
                { $id: Now.ID['rm_mist_host_s'], name: 'mist_host' },
                { $id: Now.ID['rm_mist_org_s'], name: 'org_id' },
                { $id: Now.ID['rm_mist_serial'], name: 'serial' },
                { $id: Now.ID['rm_mist_token_s'], name: 'api_token' },
            ],
        },
        {
            name: 'claim_inventory',
            httpMethod: 'POST',
            endpoint: 'https://${mist_host}/api/v1/orgs/${org_id}/inventory',
            headers: [
                { $id: Now.ID['rm_mist_claim_auth'], name: 'Authorization', value: 'Token ${api_token}' },
                { $id: Now.ID['rm_mist_claim_ct'], name: 'Content-Type', value: 'application/json' },
            ],
            variables: [
                { $id: Now.ID['rm_mist_host_claim'], name: 'mist_host' },
                { $id: Now.ID['rm_mist_claim_org'], name: 'org_id' },
                { $id: Now.ID['rm_mist_claim_token'], name: 'api_token' },
            ],
        },
    ],
})

/*
 * Claim and provisioning (P3.27). GreenLake and FortiZTP authenticate with an OAuth 2.0 profile
 * attached on the instance:
 * - GreenLake: Client Credentials grant, token URL
 *   https://global.api.greenlake.hpe.com/authorization/v2/oauth2/<workspaceId>/token; the API client's
 *   user needs Devices and Subscription edit permission.
 * Check Point Zero Touch logs in per run with the password2 properties x_daas_ham.checkpoint.api_client_id
 * and x_daas_ham.checkpoint.api_key (substituted into the login body) and sends the returned sid as
 * X-chkp-sid until it logs out.
 */

RestMessage({
    $id: Now.ID['rm_greenlake'],
    name: 'NaaS HPE GreenLake',
    endpoint: 'https://global.api.greenlake.hpe.com',
    description: 'HPE GreenLake platform: add network devices to the workspace and assign subscriptions.',
    authenticationType: 'oauth2',
    headers: [
        { $id: Now.ID['rm_greenlake_accept'], name: 'Accept', value: 'application/json' },
        { $id: Now.ID['rm_greenlake_ct'], name: 'Content-Type', value: 'application/json' },
    ],
    functions: [
        { name: 'add_devices', httpMethod: 'POST', endpoint: 'https://global.api.greenlake.hpe.com/devices/v1/devices' },
        {
            name: 'find_device',
            httpMethod: 'GET',
            endpoint: "https://global.api.greenlake.hpe.com/devices/v1/devices?filter=serialNumber eq '${serial}'",
            variables: [{ $id: Now.ID['rm_greenlake_serial'], name: 'serial' }],
        },
        {
            name: 'assign_subscription',
            httpMethod: 'PATCH',
            endpoint: 'https://global.api.greenlake.hpe.com/devices/v1/devices?id=${device_id}',
            // patchDevicesV1 accepts only merge-patch JSON; this overrides the message's Content-Type.
            headers: [{ $id: Now.ID['rm_greenlake_patch_ct'], name: 'Content-Type', value: 'application/merge-patch+json' }],
            variables: [{ $id: Now.ID['rm_greenlake_device'], name: 'device_id' }],
        },
    ],
})

RestMessage({
    $id: Now.ID['rm_fortiztp'],
    name: 'NaaS FortiZTP',
    endpoint: 'https://fortiztp.forticloud.com/public/api/v1',
    description: 'FortiZTP: provision registered FortiGates to the customer FortiManager.',
    authenticationType: 'oauth2',
    headers: [
        { $id: Now.ID['rm_fortiztp_accept'], name: 'Accept', value: 'application/json' },
        { $id: Now.ID['rm_fortiztp_ct'], name: 'Content-Type', value: 'application/json' },
    ],
    functions: [
        {
            name: 'provision_device',
            httpMethod: 'PUT',
            endpoint: 'https://fortiztp.forticloud.com/public/api/v1/devices/${serial}',
            variables: [{ $id: Now.ID['rm_fortiztp_serial'], name: 'serial' }],
        },
    ],
})

RestMessage({
    $id: Now.ID['rm_checkpoint_zt'],
    name: 'NaaS Check Point Zero Touch',
    endpoint: 'https://zerotouch.checkpoint.com/ZeroTouch/web_api/v2',
    description: 'Check Point Zero Touch web API v2: log in, claim Small Office (Quantum Spark) gateways with a customer template, log out.',
    headers: [
        { $id: Now.ID['rm_checkpoint_accept'], name: 'Accept', value: 'application/json' },
        { $id: Now.ID['rm_checkpoint_ct'], name: 'Content-Type', value: 'application/json' },
    ],
    functions: [
        {
            name: 'login',
            httpMethod: 'POST',
            endpoint: 'https://zerotouch.checkpoint.com/ZeroTouch/web_api/v2/login',
            content: '{"api-client-id":"${api_client_id}","api-key":"${api_key}"}',
            variables: [
                { $id: Now.ID['rm_checkpoint_login_client_id'], name: 'api_client_id' },
                { $id: Now.ID['rm_checkpoint_login_key'], name: 'api_key' },
            ],
        },
        {
            name: 'claim_gateway',
            httpMethod: 'POST',
            endpoint: 'https://zerotouch.checkpoint.com/ZeroTouch/web_api/v2/claim-gateway',
            headers: [{ $id: Now.ID['rm_checkpoint_claim_sid_header'], name: 'X-chkp-sid', value: '${sid}' }],
            variables: [{ $id: Now.ID['rm_checkpoint_claim_sid'], name: 'sid' }],
        },
        {
            name: 'logout',
            httpMethod: 'POST',
            endpoint: 'https://zerotouch.checkpoint.com/ZeroTouch/web_api/v2/logout',
            content: '{}',
            headers: [{ $id: Now.ID['rm_checkpoint_logout_sid_header'], name: 'X-chkp-sid', value: '${sid}' }],
            variables: [{ $id: Now.ID['rm_checkpoint_logout_sid'], name: 'sid' }],
        },
    ],
})
