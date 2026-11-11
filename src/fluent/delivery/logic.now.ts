import '@servicenow/sdk/global'
import { BusinessRule, Property, Record, RestMessage, ScriptAction, UiAction } from '@servicenow/sdk/core'
import { explainWorkWindowRefusal, uiConfirmInstalled, uiShipOrder } from '../../server/entry/delivery'
import { completeInstallOfWork } from '../../server/platform/delivery'
import { INSTALL_MODE, ORDER_STAGE, RETURN_METHOD, SHIPMENT_DIRECTION, SHIPMENT_STATUS, STAGE_FIELDS, TASK_STATE } from '../../server/domain/vocabulary'
import { PLATFORM_ROLE } from '../../server/domain/roles'
import { SHIPPING_MESSAGE } from '../../server/domain/shipping'
import { retryTrackingUpdate, uiCreateReturnLabel, uiMarkLabelVoided } from '../../server/entry/shipping'
import { PROPERTY } from '../../server/domain/properties'
import { EVENT } from '../../server/domain/events'
import { ENTRY_MODULES } from '../shared/server-modules.now'
import { admin, assetManager, customerAdmin, fieldTech, returnWorkers, siteContact, stockroomWorkers } from '../shared/roles.now'

/* The Order form's Ship and Confirm installed buttons. */

UiAction({
    $id: Now.ID['ua_order_ship'],
    name: 'Ship',
    table: 'x_daas_ham_order',
    actionName: 'x_daas_ham_ship_order',
    hint: 'Ship all staged assets to the site and open the on-site work (change + work order).',
    condition: `current.stage == '${ORDER_STAGE.delivering}'`,
    roles: stockroomWorkers,
    form: { showButton: true, style: 'primary' },
    showUpdate: true,
    script: uiShipOrder,
})

UiAction({
    $id: Now.ID['ua_order_confirm_installed'],
    name: 'Confirm installed',
    table: 'x_daas_ham_order',
    actionName: 'x_daas_ham_confirm_installed',
    hint: 'Record that the shipped equipment is installed (self-install, or when the work order is closed elsewhere).',
    // Customer contacts confirm only a self-install, staff any install: one installing, or one a line filled again
    // holds back while units already shipped wait at the Site (platform/delivery confirmInstall checks
    // domain/install-confirmation on the server). The condition column holds at most 254 characters, hence the terse script: staff are told apart
    // by the platform's asset role, which asset managers and field techs contain and Customer roles do not, and the
    // stage of an Order held back goes unchecked, as only one preparing, delivering or installing has units shipped.
    condition:
        `(current.install_mode=='${INSTALL_MODE.self_install}'||gs.hasRole('${PLATFORM_ROLE.asset}'))&&(current.stage=='${ORDER_STAGE.installing}'||(function(a){a.addQuery('substatus','${STAGE_FIELDS.shipped.substatus}');a.query('x_daas_ham_order_line.order',current.sys_id);return a.next()})(new GlideRecord('alm_hardware')))`,
    roles: [assetManager, fieldTech, customerAdmin, siteContact],
    form: { showButton: true },
    showUpdate: true,
    script: uiConfirmInstalled,
})

/*
 * Field work (ADR 0004). wm_order is a global table: the platform refuses current.setAbortAction from this scope on its
 * records and saves anyway. So a before rule there refuses with its Abort action when its condition (the module's
 * check) holds, and its script only says why. The platform runs a condition on every save of the table, whether or not
 * the rule's filter matches, so each condition starts with its change test: the module loads only when that holds. The
 * condition field holds at most 254 characters.
 *
 * wm_order holds the Provider IT's own field work too. A work order of a NaaS Order is one initiated from it (the
 * platform's Initiated from, a reference to any task, ADR 0018), so each rule on it tests the class of that task right
 * after its change test.
 */

const NAAS_ORDER_WORK = "current.initiated_from.sys_class_name == 'x_daas_ham_order'"

BusinessRule({
    $id: Now.ID['br_work_order_window'],
    name: 'NaaS - work inside the change window',
    table: 'wm_order',
    when: 'before',
    action: ['insert', 'update'],
    order: 100,
    condition:
        `(current.expected_start.changes() || current.estimated_end.changes()) && ${NAAS_ORDER_WORK} && require('${ENTRY_MODULES}/delivery.ts').refusesWorkWindow(current)`,
    abortAction: true,
    script: explainWorkWindowRefusal,
})

