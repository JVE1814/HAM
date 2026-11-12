import '@servicenow/sdk/global'
import { Test } from '@servicenow/sdk/core'
import { DEVICE_CLASS, INSTALL_STATUS, LEGAL_OWNER, STAGE_FIELDS, STOCKROOM_TYPE } from '../../server/domain/vocabulary'
import { assetManager, customerAdmin, inventoryTech, siteContact } from '../shared/roles.now'

/*
 * ATF: depot evaluation routing (Q60), on fleet assets: the app moves those only (ADR 0016).
 * Fixtures setting the Fleet flag insert without security enforcement: the flag is read-only on forms, and the app's
 * intake paths set it server-side.
 */

// The vocabulary's values the fixtures below are created with, each under a name: for a value, a Test takes a
// name, but no property access (VOCABULARY.value).
const IN_STOCK = INSTALL_STATUS.inStock
const PENDING_EVALUATION = STAGE_FIELDS.pending_evaluation.substatus
const CENTRAL_DEPOT = STOCKROOM_TYPE.central_depot
const PROVIDER_OWNED = LEGAL_OWNER.provider
const IN_USE = INSTALL_STATUS.inUse
const SWITCH = DEVICE_CLASS.switch
const AVAILABLE_FIELDS = `install_status=${STAGE_FIELDS.available.installStatus}^substatus=${STAGE_FIELDS.available.substatus}`
const PENDING_RETURN_FIELDS = `install_status=${STAGE_FIELDS.pending_return.installStatus}^substatus=${STAGE_FIELDS.pending_return.substatus}`

export const returnEvaluationTest = Test(
    {
        $id: Now.ID['atf_return_evaluation'],
        name: 'NaaS - evaluating a returned unit as refurbish puts it back in stock',
        description: 'A received provider-owned fleet unit evaluated "refurbish" becomes available and its line evaluated.',
        active: true,
        failOnServerError: true,
    },
    (atf) => {
        const customer = atf.server.recordInsert({
            $id: Now.ID['atf_rev_customer'],
            table: 'customer_account',
            fieldValues: { name: 'ATF Return Customer', customer: true },
        })
        // The tech sees only the Assets of their Stockrooms (ADR 0005), so the unit waits in a depot they work at: one
        // assigned to a group they are a member of (ADR 0018).
        const depotGroup = atf.server.recordInsert({
            $id: Now.ID['atf_rev_group'],
            table: 'sys_user_group',
            fieldValues: { name: 'ATF Return Depot team' },
        })
        const depot = atf.server.recordInsert({
            $id: Now.ID['atf_rev_stockroom'],
            table: 'alm_stockroom',
            fieldValues: { name: 'ATF Return Depot', x_daas_ham_stockroom_type: CENTRAL_DEPOT, assignment_group: depotGroup.record_id },
        })
        const asset = atf.server.recordInsert({
            $id: Now.ID['atf_rev_asset'],
            table: 'alm_hardware',
            fieldValues: {
                serial_number: 'ATF-REV-0001',
                stockroom: depot.record_id,
                company: customer.record_id,
                install_status: IN_STOCK,
                substatus: PENDING_EVALUATION,
                quantity: 1,
                x_daas_ham_fleet: true,
                x_daas_ham_legal_owner: PROVIDER_OWNED,
            },
            enforceSecurity: false,
        })
        const returnOrder = atf.server.recordInsert({
            $id: Now.ID['atf_rev_return'],
            table: 'x_daas_ham_return_order',
            fieldValues: { trigger: 'device_removal', customer: customer.record_id, method: 'ship_back', short_description: 'ATF return' },
        })
        const line = atf.server.recordInsert({
            $id: Now.ID['atf_rev_line'],
            table: 'x_daas_ham_return_order_line',
            fieldValues: { return_order: returnOrder.record_id, asset: asset.record_id, status: 'received' },
        })
        const tech = atf.server.createUser({
            $id: Now.ID['atf_rev_user'],
            firstName: 'ATF',
            lastName: 'Inventory Tech',
            roles: [inventoryTech],
            impersonate: false,
        })
        atf.server.recordInsert({
            $id: Now.ID['atf_rev_member'],
            table: 'sys_user_grmember',
            fieldValues: { user: tech.user, group: depotGroup.record_id },
        })
        atf.server.impersonate({ $id: Now.ID['atf_rev_impersonate'], user: tech.user })
        atf.server.recordUpdate({
            $id: Now.ID['atf_rev_evaluate'],
            table: 'x_daas_ham_return_order_line',
            recordId: line.record_id,
            fieldValues: { evaluation: 'refurbish', condition: 'good' },
            assert: 'record_successfully_updated',
        })
        atf.server.recordValidation({
            $id: Now.ID['atf_rev_validate_line'],
            table: 'x_daas_ham_return_order_line',
            recordId: line.record_id,
            fieldValues: 'status=evaluated',
            assert: 'record_validated',
        })
        atf.server.recordValidation({
            $id: Now.ID['atf_rev_validate_asset'],
            table: 'alm_hardware',
            recordId: asset.record_id,
            fieldValues: AVAILABLE_FIELDS,
            assert: 'record_validated',
        })
    },
)

