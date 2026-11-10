import '@servicenow/sdk/global'
import { RestApi } from '@servicenow/sdk/core'
import { postDeviceEvents } from '../../server/entry/in-service'
import { listStockrooms, lookupAsset, pickAsset, putAwayAsset, receiveAsset } from '../../server/entry/warehouse'
import { scanAudit } from '../../server/entry/assurance'
import { getRack, listRacks, listSites } from '../../server/entry/racks'
import { answerAttestation, confirmInstalled, customerOverview, reportFault, requestCustomerReturn } from '../../server/entry/customer'
import { getBillingLines, listBillingPeriods } from '../../server/entry/billing'
import { postTrackingUpdate } from '../../server/entry/shipping'
import { customerRestAcl } from '../security/rest-acls.now'

/*
 * Scripted REST API: /api/x_daas_ham/naas/... A route that sets nothing requires the snc_internal role and enforces
 * the platform's "Scripted REST External Default" ACL, which admits internal users only: the staff and integration
 * routes. The routes built for customer users too (sites, racks, customer/...) turn the snc_internal requirement off and
 * enforce that ACL or the app's customer one (security/rest-acls.now.ts); a user passes either. The shipping webhook
 * runs unauthenticated (as guest, who holds no role) and checks its token itself. Each handler checks the caller's role.
 */

/** The platform's "Scripted REST External Default" ACL (global): role snc_internal and no snc_external. */
const SCRIPTED_REST_EXTERNAL_DEFAULT = 'cf9d01d3e73003009d6247e603f6a990'

/** Staff pass the platform's default ACL, customer admins and site contacts the app's. */
const staffOrCustomer = [SCRIPTED_REST_EXTERNAL_DEFAULT, customerRestAcl]

