import '@servicenow/sdk/global'
import { Test } from '@servicenow/sdk/core'
import { fieldTech, inventoryTech } from '../security/roles.now'
import { DEVICE_CLASS, INSTALL_STATUS, LEGAL_OWNER, STAGE_FIELDS, STOCKROOM_TYPE } from '../../server/domain/vocabulary'

// The vocabulary's values the fixtures below are created with, each under a name: for a value, a Test takes a
// name, but no property access (VOCABULARY.value).
const IN_STOCK = INSTALL_STATUS.inStock
const IN_TRANSIT = INSTALL_STATUS.inTransit
const RESERVED = STAGE_FIELDS.reserved.substatus
const CENTRAL_DEPOT = STOCKROOM_TYPE.central_depot
const CUSTOMER_SITE = STOCKROOM_TYPE.customer_site
const SWITCH = DEVICE_CLASS.switch
const PROVIDER_OWNED = LEGAL_OWNER.provider

/*
 * ATF: the warehouse scanning API (entry/warehouse, P1.5; suite "NaaS - P1"): POST /receive, POST /putaway and
 * GET /assets/{code}. As in customer-returns.now.ts, the server-side scripts call the routes' handlers in the
 * impersonated user's session (ATF's inbound REST step signs in through a basic auth profile, which this scope may not
 * create), so the handlers' role checks and the stockroom visibility rule (ADR 0005) apply as for that user. The scripts
 * find the fixtures by name; the stockroom the technician does not work at is found past the visibility rules
 * (platform/beyond-visibility), as the app's own server logic does. Fixtures setting the Fleet flag insert without
 * security enforcement: the flag is read-only on forms.
 */

