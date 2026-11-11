import '@servicenow/sdk/global'
import { RestMessage } from '@servicenow/sdk/core'
import { PROPERTY } from '../../server/domain/properties'
import { REST_MESSAGE } from '../../server/domain/rest-message-names'

/*
 * Outbound REST messages for OEM data (ADR 0008). A message without an OAuth 2.0 profile gets its secrets at call time
 * (platform/rest-messages). The profiles are instance configuration: client credentials via id.cisco.com for Cisco
 * Support, and a FortiCloud IAM API user with client_id "assetmanagement" for FortiCare.
 * Meraki and Mist have regional clouds: their functions call the host a property names (${meraki_host},
 * ${mist_host}), and the message endpoint is the default host.
 */

const CISCO_SUPPORT = 'https://apix.cisco.com'
const MERAKI_API = '/api/v1'
const FORTICARE = 'https://support.fortinet.com/ES/api/registration/v3'
const MIST_API = '/api/v1'

RestMessage({
    $id: Now.ID['rm_cisco_support'],
    name: REST_MESSAGE.ciscoSupport.name,
    endpoint: CISCO_SUPPORT,
    description: 'Cisco Support APIs: EoX v5, Serial Number to Information v2, Service Order Return (requires SNTC/PSS).',
    authenticationType: 'oauth2',
    headers: [{ $id: Now.ID['rm_cisco_accept'], name: 'Accept', value: 'application/json' }],
    functions: [
        {
            name: REST_MESSAGE.ciscoSupport.fn.eoxByPid,
            httpMethod: 'GET',
            endpoint: `${CISCO_SUPPORT}/supporttools/eox/rest/5/EOXByProductID/1/\${pids}?responseencoding=json`,
            variables: [{ $id: Now.ID['rm_cisco_eox_pids'], name: 'pids' }],
        },
        {
            name: REST_MESSAGE.ciscoSupport.fn.coverageBySerial,
            httpMethod: 'GET',
            endpoint: `${CISCO_SUPPORT}/sn2info/v2/coverage/summary/serial_numbers/\${serials}`,
            variables: [{ $id: Now.ID['rm_cisco_cov_serials'], name: 'serials' }],
        },
        {
            name: REST_MESSAGE.ciscoSupport.fn.rmaStatus,
            httpMethod: 'GET',
            endpoint: `${CISCO_SUPPORT}/return/v1.0/returns/rma_numbers/\${rma}`,
            variables: [{ $id: Now.ID['rm_cisco_rma'], name: 'rma' }],
        },
    ],
})