BusinessRule({
    $id: Now.ID['br_work_order_closed'],
    name: 'NaaS - install done on work order close',
    table: 'wm_order',
    when: 'after',
    action: ['update'],
    order: 200,
    condition: `current.state.changes() && current.state == ${TASK_STATE.closedComplete} && ${NAAS_ORDER_WORK}`,
    script: completeInstallOfWork,
})

/*
 * Shipping aggregator (plan §13 Shipping aggregator, Q73). The message targets ShipEngine's label API; point the endpoint at
 * another aggregator with the same request shape if needed. Tracking webhooks are registered at
 * /api/x_daas_ham/naas/shipping/tracking with the custom header
 * X-NaaS-Webhook-Token: <x_daas_ham.shipping.webhook_token> (ShipEngine `headers: [{ key, value }]`,
 * EasyPost `custom_headers: [{ name, value }]`); ?token=<...> in the URL is still accepted as a
 * fallback (see shared/rest-api.now.ts).
 */

RestMessage({
    $id: Now.ID['rm_shipping'],
    name: SHIPPING_MESSAGE.name,
    endpoint: 'https://api.shipengine.com/v1',
    description: 'Buys carrier labels (one call: shipment + label + tracking number).',
    headers: [
        { $id: Now.ID['rm_shipping_accept'], name: 'Accept', value: 'application/json' },
        { $id: Now.ID['rm_shipping_ct'], name: 'Content-Type', value: 'application/json' },
    ],
    functions: [
        {
            name: SHIPPING_MESSAGE.fn.createLabel,
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
    condition: `current.method == '${RETURN_METHOD.ship_back}' && current.active == true && gs.getProperty('${PROPERTY.shippingEnabled.name}') == 'true'`,
    roles: returnWorkers,
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
    roles: returnWorkers,
    form: { showButton: true, style: 'destructive' },
    showUpdate: true,
    script: uiMarkLabelVoided,
})

// A tracking update whose Shipment lock stayed held is applied in the background, not resent by the aggregator.
Record({
    $id: Now.ID['event_shipment_track'],
    table: 'sysevent_register',
    data: {
        suffix: 'shipment.track',
        event_name: EVENT.trackShipment,
        table: 'x_daas_ham_shipment',
        description: "A Shipment's lock held off a tracking update; parm1 = update (JSON), parm2 = times queued again.",
        priority: 100,
    },
})

ScriptAction({
    $id: Now.ID['sa_shipment_track'],
    name: 'NaaS - apply held-off tracking update',
    eventName: EVENT.trackShipment,
    active: true,
    script: retryTrackingUpdate,
    description: "Applies a tracking update under its Shipment's lock, again a minute later while the lock is held.",
})

Property({
    $id: Now.ID['prop_shipping_enabled'],
    name: PROPERTY.shippingEnabled.name,
    type: 'boolean',
    value: PROPERTY.shippingEnabled.default,
    description: 'Buy labels through the shipping aggregator when an order ships without a tracking number.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_shipping_api_key'],
    name: PROPERTY.shippingApiKey.name,
    type: 'password2',
    value: PROPERTY.shippingApiKey.default,
    description: 'Shipping aggregator API key.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_shipping_webhook_token'],
    name: PROPERTY.shippingWebhookToken.name,
    type: 'password2',
    value: PROPERTY.shippingWebhookToken.default,
    description: 'Shared secret the tracking webhook sends in the X-NaaS-Webhook-Token header, or as ?token= (webhooks are refused while it is empty).',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_shipping_carrier_id'],
    name: PROPERTY.shippingCarrierId.name,
    type: 'string',
    value: PROPERTY.shippingCarrierId.default,
    description: 'ShipEngine carrier account id (se-...) billed for labels (labels are refused while it is empty).',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_shipping_service_code'],
    name: PROPERTY.shippingServiceCode.name,
    type: 'string',
    value: PROPERTY.shippingServiceCode.default,
    description: `Aggregator service code used for labels (service level of the carrier account in ${PROPERTY.shippingCarrierId.name}).`,
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_shipping_package_kg'],
    name: PROPERTY.shippingPackageKg.name,
    type: 'integer',
    value: PROPERTY.shippingPackageKg.default,
    description: 'Declared weight (kg) of each package; one package per asset.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_shipping_sender_name'],
    name: PROPERTY.shippingSenderName.name,
    type: 'string',
    value: PROPERTY.shippingSenderName.default,
    description: 'Company name printed as the depot sender / return recipient.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_shipping_sender_phone'],
    name: PROPERTY.shippingSenderPhone.name,
    type: 'string',
    value: PROPERTY.shippingSenderPhone.default,
    description: "Depot phone number for labels when the depot's location has none (carriers require the sender's phone).",
    roles: { read: [admin], write: [admin] },
})