export const warehouseScanRulesTest = Test(
    {
        $id: Now.ID['atf_warehouse_scan_rules'],
        name: 'NaaS - warehouse scans: own NaaS depots only, reserved stock stays, field techs only look up',
        description:
            "Calls the warehouse handlers as an inventory tech: receiving into a stockroom they do not work at or a customer-site stockroom answers HTTP 400 and into their depot HTTP 200 (the unit becomes available there); putting a reserved unit away answers HTTP 409. As a field tech, receiving answers HTTP 403 and looking the unit up HTTP 200.",
        active: true,
        // The handlers log what they refuse; the scripts and validations below check the outcome.
        failOnServerError: false,
    },
    (atf) => {
        // A stockroom is a tech's when they are a member of its Assignment group (ADR 0018).
        const depotTeam = atf.server.recordInsert({
            $id: Now.ID['atf_whs_depot_group'],
            table: 'sys_user_group',
            fieldValues: { name: 'ATF WH depot team' },
        })
        const siteStockTeam = atf.server.recordInsert({
            $id: Now.ID['atf_whs_site_stock_group'],
            table: 'sys_user_group',
            fieldValues: { name: 'ATF WH site stock team' },
        })
        const depot = atf.server.recordInsert({
            $id: Now.ID['atf_whs_depot'],
            table: 'alm_stockroom',
            fieldValues: { name: 'ATF WH Own Depot', x_daas_ham_stockroom_type: CENTRAL_DEPOT, assignment_group: depotTeam.record_id },
        })
        atf.server.recordInsert({
            $id: Now.ID['atf_whs_other_depot'],
            table: 'alm_stockroom',
            fieldValues: { name: 'ATF WH Other Depot', x_daas_ham_stockroom_type: CENTRAL_DEPOT },
        })
        atf.server.recordInsert({
            $id: Now.ID['atf_whs_site_stock'],
            table: 'alm_stockroom',
            fieldValues: { name: 'ATF WH Site Stock', x_daas_ham_stockroom_type: CUSTOMER_SITE, assignment_group: siteStockTeam.record_id },
        })
        const model = atf.server.recordInsert({
            $id: Now.ID['atf_whs_model'],
            table: 'cmdb_model',
            fieldValues: { name: 'ATF WH Switch', x_daas_ham_oem_pid: 'ATF-WH-24', x_daas_ham_device_class: SWITCH },
        })
        // On its way to the depot (In transit), in no stockroom yet; tagged, so the receipt takes no Provider tag.
        const arriving = atf.server.recordInsert({
            $id: Now.ID['atf_whs_arriving'],
            table: 'alm_hardware',
            fieldValues: {
                serial_number: 'ATF-WH-TRANSIT',
                asset_tag: 'ATF-WH-TAG-1',
                model: model.record_id,
                install_status: IN_TRANSIT,
                quantity: 1,
                x_daas_ham_fleet: true,
                x_daas_ham_legal_owner: PROVIDER_OWNED,
            },
            enforceSecurity: false,
        })
        const reserved = atf.server.recordInsert({
            $id: Now.ID['atf_whs_reserved'],
            table: 'alm_hardware',
            fieldValues: {
                serial_number: 'ATF-WH-RESERVED',
                asset_tag: 'ATF-WH-TAG-2',
                model: model.record_id,
                stockroom: depot.record_id,
                install_status: IN_STOCK,
                substatus: RESERVED,
                quantity: 1,
                x_daas_ham_fleet: true,
                x_daas_ham_legal_owner: PROVIDER_OWNED,
            },
            enforceSecurity: false,
        })
        const tech = atf.server.createUser({
            $id: Now.ID['atf_whs_inventory_tech'],
            firstName: 'ATF',
            lastName: 'Warehouse Tech',
            roles: [inventoryTech],
            impersonate: false,
        })
        // The technician works at their depot and the customer-site stockroom, not at the other depot.
        atf.server.recordInsert({
            $id: Now.ID['atf_whs_member_depot'],
            table: 'sys_user_grmember',
            fieldValues: { user: tech.user, group: depotTeam.record_id },
        })
        atf.server.recordInsert({
            $id: Now.ID['atf_whs_member_site_stock'],
            table: 'sys_user_grmember',
            fieldValues: { user: tech.user, group: siteStockTeam.record_id },
        })
        const fieldUser = atf.server.createUser({
            $id: Now.ID['atf_whs_field_tech'],
            firstName: 'ATF',
            lastName: 'Warehouse Field Tech',
            roles: [fieldTech],
            impersonate: false,
        })
        atf.server.impersonate({ $id: Now.ID['atf_whs_impersonate_tech'], user: tech.user })
        atf.server.runServerSideScript({
            $id: Now.ID['atf_whs_tech_scans'],
            script: `(function (outputs, steps, params, stepResult, assertEqual) {
    var warehouse = require('x_daas_ham/naas-ham/0.1.0/src/server/entry/warehouse.ts');
    var visibility = require('x_daas_ham/naas-ham/0.1.0/src/server/platform/beyond-visibility.ts');
    function call(handler, data, pathParams) {
        var reply = { status: 0, body: null };
        var request = { body: { data: data }, pathParams: pathParams || {}, queryParams: {}, getHeader: function () { return undefined; } };
        var response = {
            setStatus: function (status) { reply.status = Number(status); },
            setBody: function (body) { reply.body = body; },
            setHeader: function () {},
            setContentType: function () {}
        };
        handler(request, response);
        return reply;
    }
    function find(table, query, pastRules) {
        var record = new GlideRecord(table);
        record.addEncodedQuery(query);
        record.setLimit(1);
        if (pastRules) visibility.beyondVisibility(record, function () { record.query(); });
        else record.query();
        if (!record.next()) throw new Error('no ' + table + ' matches ' + query + (pastRules ? '' : ' for this user'));
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
        var depot = find('alm_stockroom', 'name=ATF WH Own Depot^x_daas_ham_stockroom_typeISNOTEMPTY', false);
        var siteStock = find('alm_stockroom', 'name=ATF WH Site Stock^x_daas_ham_stockroom_typeISNOTEMPTY', false);
        var otherDepot = find('alm_stockroom', 'name=ATF WH Other Depot^x_daas_ham_stockroom_typeISNOTEMPTY', true);
        var seen = [];
        seen.push(expectReply('Receipt into a depot they do not work at', call(warehouse.receiveAsset, { code: 'ATF-WH-TRANSIT', stockroom: otherDepot }), 400, 'Choose one of your stockrooms'));
        seen.push(expectReply('Receipt into a customer-site stockroom', call(warehouse.receiveAsset, { code: 'ATF-WH-TRANSIT', stockroom: siteStock }), 400, 'Receive into a central depot or a staging centre'));
        var received = call(warehouse.receiveAsset, { code: 'ATF-WH-TRANSIT', stockroom: depot });
        seen.push(expectReply('Receipt into their depot', received, 200));
        if (received.body.stage !== 'available') throw new Error('The received unit is ' + received.body.stage + ', not available');
        seen.push(expectReply('Put-away of a reserved unit', call(warehouse.putAwayAsset, { code: 'ATF-WH-RESERVED', stockroom: depot }), 409, 'Cannot be put away (reserved)'));
        stepResult.setOutputMessage(seen.join('; '));
        return true;
    } catch (e) {
        stepResult.setOutputMessage(String(e && e.message ? e.message : e));
        return false;
    }
})(outputs, steps, params, stepResult, assertEqual);`,
        })
        atf.server.recordValidation({
            $id: Now.ID['atf_whs_validate_received'],
            table: 'alm_hardware',
            recordId: arriving.record_id,
            fieldValues: `install_status=6^substatus=available^stockroom=${depot.record_id}^asset_tag=ATF-WH-TAG-1`,
            assert: 'record_validated',
        })
        atf.server.recordValidation({
            $id: Now.ID['atf_whs_validate_reserved'],
            table: 'alm_hardware',
            recordId: reserved.record_id,
            fieldValues: `install_status=6^substatus=reserved^stockroom=${depot.record_id}`,
            assert: 'record_validated',
        })
        atf.server.impersonate({ $id: Now.ID['atf_whs_impersonate_field'], user: fieldUser.user })
        atf.server.runServerSideScript({
            $id: Now.ID['atf_whs_field_scans'],
            script: `(function (outputs, steps, params, stepResult, assertEqual) {
    var warehouse = require('x_daas_ham/naas-ham/0.1.0/src/server/entry/warehouse.ts');
    function call(handler, data, pathParams) {
        var reply = { status: 0, body: null };
        var request = { body: { data: data }, pathParams: pathParams || {}, queryParams: {}, getHeader: function () { return undefined; } };
        var response = {
            setStatus: function (status) { reply.status = Number(status); },
            setBody: function (body) { reply.body = body; },
            setHeader: function () {},
            setContentType: function () {}
        };
        handler(request, response);
        return reply;
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
        var seen = [];
        seen.push(expectReply('A field tech receiving', call(warehouse.receiveAsset, { code: 'ATF-WH-RESERVED', stockroom: 'any' }), 403, 'Requires the inventory tech role'));
        var found = call(warehouse.lookupAsset, null, { code: 'ATF-WH-TRANSIT' });
        seen.push(expectReply('A field tech looking up', found, 200));
        if (found.body.serial !== 'ATF-WH-TRANSIT') throw new Error('The look-up found ' + JSON.stringify(found.body));
        stepResult.setOutputMessage(seen.join('; '));
        return true;
    } catch (e) {
        stepResult.setOutputMessage(String(e && e.message ? e.message : e));
        return false;
    }
})(outputs, steps, params, stepResult, assertEqual);`,
        })
    },
)
