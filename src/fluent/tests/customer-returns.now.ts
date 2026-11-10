import '@servicenow/sdk/global'
import { Test } from '@servicenow/sdk/core'
import { customerAdmin, siteContact } from '../security/roles.now'
import { DEVICE_CLASS, INSTALL_STATUS } from '../../server/domain/vocabulary'

// The vocabulary's values the fixtures below are created with, each under a name: for a value, a Test takes a
// name, but no property access (VOCABULARY.value).
const IN_USE = INSTALL_STATUS.inUse
const SWITCH = DEVICE_CLASS.switch

/*
 * ATF: the customer return requests of POST /api/x_daas_ham/naas/customer/returns (entry/customer
 * `requestCustomerReturn`, D49; suite "NaaS - P2"). ATF's inbound REST step signs in through a basic auth profile, which
 * this scope may not create, so the server-side scripts call the route's handler in the impersonated user's session,
 * with the request and response objects it reads (body.data, setStatus, setBody), as the platform does: the handler's
 * role checks and the visibility rules (ADR 0005) apply as for that user. A script cannot read an earlier step's
 * output (the platform resolves none in a script), so it finds the fixtures by their names; locations have no
 * visibility rule. Module paths are those of the SDK's own generated wrappers (scope/package/version/file, as
 * logic/server-modules), written out in each script: a step's text takes step outputs only (`${step.record_id}`), no
 * other name. src/server/built-metadata.test.ts holds each built script to the modules the build installs. Fixtures
 * setting the Fleet flag insert without security enforcement: the flag is read-only on forms.
 */