RestApi({
    $id: Now.ID['rest_naas'],
    name: 'NaaS asset management',
    serviceId: 'naas',
    consumes: 'application/json',
    produces: 'application/json',
    shortDescription: 'Seen signals from the provider NMS and warehouse scanning operations.',
    routes: [
        {
            $id: Now.ID['rest_naas_device_events'],
            name: 'device_events',
            method: 'POST',
            path: '/device_events',
            shortDescription: 'Post a batch of device seen/down/up events (identifier = serial, provider tag or customer tag).',
            requestExample: '{ "events": [ { "identifier": "FOC1234X0AB", "event": "seen", "observed_at": "2026-11-06T10:00:00Z", "source": "nms" } ] }',
            authentication: true,
            authorization: true,
            script: postDeviceEvents,
        },
        {
            $id: Now.ID['rest_naas_lookup'],
            name: 'lookup_asset',
            method: 'GET',
            path: '/assets/{code}',
            shortDescription: 'Look up an asset by serial, provider tag or customer tag.',
            authentication: true,
            script: lookupAsset,
        },
        {
            $id: Now.ID['rest_naas_receive'],
            name: 'receive',
            method: 'POST',
            path: '/receive',
            shortDescription: 'Receive an asset into a stockroom (confirms ASN rows; pid creates assets without an ASN).',
            requestExample: '{ "code": "FOC1234X0AB", "stockroom": "<sys_id>", "pid": "C9300-48P-E" }',
            authentication: true,
            script: receiveAsset,
        },
        {
            $id: Now.ID['rest_naas_putaway'],
            name: 'put_away',
            method: 'POST',
            path: '/putaway',
            shortDescription: 'Move an in-stock asset to a stockroom.',
            authentication: true,
            script: putAwayAsset,
        },
        {
            $id: Now.ID['rest_naas_pick'],
            name: 'pick',
            method: 'POST',
            path: '/pick',
            shortDescription: 'Confirm a scanned asset is a staged asset of the given order.',
            authentication: true,
            script: pickAsset,
        },
        {
            $id: Now.ID['rest_naas_stockrooms'],
            name: 'stockrooms',
            method: 'GET',
            path: '/stockrooms',
            shortDescription: 'Stockrooms the user can receive into.',
            authentication: true,
            script: listStockrooms,
        },
        {
            $id: Now.ID['rest_naas_audit_scan'],
            name: 'audit_scan',
            method: 'POST',
            path: '/audits/{id}/scan',
            shortDescription: 'Record a scan against an open audit (id = sys_id or audit number).',
            authentication: true,
            script: scanAudit,
        },
        {
            $id: Now.ID['rest_naas_sites'],
            name: 'sites',
            method: 'GET',
            path: '/sites',
            shortDescription: 'Customer sites visible to the user.',
            authentication: true,
            internalRole: false,
            enforceAcl: staffOrCustomer,
            script: listSites,
        },
        {
            $id: Now.ID['rest_naas_racks'],
            name: 'racks',
            method: 'GET',
            path: '/racks',
            shortDescription: 'Racks in the rooms of a site (?site=sys_id).',
            authentication: true,
            internalRole: false,
            enforceAcl: staffOrCustomer,
            script: listRacks,
        },
        {
            $id: Now.ID['rest_naas_rack'],
            name: 'rack',
            method: 'GET',
            path: '/racks/{id}',
            shortDescription: 'A rack and the devices placed in it.',
            authentication: true,
            internalRole: false,
            enforceAcl: staffOrCustomer,
            script: getRack,
        },
        {
            $id: Now.ID['rest_naas_customer_overview'],
            name: 'customer_overview',
            method: 'GET',
            path: '/customer/overview',
            shortDescription: "The signed-in customer contact's equipment, orders, returns and attestations.",
            authentication: true,
            internalRole: false,
            enforceAcl: staffOrCustomer,
            script: customerOverview,
        },
        {
            $id: Now.ID['rest_naas_customer_fault'],
            name: 'customer_fault',
            method: 'POST',
            path: '/customer/faults',
            shortDescription: 'Report a faulty device (creates a CSM case).',
            authentication: true,
            internalRole: false,
            enforceAcl: staffOrCustomer,
            script: reportFault,
        },
        {
            $id: Now.ID['rest_naas_customer_installed'],
            name: 'customer_installed',
            method: 'POST',
            path: '/customer/orders/{id}/installed',
            shortDescription: 'Confirm a self-installed order is installed.',
            authentication: true,
            internalRole: false,
            enforceAcl: staffOrCustomer,
            script: confirmInstalled,
        },
        {
            $id: Now.ID['rest_naas_customer_attestation'],
            name: 'customer_attestation',
            method: 'POST',
            path: '/customer/attestations/{id}',
            shortDescription: 'Answer (and optionally submit) an attestation.',
            authentication: true,
            internalRole: false,
            enforceAcl: staffOrCustomer,
            script: answerAttestation,
        },
        {
            $id: Now.ID['rest_naas_customer_returns'],
            name: 'customer_returns',
            method: 'POST',
            path: '/customer/returns',
            shortDescription: 'Request selected devices or a whole site to be taken back.',
            authentication: true,
            internalRole: false,
            enforceAcl: staffOrCustomer,
            script: requestCustomerReturn,
        },
        {
            $id: Now.ID['rest_naas_billing_periods'],
            name: 'billing_periods',
            method: 'GET',
            path: '/billing_periods',
            shortDescription: 'Most recent billing periods with their status and totals (finance, integration).',
            authentication: true,
            script: listBillingPeriods,
        },
        {
            $id: Now.ID['rest_naas_billing_lines'],
            name: 'billing_lines',
            method: 'GET',
            path: '/billing_periods/{id}/lines',
            shortDescription: 'One page of a billing period\'s lines (?offset=0&limit=1000); final once the period is closed.',
            authentication: true,
            script: getBillingLines,
        },
        {
            $id: Now.ID['rest_naas_shipping_tracking'],
            name: 'shipping_tracking',
            method: 'POST',
            path: '/shipping/tracking',
            shortDescription: 'Tracking webhook from the shipping aggregator (ShipEngine or EasyPost shape); authenticated by the X-NaaS-Webhook-Token header (or ?token=).',
            authentication: false,
            authorization: false,
            internalRole: false,
            script: postTrackingUpdate,
        },
    ],
})