RestMessage({
    $id: Now.ID['rm_meraki'],
    name: REST_MESSAGE.meraki.name,
    endpoint: `https://${PROPERTY.merakiApiHost.default}${MERAKI_API}`,
    description: 'Meraki Dashboard API v1: organisation inventory with EoX fields.',
    headers: [{ $id: Now.ID['rm_meraki_accept'], name: 'Accept', value: 'application/json' }],
    functions: [
        {
            name: REST_MESSAGE.meraki.fn.inventoryByModel,
            httpMethod: 'GET',
            endpoint: `https://\${meraki_host}${MERAKI_API}/organizations/\${org_id}/inventory/devices?models[]=\${model}`,
            headers: [{ $id: Now.ID['rm_meraki_auth'], name: 'Authorization', value: 'Bearer ${api_key}' }],
            variables: [
                { $id: Now.ID['rm_meraki_host'], name: 'meraki_host' },
                { $id: Now.ID['rm_meraki_org'], name: 'org_id' },
                { $id: Now.ID['rm_meraki_model'], name: 'model' },
                { $id: Now.ID['rm_meraki_key'], name: 'api_key' },
            ],
        },
        {
            name: REST_MESSAGE.meraki.fn.claimInventory,
            httpMethod: 'POST',
            endpoint: `https://\${meraki_host}${MERAKI_API}/organizations/\${org_id}/inventory/claim`,
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
    name: REST_MESSAGE.fortiCare.name,
    endpoint: FORTICARE,
    description: 'FortiCloud Asset Management API v3: registered products and entitlements by serial.',
    authenticationType: 'oauth2',
    headers: [
        { $id: Now.ID['rm_forti_accept'], name: 'Accept', value: 'application/json' },
        { $id: Now.ID['rm_forti_ct'], name: 'Content-Type', value: 'application/json' },
    ],
    functions: [
        {
            name: REST_MESSAGE.fortiCare.fn.productsList,
            httpMethod: 'POST',
            endpoint: `${FORTICARE}/products/list`,
            content: '{ "serialNumber": "${serial}" }',
            variables: [{ $id: Now.ID['rm_forti_serial'], name: 'serial' }],
        },
        {
            name: REST_MESSAGE.fortiCare.fn.registerProducts,
            httpMethod: 'POST',
            endpoint: `${FORTICARE}/products/register`,
        },
    ],
})

RestMessage({
    $id: Now.ID['rm_mist'],
    name: REST_MESSAGE.mist.name,
    endpoint: `https://${PROPERTY.mistApiHost.default}${MIST_API}`,
    description: 'HPE Mist API: JSI inventory with lifecycle and warranty fields.',
    headers: [{ $id: Now.ID['rm_mist_accept'], name: 'Accept', value: 'application/json' }],
    functions: [
        {
            name: REST_MESSAGE.mist.fn.jsiByModel,
            httpMethod: 'GET',
            endpoint: `https://\${mist_host}${MIST_API}/orgs/\${org_id}/jsi/inventory?model=\${model}`,
            headers: [{ $id: Now.ID['rm_mist_auth_model'], name: 'Authorization', value: 'Token ${api_token}' }],
            variables: [
                { $id: Now.ID['rm_mist_host_m'], name: 'mist_host' },
                { $id: Now.ID['rm_mist_org_m'], name: 'org_id' },
                { $id: Now.ID['rm_mist_model'], name: 'model' },
                { $id: Now.ID['rm_mist_token_m'], name: 'api_token' },
            ],
        },
        {
            name: REST_MESSAGE.mist.fn.jsiBySerial,
            httpMethod: 'GET',
            endpoint: `https://\${mist_host}${MIST_API}/orgs/\${org_id}/jsi/inventory?serial=\${serial}`,
            headers: [{ $id: Now.ID['rm_mist_auth_serial'], name: 'Authorization', value: 'Token ${api_token}' }],
            variables: [
                { $id: Now.ID['rm_mist_host_s'], name: 'mist_host' },
                { $id: Now.ID['rm_mist_org_s'], name: 'org_id' },
                { $id: Now.ID['rm_mist_serial'], name: 'serial' },
                { $id: Now.ID['rm_mist_token_s'], name: 'api_token' },
            ],
        },
        {
            name: REST_MESSAGE.mist.fn.claimInventory,
            httpMethod: 'POST',
            endpoint: `https://\${mist_host}${MIST_API}/orgs/\${org_id}/inventory`,
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
 * Claim and provisioning (plan §13 OEM claim adapters). GreenLake's OAuth 2.0 profile uses the Client Credentials
 * grant with token URL https://global.api.greenlake.hpe.com/authorization/v2/oauth2/<workspaceId>/token; the API
 * client's user needs Devices and Subscription edit permission. Check Point Zero Touch logs in once per run, and the
 * claim adapter sends the returned sid as the X-chkp-sid request header until it logs out.
 */

const GREENLAKE = 'https://global.api.greenlake.hpe.com'
const FORTIZTP = 'https://fortiztp.forticloud.com/public/api/v1'
const ZERO_TOUCH = 'https://zerotouch.checkpoint.com/ZeroTouch/web_api/v2'

RestMessage({
    $id: Now.ID['rm_greenlake'],
    name: REST_MESSAGE.greenLake.name,
    endpoint: GREENLAKE,
    description: 'HPE GreenLake platform: add network devices to the workspace and assign subscriptions.',
    authenticationType: 'oauth2',
    headers: [
        { $id: Now.ID['rm_greenlake_accept'], name: 'Accept', value: 'application/json' },
        { $id: Now.ID['rm_greenlake_ct'], name: 'Content-Type', value: 'application/json' },
    ],
    functions: [
        { name: REST_MESSAGE.greenLake.fn.addDevices, httpMethod: 'POST', endpoint: `${GREENLAKE}/devices/v1/devices` },
        {
            name: REST_MESSAGE.greenLake.fn.findDevice,
            httpMethod: 'GET',
            endpoint: `${GREENLAKE}/devices/v1/devices?filter=serialNumber eq '\${serial}'`,
            variables: [{ $id: Now.ID['rm_greenlake_serial'], name: 'serial' }],
        },
        {
            name: REST_MESSAGE.greenLake.fn.assignSubscription,
            httpMethod: 'PATCH',
            endpoint: `${GREENLAKE}/devices/v1/devices?id=\${device_id}`,
            // patchDevicesV1 accepts only merge-patch JSON.
            headers: [{ $id: Now.ID['rm_greenlake_patch_ct'], name: 'Content-Type', value: 'application/merge-patch+json' }],
            variables: [{ $id: Now.ID['rm_greenlake_device'], name: 'device_id' }],
        },
    ],
})

RestMessage({
    $id: Now.ID['rm_fortiztp'],
    name: REST_MESSAGE.fortiZtp.name,
    endpoint: FORTIZTP,
    description: 'FortiZTP: provision registered FortiGates to the customer FortiManager.',
    authenticationType: 'oauth2',
    headers: [
        { $id: Now.ID['rm_fortiztp_accept'], name: 'Accept', value: 'application/json' },
        { $id: Now.ID['rm_fortiztp_ct'], name: 'Content-Type', value: 'application/json' },
    ],
    functions: [
        {
            name: REST_MESSAGE.fortiZtp.fn.provisionDevice,
            httpMethod: 'PUT',
            endpoint: `${FORTIZTP}/devices/\${serial}`,
            variables: [{ $id: Now.ID['rm_fortiztp_serial'], name: 'serial' }],
        },
    ],
})

RestMessage({
    $id: Now.ID['rm_checkpoint_zt'],
    name: REST_MESSAGE.checkPoint.name,
    endpoint: ZERO_TOUCH,
    description: 'Check Point Zero Touch web API v2: log in, claim Small Office (Quantum Spark) gateways with a customer template, log out.',
    headers: [
        { $id: Now.ID['rm_checkpoint_accept'], name: 'Accept', value: 'application/json' },
        { $id: Now.ID['rm_checkpoint_ct'], name: 'Content-Type', value: 'application/json' },
    ],
    functions: [
        {
            name: REST_MESSAGE.checkPoint.fn.login,
            httpMethod: 'POST',
            endpoint: `${ZERO_TOUCH}/login`,
            content: '{"api-client-id":"${api_client_id}","api-key":"${api_key}"}',
            variables: [
                { $id: Now.ID['rm_checkpoint_login_client_id'], name: 'api_client_id' },
                { $id: Now.ID['rm_checkpoint_login_key'], name: 'api_key' },
            ],
        },
        { name: REST_MESSAGE.checkPoint.fn.claimGateway, httpMethod: 'POST', endpoint: `${ZERO_TOUCH}/claim-gateway` },
        { name: REST_MESSAGE.checkPoint.fn.logout, httpMethod: 'POST', endpoint: `${ZERO_TOUCH}/logout`, content: '{}' },
    ],
})
