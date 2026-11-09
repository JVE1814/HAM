import '@servicenow/sdk/global'
import { Property, Record, RestMessage, ScriptAction, UiAction } from '@servicenow/sdk/core'
import { retryTrackingUpdate, uiCreateReturnLabel, uiMarkLabelVoided } from '../../server/entry/shipping'
import { admin, assetManager, inventoryTech, noc } from '../security/roles.now'
import { SHIPMENT_DIRECTION, SHIPMENT_STATUS } from '../../server/domain/vocabulary'

/*
 * Shipping aggregator (P3.26, D73). The message targets ShipEngine's label API; point the endpoint at
 * another aggregator with the same request shape if needed. Tracking webhooks are registered at
 * /api/x_daas_ham/naas/shipping/tracking with the custom header
 * X-NaaS-Webhook-Token: <x_daas_ham.shipping.webhook_token> (ShipEngine `headers: [{ key, value }]`,
 * EasyPost `custom_headers: [{ name, value }]`); ?token=<...> in the URL is still accepted as a
 * fallback (see rest.now.ts).
 */

RestMessage({
    $id: Now.ID['rm_shipping'],
    name: 'NaaS Shipping aggregator',
    endpoint: 'https://api.shipengine.com/v1',
    description: 'Buys carrier labels (one call: shipment + label + tracking number).',
    headers: [
        { $id: Now.ID['rm_shipping_accept'], name: 'Accept', value: 'application/json' },
        { $id: Now.ID['rm_shipping_ct'], name: 'Content-Type', value: 'application/json' },
    ],
    functions: [
        {
            name: 'create_label',
            httpMethod: 'POST',
            endpoint: 'https://api.shipengine.com/v1/labels',
            headers: [{ $id: Now.ID['rm_shipping_key_header'], name: 'API-Key', value: '${api_key}' }],
            variables: [{ $id: Now.ID['rm_shipping_key'], name: 'api_key' }],
        },
    ],
})

UiAction({
    $id: Now.ID['ua_return_label'],
    name: 'Create return label',
    table: 'x_daas_ham_return_order',
    actionName: 'x_daas_ham_return_label',
    hint: 'Buy a prepaid label from the Site back to the depot for the awaited equipment.',
    condition: "current.method == 'ship_back' && current.active == true && gs.getProperty('x_daas_ham.shipping.enabled') == 'true'",
    roles: [assetManager, inventoryTech, noc],
    form: { showButton: true },
    showUpdate: true,
    script: uiCreateReturnLabel,
})

// No aggregator call: the person voids the label with the carrier first, as Create return label's refusal says. On an
// outbound label it only closes it and clears it from its Order: the units stay shipped and nothing is bought.
UiAction({
    $id: Now.ID['ua_shipment_mark_voided'],
    name: 'Mark label voided',
    table: 'x_daas_ham_shipment',
    actionName: 'x_daas_ham_mark_label_voided',
    hint: 'Once voided with the carrier: close this label (a return can get a new one; its Order stops naming it).',
    // On either direction, in the statuses domain/shipping labelVoidable allows (built-metadata.test.ts holds the built
    // condition to it).
    condition:
        `(current.direction == '${SHIPMENT_DIRECTION.return}' || current.direction == '${SHIPMENT_DIRECTION.to_site}') && (current.status == '${SHIPMENT_STATUS.label_created}' || current.status == '${SHIPMENT_STATUS.exception}')`,
    roles: [assetManager, inventoryTech, noc],
    form: { showButton: true, style: 'destructive' },
    showUpdate: true,
    script: uiMarkLabelVoided,
})

// A tracking update whose Shipment lock stayed held is applied in the background, not resent by the aggregator.
export const shipmentTrackEvent = Record({
    $id: Now.ID['event_shipment_track'],
    table: 'sysevent_register',
    data: {
        suffix: 'shipment.track',
        event_name: 'x_daas_ham.shipment.track',
        table: 'x_daas_ham_shipment',
        description: "A Shipment's lock held off a tracking update; parm1 = update (JSON), parm2 = times queued again.",
        fired_by: 'entry/shipping.ts postTrackingUpdate, retryTrackingUpdate',
        priority: 100,
    },
})

ScriptAction({
    $id: Now.ID['sa_shipment_track'],
    name: 'NaaS - apply held-off tracking update',
    eventName: 'x_daas_ham.shipment.track',
    active: true,
    script: retryTrackingUpdate,
    description: "Applies a tracking update under its Shipment's lock, again a minute later while the lock is held.",
})

Property({
    $id: Now.ID['prop_shipping_enabled'],
    name: 'x_daas_ham.shipping.enabled',
    type: 'boolean',
    value: false,
    description: 'Buy labels through the shipping aggregator when an order ships without a tracking number.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_shipping_api_key'],
    name: 'x_daas_ham.shipping.api_key',
    type: 'password2',
    value: '',
    description: 'Shipping aggregator API key.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_shipping_webhook_token'],
    name: 'x_daas_ham.shipping.webhook_token',
    type: 'password2',
    value: '',
    description: 'Shared secret the tracking webhook sends in the X-NaaS-Webhook-Token header, or as ?token= (webhooks are refused while it is empty).',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_shipping_carrier_id'],
    name: 'x_daas_ham.shipping.carrier_id',
    type: 'string',
    value: '',
    description: 'ShipEngine carrier account id (se-...) billed for labels (labels are refused while it is empty).',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_shipping_service_code'],
    name: 'x_daas_ham.shipping.service_code',
    type: 'string',
    value: 'ups_standard',
    description: 'Aggregator service code used for labels (service level of the carrier account in x_daas_ham.shipping.carrier_id).',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_shipping_package_kg'],
    name: 'x_daas_ham.shipping.package_kg',
    type: 'integer',
    value: 5,
    description: 'Declared weight (kg) of each package; one package per asset.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_shipping_sender_name'],
    name: 'x_daas_ham.shipping.sender_name',
    type: 'string',
    value: '',
    description: 'Company name printed as the depot sender / return recipient.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_shipping_sender_phone'],
    name: 'x_daas_ham.shipping.sender_phone',
    type: 'string',
    value: '',
    description: "Depot phone number for labels when the depot's location has none (carriers require the sender's phone).",
    roles: { read: [admin], write: [admin] },
})