/*
 * ATF's inbound REST step signs in through a basic auth profile, which
 * this scope may not create, so the server-side scripts call the route's handler in the impersonated user's session,
 * with the request and response objects it reads (body.data, setStatus, setBody), as the platform does: the handler's
 * role checks and the visibility rules (ADR 0005) apply as for that user. A script cannot read an earlier step's
 * output (the platform resolves none in a script), so it finds the fixtures by their names; locations have no
 * visibility rule. Module paths are those of the SDK's own generated wrappers (scope/package/version/file, as
 * shared/server-modules), written out in each script: a step's text takes step outputs only (`${step.record_id}`), no
 * other name. src/server/built-metadata.test.ts holds each built script to the modules the build installs. Fixtures
 * setting the Fleet flag insert without security enforcement: the flag is read-only on forms.
 */

export const customerReturnRequestTest = Test(
    {
        $id: Now.ID['atf_customer_return_request'],
        name: 'NaaS - customer returns: admins only, own sites only, a decommission takes the whole site',
        description:
            "Calls the customer returns handler as a site contact (HTTP 403), then as a customer admin naming another Customer's site (HTTP 400) and their own site with decommission: true listing one of its two installed fleet assets (HTTP 201); both assets then await the return, so the site's equipment was found server-side. A Return order the admin then inserts by hand with no Customer, or with another Customer's site, is not saved, nor is such an Order; one for their own Customer and site is.",
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
        const siteB = atf.server.recordInsert({
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
        // Still the customer admin. A record inserted by hand (a form, the Table API) meets the create ACL and no
        // producer: the before-insert rules hold it to the admin's Customer and its Sites. The last insert is the
        // control: it shows the admin can insert at all, so the three refusals are the rules'.
        atf.server.recordInsert({
            $id: Now.ID['atf_crr_insert_no_customer'],
            table: 'x_daas_ham_return_order',
            fieldValues: { short_description: 'ATF returns insert with no customer' },
            assert: 'record_not_inserted',
        })
        atf.server.recordInsert({
            $id: Now.ID['atf_crr_insert_other_site'],
            table: 'x_daas_ham_return_order',
            fieldValues: { customer: customerA.record_id, site: siteB.record_id, short_description: 'ATF returns insert with another site' },
            assert: 'record_not_inserted',
        })
        atf.server.recordInsert({
            $id: Now.ID['atf_crr_insert_order_other_site'],
            table: 'x_daas_ham_order',
            fieldValues: { customer: customerA.record_id, site: siteB.record_id, short_description: 'ATF order insert with another site' },
            assert: 'record_not_inserted',
        })
        atf.server.recordInsert({
            $id: Now.ID['atf_crr_insert_own_site'],
            table: 'x_daas_ham_return_order',
            fieldValues: { customer: customerA.record_id, site: siteA.record_id, short_description: 'ATF returns insert with their own site' },
            assert: 'record_successfully_inserted',
        })
        // A customer reads no Asset's stage (fleet/access.now.ts), so the provider checks the outcome.
        const manager = atf.server.createUser({
            $id: Now.ID['atf_crr_asset_manager'],
            firstName: 'ATF',
            lastName: 'Returns Asset Manager',
            roles: [assetManager],
            impersonate: false,
        })
        atf.server.impersonate({ $id: Now.ID['atf_crr_impersonate_manager'], user: manager.user })
        // decommission: true returns everything installed at the Site, whatever the request lists.
        atf.server.recordValidation({
            $id: Now.ID['atf_crr_validate_listed'],
            table: 'alm_hardware',
            recordId: listed.record_id,
            fieldValues: PENDING_RETURN_FIELDS,
            assert: 'record_validated',
        })
        atf.server.recordValidation({
            $id: Now.ID['atf_crr_validate_unlisted'],
            table: 'alm_hardware',
            recordId: unlisted.record_id,
            fieldValues: PENDING_RETURN_FIELDS,
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