export const customerReturnRequestTest = Test(
    {
        $id: Now.ID['atf_customer_return_request'],
        name: 'NaaS - customer returns: admins only, own sites only, a decommission takes the whole site',
        description:
            "Calls the customer returns handler as a site contact (HTTP 403), then as a customer admin naming another Customer's site (HTTP 400) and their own site with decommission: true listing one of its two installed fleet assets (HTTP 201); both assets then await the return, so the site's equipment was found server-side.",
        active: true,
        // The handler logs what it refuses; the scripts and validations below check the outcome.
        failOnServerError: false,
    },
    (atf) => {
        const customerA = atf.server.recordInsert({
            $id: Now.ID['atf_crr_customer_a'],
            table: 'customer_account',
            fieldValues: { name: 'ATF Returns Customer A', customer: true },
        })
        const customerB = atf.server.recordInsert({
            $id: Now.ID['atf_crr_customer_b'],
            table: 'customer_account',
            fieldValues: { name: 'ATF Returns Customer B', customer: true },
        })
        const siteA = atf.server.recordInsert({
            $id: Now.ID['atf_crr_site_a'],
            table: 'cmn_location',
            fieldValues: { name: 'ATF Returns Site A', x_daas_ham_is_site: true, company: customerA.record_id },
        })
        atf.server.recordInsert({
            $id: Now.ID['atf_crr_site_b'],
            table: 'cmn_location',
            fieldValues: { name: 'ATF Returns Site B', x_daas_ham_is_site: true, company: customerB.record_id },
        })
        const model = atf.server.recordInsert({
            $id: Now.ID['atf_crr_model'],
            table: 'cmdb_model',
            fieldValues: { name: 'ATF Returns Switch', x_daas_ham_oem_pid: 'ATF-RET-24', x_daas_ham_device_class: SWITCH },
        })
        const agreement = atf.server.recordInsert({
            $id: Now.ID['atf_crr_agreement'],
            table: 'x_daas_ham_agreement',
            fieldValues: { customer: customerA.record_id, short_description: 'ATF returns agreement', state: 'active', currency: 'EUR' },
        })
        // Two units in service at Site A; the request below lists only the first.
        const listed = atf.server.recordInsert({
            $id: Now.ID['atf_crr_asset_listed'],
            table: 'alm_hardware',
            fieldValues: {
                serial_number: 'ATF-RET-0001',
                model: model.record_id,
                company: customerA.record_id,
                install_status: IN_USE,
                quantity: 1,
                x_daas_ham_fleet: true,
                x_daas_ham_agreement: agreement.record_id,
                x_daas_ham_site: siteA.record_id,
            },
            enforceSecurity: false,
        })
        const unlisted = atf.server.recordInsert({
            $id: Now.ID['atf_crr_asset_unlisted'],
            table: 'alm_hardware',
            fieldValues: {
                serial_number: 'ATF-RET-0002',
                model: model.record_id,
                company: customerA.record_id,
                install_status: IN_USE,
                quantity: 1,
                x_daas_ham_fleet: true,
                x_daas_ham_agreement: agreement.record_id,
                x_daas_ham_site: siteA.record_id,
            },
            enforceSecurity: false,
        })
        const contact = atf.server.createUser({
            $id: Now.ID['atf_crr_site_contact'],
            firstName: 'ATF',
            lastName: 'Returns Site Contact',
            table: 'customer_contact',
            fieldValues: { company: customerA.record_id },
            roles: [siteContact],
            impersonate: false,
        })
        const admin = atf.server.createUser({
            $id: Now.ID['atf_crr_customer_admin'],
            firstName: 'ATF',
            lastName: 'Returns Customer Admin',
            table: 'customer_contact',
            fieldValues: { company: customerA.record_id },
            roles: [customerAdmin],
            impersonate: false,
        })
        atf.server.impersonate({ $id: Now.ID['atf_crr_impersonate_contact'], user: contact.user })
        atf.server.runServerSideScript({
            $id: Now.ID['atf_crr_contact_refused'],
            script: `(function (outputs, steps, params, stepResult, assertEqual) {
    var customer = require('x_daas_ham/naas-ham/0.1.0/src/server/entry/customer.ts');
    function call(handler, data) {
        var reply = { status: 0, body: null };
        var request = { body: { data: data }, pathParams: {}, queryParams: {}, getHeader: function () { return undefined; } };
        var response = {
            setStatus: function (status) { reply.status = Number(status); },
            setBody: function (body) { reply.body = body; },
            setHeader: function () {},
            setContentType: function () {}
        };
        handler(request, response);
        return reply;
    }
    function idOf(table, query) {
        var record = new GlideRecord(table);
        record.addEncodedQuery(query);
        record.setLimit(1);
        record.query();
        if (!record.next()) throw new Error('no ' + table + ' matches ' + query);
        return record.getUniqueValue();
    }
    function expectReply(what, reply, status, error) {
        var got = 'HTTP ' + reply.status + ' ' + JSON.stringify(reply.body);
        var message = reply.body && reply.body.error ? String(reply.body.error) : '';
        if (reply.status !== status || (error && message.indexOf(error) < 0)) {
            throw new Error(what + ': expected HTTP ' + status + (error ? ' saying "' + error + '"' : '') + ', got ' + got);
        }
        return what + ': ' + got;
    }
    try {
        var siteA = idOf('cmn_location', 'name=ATF Returns Site A');
        var refused = call(customer.requestCustomerReturn, { site: siteA, decommission: true });
        stepResult.setOutputMessage(expectReply('A site contact', refused, 403, 'Only customer admins can request returns'));
        return true;
    } catch (e) {
        stepResult.setOutputMessage(String(e && e.message ? e.message : e));
        return false;
    }
})(outputs, steps, params, stepResult, assertEqual);`,
        })
        atf.server.impersonate({ $id: Now.ID['atf_crr_impersonate_admin'], user: admin.user })
        atf.server.runServerSideScript({
            $id: Now.ID['atf_crr_admin_requests'],
            script: `(function (outputs, steps, params, stepResult, assertEqual) {
    var customer = require('x_daas_ham/naas-ham/0.1.0/src/server/entry/customer.ts');
    function call(handler, data) {
        var reply = { status: 0, body: null };
        var request = { body: { data: data }, pathParams: {}, queryParams: {}, getHeader: function () { return undefined; } };
        var response = {
            setStatus: function (status) { reply.status = Number(status); },
            setBody: function (body) { reply.body = body; },
            setHeader: function () {},
            setContentType: function () {}
        };
        handler(request, response);
        return reply;
    }
    function idOf(table, query) {
        var record = new GlideRecord(table);
        record.addEncodedQuery(query);
        record.setLimit(1);
        record.query();
        if (!record.next()) throw new Error('no ' + table + ' matches ' + query);
        return record.getUniqueValue();
    }
    function expectReply(what, reply, status, error) {
        var got = 'HTTP ' + reply.status + ' ' + JSON.stringify(reply.body);
        var message = reply.body && reply.body.error ? String(reply.body.error) : '';
        if (reply.status !== status || (error && message.indexOf(error) < 0)) {
            throw new Error(what + ': expected HTTP ' + status + (error ? ' saying "' + error + '"' : '') + ', got ' + got);
        }
        return what + ': ' + got;
    }
    try {
        var siteA = idOf('cmn_location', 'name=ATF Returns Site A');
        var siteB = idOf('cmn_location', 'name=ATF Returns Site B');
        var listed = idOf('alm_hardware', 'serial_number=ATF-RET-0001^x_daas_ham_fleet=true');
        var seen = [];
        seen.push(expectReply('Another Customer site', call(customer.requestCustomerReturn, { site: siteB, decommission: true }), 400, 'is not one of the customer'));
        var raised = call(customer.requestCustomerReturn, { site: siteA, decommission: true, assets: [listed], method: 'ship_back' });
        seen.push(expectReply('Decommission of their own site', raised, 201));
        if (!raised.body || !raised.body.returnOrder) throw new Error('The decommission named no Return order: ' + JSON.stringify(raised.body));
        stepResult.setOutputMessage(seen.join('; '));
        return true;
    } catch (e) {
        stepResult.setOutputMessage(String(e && e.message ? e.message : e));
        return false;
    }
})(outputs, steps, params, stepResult, assertEqual);`,
        })
        // decommission: true returns everything installed at the Site, whatever the request lists.
        atf.server.recordValidation({
            $id: Now.ID['atf_crr_validate_listed'],
            table: 'alm_hardware',
            recordId: listed.record_id,
            fieldValues: 'install_status=1^substatus=pending_return',
            assert: 'record_validated',
        })
        atf.server.recordValidation({
            $id: Now.ID['atf_crr_validate_unlisted'],
            table: 'alm_hardware',
            recordId: unlisted.record_id,
            fieldValues: 'install_status=1^substatus=pending_return',
            assert: 'record_validated',
        })
        atf.server.recordQuery({
            $id: Now.ID['atf_crr_return_raised'],
            table: 'x_daas_ham_return_order',
            fieldValues: `customer=${customerA.record_id}^site=${siteA.record_id}^trigger=site_decommission^method=ship_back`,
            assert: 'records_match_query',
        })
    },
)
