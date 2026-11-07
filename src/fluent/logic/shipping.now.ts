import '@servicenow/sdk/global'
import { Property, RestMessage, UiAction } from '@servicenow/sdk/core'
import { uiCreateReturnLabel } from '../../server/entry/shipping'
import { admin, assetManager, inventoryTech, noc } from '../security/roles.now'

/*
 * Shipping aggregator (P3.26, D73). The message targets ShipEngine's label API; point the endpoint at
 * another aggregator with the same request shape if needed. Tracking webhooks are registered at
 * /api/x_daas_ham/naas/shipping/tracking?token=<x_daas_ham.shipping.webhook_token> (see rest.now.ts).
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
    description: 'Shared secret the tracking webhook URL carries as ?token= (webhooks are refused while it is empty).',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_shipping_service_code'],
    name: 'x_daas_ham.shipping.service_code',
    type: 'string',
    value: 'ups_standard',
    description: 'Aggregator service code used for labels (carrier and service level).',
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
