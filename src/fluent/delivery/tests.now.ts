import '@servicenow/sdk/global'
import { Test } from '@servicenow/sdk/core'
import { SHIPMENT_DIRECTION, SHIPMENT_STATUS } from '../../server/domain/vocabulary'

/*
 * The route runs unauthenticated, so ATF's inbound REST step
 * sends it without signing in, as the aggregator does: without the X-NaaS-Webhook-Token header it is refused. The
 * delivery is then posted from a script, again without signing in, with the token in the header (a REST step cannot
 * carry the secret). The route answers as guest, so the delivery being applied shows guest reads the password2 token
 * despite its admin read role (docs/research/external-contracts.md N45). A configured token is read and used as it is; with
 * none configured (webhooks refused) the script sets a random one for the calls and clears it again however they end.
 * The Shipment's fields are read-only on forms, so its fixture inserts without security enforcement.
 */

// The vocabulary's values the fixtures below are created with, each under a name: for a value, a Test takes a
// name, but no property access (VOCABULARY.value).
const TO_SITE = SHIPMENT_DIRECTION.to_site
const LABEL_CREATED = SHIPMENT_STATUS.label_created

export const trackingWebhookTest = Test(
    {
        $id: Now.ID['atf_tracking_webhook'],
        name: 'NaaS - the tracking webhook needs its token and records a delivery once',
        description:
            'Posts a ShipEngine "DE" update to the tracking webhook without the X-NaaS-Webhook-Token header (HTTP 401, the Shipment unchanged), then posts it twice, still unauthenticated, with the token: each answers HTTP 200 delivered, the Shipment is delivered with its delivery time, and it holds one tracking event.',
        active: true,
        failOnServerError: false,
    },
    (atf) => {
        const customer = atf.server.recordInsert({
            $id: Now.ID['atf_twh_customer'],
            table: 'customer_account',
            fieldValues: { name: 'ATF Tracking Customer', customer: true },
        })
        const site = atf.server.recordInsert({
            $id: Now.ID['atf_twh_site'],
            table: 'cmn_location',
            fieldValues: { name: 'ATF Tracking Site', x_daas_ham_is_site: true, company: customer.record_id },
        })
        const shipment = atf.server.recordInsert({
            $id: Now.ID['atf_twh_shipment'],
            table: 'x_daas_ham_shipment',
            fieldValues: {
                direction: TO_SITE,
                customer: customer.record_id,
                site: site.record_id,
                carrier: 'ups',
                tracking_number: 'ATF1Z0000000001',
                status: LABEL_CREATED,
            },
            enforceSecurity: false,
        })
        atf.rest.sendRestRequest({
            $id: Now.ID['atf_twh_post_without_token'],
            path: '/api/x_daas_ham/naas/shipping/tracking',
            method: 'post',
            auth: '',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            // A ShipEngine track event (API_TRACK) for ATF1Z0000000001: delivered (DE), with one tracking event.
            body: '{"resource_type":"API_TRACK","data":{"tracking_number":"ATF1Z0000000001","status_code":"DE","status_description":"Delivered","actual_delivery_date":"2026-11-09T10:15:00Z","events":[{"occurred_at":"2026-11-09T10:15:00Z","description":"Delivered","city_locality":"Amsterdam","country_code":"NL","status_code":"DE"}]}}',
        })
        atf.rest.assertStatusCode({ $id: Now.ID['atf_twh_assert_401'], operation: 'equals', statusCode: 401 })
        // The handler's own refusal, not the platform asking the caller to sign in.
        atf.rest.assertResponsePayload({ $id: Now.ID['atf_twh_assert_bad_token'], operation: 'contains', responseBody: 'bad token' })
        atf.server.recordValidation({
            $id: Now.ID['atf_twh_validate_unchanged'],
            table: 'x_daas_ham_shipment',
            recordId: shipment.record_id,
            fieldValues: 'status=label_created^delivered_atISEMPTY',
            assert: 'record_validated',
        })
        atf.server.runServerSideScript({
            $id: Now.ID['atf_twh_deliver_twice'],
            script: `(function (outputs, steps, params, stepResult, assertEqual) {
    var NAME = 'x_daas_ham.shipping.webhook_token';
    var update = {
        data: {
            tracking_number: 'ATF1Z0000000001',
            status_code: 'DE',
            status_description: 'Delivered',
            actual_delivery_date: '2026-11-09T10:15:00Z',
            events: [{ occurred_at: '2026-11-09T10:15:00Z', description: 'Delivered', city_locality: 'Amsterdam', country_code: 'NL', status_code: 'DE' }]
        }
    };
    function post(token) {
        var rest = new sn_ws.RESTMessageV2();
        rest.setEndpoint(gs.getProperty('glide.servlet.uri') + 'api/x_daas_ham/naas/shipping/tracking');
        rest.setHttpMethod('post');
        rest.setRequestHeader('Content-Type', 'application/json');
        rest.setRequestHeader('Accept', 'application/json');
        rest.setRequestHeader('X-NaaS-Webhook-Token', token);
        rest.setRequestBody(JSON.stringify(update));
        var response = rest.execute();
        var body = null;
        try { body = JSON.parse(response.getBody()).result; } catch (e) { body = response.getBody(); }
        return { status: response.getStatusCode(), body: body };
    }
    function expectDelivered(what, reply) {
        var got = 'HTTP ' + reply.status + ' ' + JSON.stringify(reply.body);
        if (reply.status !== 200 || !reply.body || reply.body.matched !== true || reply.body.status !== 'delivered') {
            throw new Error(what + ': expected HTTP 200 matched and delivered, got ' + got);
        }
        return what + ': ' + got;
    }
    var configured = gs.getProperty(NAME, '');
    var token = configured || 'atf-' + gs.generateGUID();
    try {
        if (!configured) gs.setProperty(NAME, token);
        if (gs.getProperty(NAME, '') !== token) throw new Error('the webhook token could not be set for the test');
        var seen = [expectDelivered('The delivery', post(token)), expectDelivered('The same delivery sent again', post(token))];
        var shipment = new GlideRecord('x_daas_ham_shipment');
        if (!shipment.get('tracking_number', 'ATF1Z0000000001')) throw new Error('no Shipment ATF1Z0000000001');
        var events = new GlideRecord('x_daas_ham_shipment_event');
        events.addQuery('shipment', shipment.getUniqueValue());
        events.query();
        if (events.getRowCount() !== 1) throw new Error('The Shipment holds ' + events.getRowCount() + ' tracking events, not 1');
        stepResult.setOutputMessage(seen.join('; '));
        return true;
    } catch (e) {
        stepResult.setOutputMessage(String(e && e.message ? e.message : e));
        return false;
    } finally {
        if (!configured) gs.setProperty(NAME, '');
    }
})(outputs, steps, params, stepResult, assertEqual);`,
        })
        atf.server.recordValidation({
            $id: Now.ID['atf_twh_validate_delivered'],
            table: 'x_daas_ham_shipment',
            recordId: shipment.record_id,
            fieldValues: 'status=delivered^delivered_atISNOTEMPTY',
            assert: 'record_validated',
        })
        atf.server.recordQuery({
            $id: Now.ID['atf_twh_event_recorded'],
            table: 'x_daas_ham_shipment_event',
            fieldValues: `shipment=${shipment.record_id}^status=delivered^location=Amsterdam, NL`,
            assert: 'records_match_query',
        })
    },
)
