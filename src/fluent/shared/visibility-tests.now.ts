import '@servicenow/sdk/global'
import { Test } from '@servicenow/sdk/core'
import { ATTESTATION_STATE } from '../../server/domain/audit'
import { DEVICE_CLASS, INSTALL_MODE, INSTALL_STATUS, LEGAL_OWNER, LINE_STAGE, ORDER_STAGE, ORDER_TYPE, STAGE_FIELDS, STOCKROOM_TYPE } from '../../server/domain/vocabulary'
import { assetManager, customerAdmin, inventoryTech, noc } from './roles.now'

/*
 * ATF: before-query visibility rules (ADR 0005) on the hardware the app shares with the Provider's IT (ADR 0016), and
 * on audits, which keep an inventory tech to the blind counts of their stockrooms; POST
 * /api/x_daas_ham/naas/audits/{id}/scan records a scan only on one of those. Run: now-sdk cicd testsuite run (suite
 * "NaaS - P1"). Fixtures setting the Fleet flag insert without security enforcement: the flag is read-only on forms,
 * and the app's intake paths set it server-side, as these do. The scan test's scripts call
 * the route's handler in the impersonated user's session; the other stockroom's blind
 * count is found past the visibility rules, as the app's own server logic does.
 */

// The vocabulary's values the fixtures below are created with, each under a name: for a value, a Test takes a
// name, but no property access (VOCABULARY.value).
const IN_STOCK = INSTALL_STATUS.inStock
const IN_USE = INSTALL_STATUS.inUse
const CENTRAL_DEPOT = STOCKROOM_TYPE.central_depot
const IN_TRANSIT = INSTALL_STATUS.inTransit
const SHIPPED_TO_SITE = STAGE_FIELDS.shipped.substatus
const PROVIDER_OWNED = LEGAL_OWNER.provider
const SWITCH = DEVICE_CLASS.switch
const DEVICE_ADD = ORDER_TYPE.device_add
const SELF_INSTALL = INSTALL_MODE.self_install
const ORDER_INSTALLING = ORDER_STAGE.installing
const LINE_SHIPPED = LINE_STAGE.shipped
const STILL_SHIPPED_FIELDS = `install_status=${STAGE_FIELDS.shipped.installStatus}^substatus=${STAGE_FIELDS.shipped.substatus}`
const STILL_INSTALLING_FIELDS = `stage=${ORDER_STAGE.installing}`
const NOT_CLOSED_FIELDS = `state!=${ATTESTATION_STATE.closed}`

export const customerAdminVisibilityTest = Test(
    {
        $id: Now.ID['atf_customer_admin_visibility'],
        name: 'NaaS - customer admins only see their own customer assets',
        description: 'A customer admin sees the fleet assets of their customer and no hardware of another customer, in the fleet or not.',
        active: true,
        failOnServerError: true,
    },
    (atf) => {
        const customerA = atf.server.recordInsert({
            $id: Now.ID['atf_cav_customer_a'],
            table: 'customer_account',
            fieldValues: { name: 'ATF Customer A', customer: true },
        })
        const customerB = atf.server.recordInsert({
            $id: Now.ID['atf_cav_customer_b'],
            table: 'customer_account',
            fieldValues: { name: 'ATF Customer B', customer: true },
        })
        atf.server.recordInsert({
            $id: Now.ID['atf_cav_asset_a'],
            table: 'alm_hardware',
            fieldValues: { serial_number: 'ATF-CAV-A-0001', company: customerA.record_id, install_status: IN_USE, quantity: 1, x_daas_ham_fleet: true },
            enforceSecurity: false,
        })
        atf.server.recordInsert({
            $id: Now.ID['atf_cav_asset_b'],
            table: 'alm_hardware',
            fieldValues: { serial_number: 'ATF-CAV-B-0001', company: customerB.record_id, install_status: IN_USE, quantity: 1, x_daas_ham_fleet: true },
            enforceSecurity: false,
        })
        // Outside the fleet: the rules keep a Customer contact to their Customer on every record, unlike an inventory tech.
        atf.server.recordInsert({
            $id: Now.ID['atf_cav_asset_b_outside'],
            table: 'alm_hardware',
            fieldValues: { serial_number: 'ATF-CAV-B-IT-0001', company: customerB.record_id, install_status: IN_USE, quantity: 1, x_daas_ham_fleet: false },
            enforceSecurity: false,
        })
        atf.server.createUser({
            $id: Now.ID['atf_cav_user'],
            firstName: 'ATF',
            lastName: 'Customer Admin',
            table: 'customer_contact',
            fieldValues: { company: customerA.record_id },
            roles: [customerAdmin],
        })
        atf.server.recordQuery({
            $id: Now.ID['atf_cav_sees_own'],
            table: 'alm_hardware',
            fieldValues: 'serial_number=ATF-CAV-A-0001',
            assert: 'records_match_query',
        })
        atf.server.recordQuery({
            $id: Now.ID['atf_cav_not_other'],
            table: 'alm_hardware',
            fieldValues: 'serial_number=ATF-CAV-B-0001',
            assert: 'no_records_match_query',
        })
        atf.server.recordQuery({
            $id: Now.ID['atf_cav_not_other_outside'],
            table: 'alm_hardware',
            fieldValues: 'serial_number=ATF-CAV-B-IT-0001',
            assert: 'no_records_match_query',
        })
    },
)

export const inventoryTechVisibilityTest = Test(
    {
        $id: Now.ID['atf_inventory_tech_visibility'],
        name: 'NaaS - inventory techs only see the fleet assets of their stockrooms',
        description:
            'An inventory tech sees the fleet assets in an assigned stockroom and none in another one, where the app leaves hardware outside the fleet to the platform.',
        active: true,
        failOnServerError: true,
    },
    (atf) => {
        // A stockroom is a tech's when they are a member of its Assignment group (ADR 0018).
        const team = atf.server.recordInsert({
            $id: Now.ID['atf_itv_group'],
            table: 'sys_user_group',
            fieldValues: { name: 'ATF-ITV stockroom team' },
        })
        const assigned = atf.server.recordInsert({
            $id: Now.ID['atf_itv_stockroom_assigned'],
            table: 'alm_stockroom',
            fieldValues: { x_daas_ham_stockroom_type: CENTRAL_DEPOT, assignment_group: team.record_id },
        })
        const other = atf.server.recordInsert({
            $id: Now.ID['atf_itv_stockroom_other'],
            table: 'alm_stockroom',
            fieldValues: { x_daas_ham_stockroom_type: CENTRAL_DEPOT },
        })
        atf.server.recordInsert({
            $id: Now.ID['atf_itv_asset_assigned'],
            table: 'alm_hardware',
            fieldValues: { serial_number: 'ATF-ITV-IN-0001', stockroom: assigned.record_id, install_status: IN_STOCK, quantity: 1, x_daas_ham_fleet: true },
            enforceSecurity: false,
        })
        atf.server.recordInsert({
            $id: Now.ID['atf_itv_asset_other'],
            table: 'alm_hardware',
            fieldValues: { serial_number: 'ATF-ITV-OUT-0001', stockroom: other.record_id, install_status: IN_STOCK, quantity: 1, x_daas_ham_fleet: true },
            enforceSecurity: false,
        })
        // The same unit outside the fleet: the rule keeps it in, for the platform to decide.
        atf.server.recordInsert({
            $id: Now.ID['atf_itv_asset_outside'],
            table: 'alm_hardware',
            fieldValues: { serial_number: 'ATF-ITV-IT-0001', stockroom: other.record_id, install_status: IN_STOCK, quantity: 1, x_daas_ham_fleet: false },
            enforceSecurity: false,
        })
        const tech = atf.server.createUser({
            $id: Now.ID['atf_itv_user'],
            firstName: 'ATF',
            lastName: 'Inventory Tech',
            roles: [inventoryTech],
            impersonate: false,
        })
        atf.server.recordInsert({
            $id: Now.ID['atf_itv_member'],
            table: 'sys_user_grmember',
            fieldValues: { user: tech.user, group: team.record_id },
        })
        atf.server.impersonate({ $id: Now.ID['atf_itv_impersonate'], user: tech.user })
        atf.server.recordQuery({
            $id: Now.ID['atf_itv_sees_assigned'],
            table: 'alm_hardware',
            fieldValues: 'serial_number=ATF-ITV-IN-0001',
            assert: 'records_match_query',
        })
        atf.server.recordQuery({
            $id: Now.ID['atf_itv_not_other'],
            table: 'alm_hardware',
            fieldValues: 'serial_number=ATF-ITV-OUT-0001',
            assert: 'no_records_match_query',
        })
        atf.server.recordQuery({
            $id: Now.ID['atf_itv_sees_outside'],
            table: 'alm_hardware',
            fieldValues: 'serial_number=ATF-ITV-IT-0001',
            assert: 'records_match_query',
        })
    },
)

export const inventoryTechAuditVisibilityTest = Test(
    {
        $id: Now.ID['atf_inventory_tech_audit_visibility'],
        name: 'NaaS - inventory techs only see the audits of their stockrooms',
        description: 'An inventory tech sees the blind count of an assigned stockroom and its lines, not the blind count of another stockroom or a site audit.',
        active: true,
        failOnServerError: true,
    },
    (atf) => {
        // A stockroom is a tech's when they are a member of its Assignment group (ADR 0018).
        const team = atf.server.recordInsert({
            $id: Now.ID['atf_itav_group'],
            table: 'sys_user_group',
            fieldValues: { name: 'ATF-ITAV stockroom team' },
        })
        const assigned = atf.server.recordInsert({
            $id: Now.ID['atf_itav_stockroom_assigned'],
            table: 'alm_stockroom',
            fieldValues: { x_daas_ham_stockroom_type: CENTRAL_DEPOT, assignment_group: team.record_id },
        })
        const other = atf.server.recordInsert({
            $id: Now.ID['atf_itav_stockroom_other'],
            table: 'alm_stockroom',
            fieldValues: { x_daas_ham_stockroom_type: CENTRAL_DEPOT },
        })
        const ownCount = atf.server.recordInsert({
            $id: Now.ID['atf_itav_audit_own'],
            table: 'x_daas_ham_audit',
            fieldValues: { audit_type: 'stockroom', stockroom: assigned.record_id, short_description: 'ATF-ITAV own blind count' },
        })
        const otherCount = atf.server.recordInsert({
            $id: Now.ID['atf_itav_audit_other'],
            table: 'x_daas_ham_audit',
            fieldValues: { audit_type: 'stockroom', stockroom: other.record_id, short_description: 'ATF-ITAV other blind count' },
        })
        const siteAudit = atf.server.recordInsert({
            $id: Now.ID['atf_itav_audit_site'],
            table: 'x_daas_ham_audit',
            fieldValues: { audit_type: 'site', short_description: 'ATF-ITAV site audit' },
        })
        atf.server.recordInsert({
            $id: Now.ID['atf_itav_line_own'],
            table: 'x_daas_ham_audit_line',
            fieldValues: { audit: ownCount.record_id, scanned_code: 'ATF-ITAV-OWN' },
        })
        atf.server.recordInsert({
            $id: Now.ID['atf_itav_line_other'],
            table: 'x_daas_ham_audit_line',
            fieldValues: { audit: otherCount.record_id, scanned_code: 'ATF-ITAV-OTHER' },
        })
        atf.server.recordInsert({
            $id: Now.ID['atf_itav_line_site'],
            table: 'x_daas_ham_audit_line',
            fieldValues: { audit: siteAudit.record_id, scanned_code: 'ATF-ITAV-SITE' },
        })
        const tech = atf.server.createUser({
            $id: Now.ID['atf_itav_user'],
            firstName: 'ATF',
            lastName: 'Audit Tech',
            roles: [inventoryTech],
            impersonate: false,
        })
        atf.server.recordInsert({
            $id: Now.ID['atf_itav_member'],
            table: 'sys_user_grmember',
            fieldValues: { user: tech.user, group: team.record_id },
        })
        atf.server.impersonate({ $id: Now.ID['atf_itav_impersonate'], user: tech.user })
        atf.server.recordQuery({
            $id: Now.ID['atf_itav_sees_own'],
            table: 'x_daas_ham_audit',
            fieldValues: 'short_description=ATF-ITAV own blind count',
            assert: 'records_match_query',
        })
        atf.server.recordQuery({
            $id: Now.ID['atf_itav_not_other'],
            table: 'x_daas_ham_audit',
            fieldValues: 'short_description=ATF-ITAV other blind count',
            assert: 'no_records_match_query',
        })
        atf.server.recordQuery({
            $id: Now.ID['atf_itav_not_site'],
            table: 'x_daas_ham_audit',
            fieldValues: 'short_description=ATF-ITAV site audit',
            assert: 'no_records_match_query',
        })
        atf.server.recordQuery({
            $id: Now.ID['atf_itav_sees_own_line'],
            table: 'x_daas_ham_audit_line',
            fieldValues: 'scanned_code=ATF-ITAV-OWN',
            assert: 'records_match_query',
        })
        atf.server.recordQuery({
            $id: Now.ID['atf_itav_not_other_lines'],
            table: 'x_daas_ham_audit_line',
            fieldValues: 'scanned_codeINATF-ITAV-OTHER,ATF-ITAV-SITE',
            assert: 'no_records_match_query',
        })
    },
)

export const inventoryTechAuditScanTest = Test(
    {
        $id: Now.ID['atf_inventory_tech_audit_scan'],
        name: 'NaaS - audit scans are recorded only on an open audit of the technician',
        description:
            "Calls the audit scan handler as an inventory tech: a scan of their stockroom's blind count answers HTTP 200 and is recorded as found, one without a code HTTP 400, and one of another stockroom's blind count HTTP 404 with nothing recorded; a NOC user, neither inventory nor field tech, gets HTTP 403.",
        active: true,
        // The handler logs what it refuses; the scripts and queries below check the outcome.
        failOnServerError: false,
    },
    (atf) => {
        // A stockroom is a tech's when they are a member of its Assignment group (ADR 0018).
        const team = atf.server.recordInsert({
            $id: Now.ID['atf_itas_group'],
            table: 'sys_user_group',
            fieldValues: { name: 'ATF-ITAS stockroom team' },
        })
        const assigned = atf.server.recordInsert({
            $id: Now.ID['atf_itas_stockroom_assigned'],
            table: 'alm_stockroom',
            fieldValues: { name: 'ATF-ITAS Own Depot', x_daas_ham_stockroom_type: CENTRAL_DEPOT, assignment_group: team.record_id },
        })
        const other = atf.server.recordInsert({
            $id: Now.ID['atf_itas_stockroom_other'],
            table: 'alm_stockroom',
            fieldValues: { name: 'ATF-ITAS Other Depot', x_daas_ham_stockroom_type: CENTRAL_DEPOT },
        })
        const ownCount = atf.server.recordInsert({
            $id: Now.ID['atf_itas_audit_own'],
            table: 'x_daas_ham_audit',
            fieldValues: { audit_type: 'stockroom', stockroom: assigned.record_id, short_description: 'ATF-ITAS own blind count' },
        })
        const otherCount = atf.server.recordInsert({
            $id: Now.ID['atf_itas_audit_other'],
            table: 'x_daas_ham_audit',
            fieldValues: { audit_type: 'stockroom', stockroom: other.record_id, short_description: 'ATF-ITAS other blind count' },
        })
        const tech = atf.server.createUser({
            $id: Now.ID['atf_itas_user'],
            firstName: 'ATF',
            lastName: 'Scan Tech',
            roles: [inventoryTech],
            impersonate: false,
        })
        atf.server.recordInsert({
            $id: Now.ID['atf_itas_member'],
            table: 'sys_user_grmember',
            fieldValues: { user: tech.user, group: team.record_id },
        })
        const nocUser = atf.server.createUser({
            $id: Now.ID['atf_itas_noc_user'],
            firstName: 'ATF',
            lastName: 'Scan NOC',
            roles: [noc],
            impersonate: false,
        })
        atf.server.impersonate({ $id: Now.ID['atf_itas_impersonate_tech'], user: tech.user })
        atf.server.runServerSideScript({
            $id: Now.ID['atf_itas_tech_scans'],
            script: `(function (outputs, steps, params, stepResult, assertEqual) {
    var assurance = require('x_daas_ham/naas-ham/0.1.0/src/server/entry/assurance.ts');
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
        var own = find('x_daas_ham_audit', 'short_description=ATF-ITAS own blind count', false);
        var other = find('x_daas_ham_audit', 'short_description=ATF-ITAS other blind count', true);
        var seen = [];
        var scanned = call(assurance.scanAudit, { code: ' ATF-ITAS-0001 ' }, { id: own });
        seen.push(expectReply('A scan of their blind count', scanned, 200));
        if (scanned.body.scanned !== 'ATF-ITAS-0001') throw new Error('The scan recorded ' + JSON.stringify(scanned.body));
        seen.push(expectReply('A scan without a code', call(assurance.scanAudit, { code: '' }, { id: own }), 400, 'code is required'));
        seen.push(expectReply('A scan of another stockroom blind count', call(assurance.scanAudit, { code: 'ATF-ITAS-0002' }, { id: other }), 404, 'No open audit'));
        stepResult.setOutputMessage(seen.join('; '));
        return true;
    } catch (e) {
        stepResult.setOutputMessage(String(e && e.message ? e.message : e));
        return false;
    }
})(outputs, steps, params, stepResult, assertEqual);`,
        })
        atf.server.recordQuery({
            $id: Now.ID['atf_itas_scan_recorded'],
            table: 'x_daas_ham_audit_line',
            fieldValues: `audit=${ownCount.record_id}^scanned_code=ATF-ITAS-0001^result=found^scanned_atISNOTEMPTY`,
            assert: 'records_match_query',
        })
        atf.server.impersonate({ $id: Now.ID['atf_itas_impersonate_noc'], user: nocUser.user })
        // The NOC sees every audit, the other stockroom's too: nothing was recorded on it.
        atf.server.recordQuery({
            $id: Now.ID['atf_itas_nothing_on_other'],
            table: 'x_daas_ham_audit_line',
            fieldValues: `audit=${otherCount.record_id}`,
            assert: 'no_records_match_query',
        })
        atf.server.runServerSideScript({
            $id: Now.ID['atf_itas_noc_refused'],
            script: `(function (outputs, steps, params, stepResult, assertEqual) {
    var assurance = require('x_daas_ham/naas-ham/0.1.0/src/server/entry/assurance.ts');
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
    try {
        var audit = new GlideRecord('x_daas_ham_audit');
        audit.addQuery('short_description', 'ATF-ITAS own blind count');
        audit.query();
        if (!audit.next()) throw new Error('no blind count ATF-ITAS own blind count');
        var refused = call(assurance.scanAudit, { code: 'ATF-ITAS-0003' }, { id: audit.getUniqueValue() });
        var got = 'HTTP ' + refused.status + ' ' + JSON.stringify(refused.body);
        if (refused.status !== 403) throw new Error('A NOC scan: expected HTTP 403, got ' + got);
        stepResult.setOutputMessage('A NOC scan: ' + got);
        return true;
    } catch (e) {
        stepResult.setOutputMessage(String(e && e.message ? e.message : e));
        return false;
    }
})(outputs, steps, params, stepResult, assertEqual);`,
        })
    },
)

/*
 * Suite "NaaS - P2". The customer page's routes that take a record's sys_id (report a fault, confirm a self-install,
 * answer an attestation) have no tenant check of their own: each reads the record as the caller, so the before-query
 * rules (ADR 0005) are what keep a Customer admin to their own Customer. The first script calls each handler as
 * Customer B's admin with Customer A's sys_ids, found past the rules as the app's own server logic finds them. An
 * attestation item has no before-query rule, so the last call names Customer A's item on Customer B's own
 * attestation: there the handler's check that an item belongs to the attestation is what skips the answer. The
 * second script calls the same handlers as Customer A's admin, which shows that the fixtures were live and that only
 * the caller's Customer made the difference.
 */
export const customerRoutesOtherCustomerTest = Test(
    {
        $id: Now.ID['atf_customer_routes_other_customer'],
        name: 'NaaS - customer routes refuse the device, order and attestation of another customer',
        description:
            "Calls the customer fault, install confirmation and attestation handlers as Customer B's admin with Customer A's device, self-install Order and attestation (HTTP 404, 409 and 404), and with A's attestation item on B's own attestation (HTTP 200, the answer skipped); no case is opened, the unit stays shipped and the item unanswered. The same calls as Customer A's admin then find each record.",
        active: true,
        // The handlers log what the platform refuses them; the scripts and validations below check the outcome.
        failOnServerError: false,
    },
    (atf) => {
        const customerA = atf.server.recordInsert({
            $id: Now.ID['atf_cxt_customer_a'],
            table: 'customer_account',
            fieldValues: { name: 'ATF Routes Customer A', customer: true },
        })
        const customerB = atf.server.recordInsert({
            $id: Now.ID['atf_cxt_customer_b'],
            table: 'customer_account',
            fieldValues: { name: 'ATF Routes Customer B', customer: true },
        })
        const siteA = atf.server.recordInsert({
            $id: Now.ID['atf_cxt_site_a'],
            table: 'cmn_location',
            fieldValues: { name: 'ATF Routes Site A', x_daas_ham_is_site: true, company: customerA.record_id },
        })
        const siteB = atf.server.recordInsert({
            $id: Now.ID['atf_cxt_site_b'],
            table: 'cmn_location',
            fieldValues: { name: 'ATF Routes Site B', x_daas_ham_is_site: true, company: customerB.record_id },
        })
        const model = atf.server.recordInsert({
            $id: Now.ID['atf_cxt_model'],
            table: 'cmdb_model',
            fieldValues: { name: 'ATF Routes Switch', x_daas_ham_oem_pid: 'ATF-RTE-24', x_daas_ham_device_class: SWITCH },
        })
        const agreement = atf.server.recordInsert({
            $id: Now.ID['atf_cxt_agreement'],
            table: 'x_daas_ham_agreement',
            fieldValues: { customer: customerA.record_id, short_description: 'ATF routes agreement', state: 'active', currency: 'EUR' },
        })
        // Customer A's device in service: what a fault is reported on, and what its attestation lists.
        const installed = atf.server.recordInsert({
            $id: Now.ID['atf_cxt_asset_installed'],
            table: 'alm_hardware',
            fieldValues: {
                serial_number: 'ATF-RTE-0001',
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
        // Customer A's self-install Order with its one unit shipped: installing, so it waits for the confirmation
        // whoever counts its shipped units.
        const order = atf.server.recordInsert({
            $id: Now.ID['atf_cxt_order'],
            table: 'x_daas_ham_order',
            fieldValues: {
                customer: customerA.record_id,
                site: siteA.record_id,
                agreement: agreement.record_id,
                order_type: DEVICE_ADD,
                install_mode: SELF_INSTALL,
                short_description: 'ATF routes self-install order',
                stage: ORDER_INSTALLING,
                approval: 'approved',
                entitlement_verdict: 'within_agreement',
            },
            enforceSecurity: false,
        })
        const line = atf.server.recordInsert({
            $id: Now.ID['atf_cxt_order_line'],
            table: 'x_daas_ham_order_line',
            fieldValues: { order: order.record_id, model: model.record_id, quantity: 1, line_stage: LINE_SHIPPED },
            enforceSecurity: false,
        })
        const shipped = atf.server.recordInsert({
            $id: Now.ID['atf_cxt_asset_shipped'],
            table: 'alm_hardware',
            fieldValues: {
                serial_number: 'ATF-RTE-0002',
                model: model.record_id,
                company: customerA.record_id,
                install_status: IN_TRANSIT,
                substatus: SHIPPED_TO_SITE,
                quantity: 1,
                x_daas_ham_fleet: true,
                x_daas_ham_legal_owner: PROVIDER_OWNED,
                x_daas_ham_order_line: line.record_id,
                x_daas_ham_agreement: agreement.record_id,
                x_daas_ham_site: siteA.record_id,
            },
            enforceSecurity: false,
        })
        const attestationA = atf.server.recordInsert({
            $id: Now.ID['atf_cxt_attestation_a'],
            table: 'x_daas_ham_attestation',
            fieldValues: { customer: customerA.record_id, site: siteA.record_id, short_description: 'ATF routes attestation A' },
            enforceSecurity: false,
        })
        const item = atf.server.recordInsert({
            $id: Now.ID['atf_cxt_attestation_item'],
            table: 'x_daas_ham_attestation_item',
            fieldValues: { attestation: attestationA.record_id, asset: installed.record_id },
            enforceSecurity: false,
        })
        // Customer B's own open attestation, with no item: the one its admin may answer.
        atf.server.recordInsert({
            $id: Now.ID['atf_cxt_attestation_b'],
            table: 'x_daas_ham_attestation',
            fieldValues: { customer: customerB.record_id, site: siteB.record_id, short_description: 'ATF routes attestation B' },
            enforceSecurity: false,
        })
        const adminB = atf.server.createUser({
            $id: Now.ID['atf_cxt_admin_b'],
            firstName: 'ATF',
            lastName: 'Routes Admin B',
            table: 'customer_contact',
            fieldValues: { company: customerB.record_id },
            roles: [customerAdmin],
            impersonate: false,
        })
        const adminA = atf.server.createUser({
            $id: Now.ID['atf_cxt_admin_a'],
            firstName: 'ATF',
            lastName: 'Routes Admin A',
            table: 'customer_contact',
            fieldValues: { company: customerA.record_id },
            roles: [customerAdmin],
            impersonate: false,
        })
        const manager = atf.server.createUser({
            $id: Now.ID['atf_cxt_asset_manager'],
            firstName: 'ATF',
            lastName: 'Routes Asset Manager',
            roles: [assetManager],
            impersonate: false,
        })
        atf.server.impersonate({ $id: Now.ID['atf_cxt_impersonate_admin_b'], user: adminB.user })
        atf.server.runServerSideScript({
            $id: Now.ID['atf_cxt_other_customer_refused'],
            script: `(function (outputs, steps, params, stepResult, assertEqual) {
    var customer = require('x_daas_ham/naas-ham/0.1.0/src/server/entry/customer.ts');
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
        var device = find('alm_hardware', 'serial_number=ATF-RTE-0001^x_daas_ham_fleet=true', true);
        var order = find('x_daas_ham_order', 'short_description=ATF routes self-install order', true);
        var theirs = find('x_daas_ham_attestation', 'short_description=ATF routes attestation A', true);
        var item = find('x_daas_ham_attestation_item', 'attestation=' + theirs, true);
        var own = find('x_daas_ham_attestation', 'short_description=ATF routes attestation B', false);
        var answer = [{ id: item, response: 'missing' }];
        var seen = [];
        seen.push(expectReply('A fault on another Customer device', call(customer.reportFault, { asset: device, description: 'ATF routes fault' }), 404, 'Unknown device'));
        seen.push(expectReply('Another Customer self-install', call(customer.confirmInstalled, {}, { id: order }), 409, 'not waiting for a self-install confirmation'));
        seen.push(expectReply('Another Customer attestation', call(customer.answerAttestation, { items: answer, submit: true }, { id: theirs }), 404, 'No open attestation'));
        seen.push(expectReply('Another Customer item on their own attestation', call(customer.answerAttestation, { items: answer }, { id: own }), 200));
        stepResult.setOutputMessage(seen.join('; '));
        return true;
    } catch (e) {
        stepResult.setOutputMessage(String(e && e.message ? e.message : e));
        return false;
    }
})(outputs, steps, params, stepResult, assertEqual);`,
        })
        // A customer reads no Asset's stage (fleet/access.now.ts), so the provider checks that nothing changed.
        atf.server.impersonate({ $id: Now.ID['atf_cxt_impersonate_manager'], user: manager.user })
        atf.server.recordQuery({
            $id: Now.ID['atf_cxt_no_case'],
            table: 'sn_customerservice_case',
            fieldValues: `x_daas_ham_failed_asset=${installed.record_id}`,
            assert: 'no_records_match_query',
        })
        atf.server.recordValidation({
            $id: Now.ID['atf_cxt_validate_shipped'],
            table: 'alm_hardware',
            recordId: shipped.record_id,
            fieldValues: STILL_SHIPPED_FIELDS,
            assert: 'record_validated',
        })
        atf.server.recordValidation({
            $id: Now.ID['atf_cxt_validate_order'],
            table: 'x_daas_ham_order',
            recordId: order.record_id,
            fieldValues: STILL_INSTALLING_FIELDS,
            assert: 'record_validated',
        })
        atf.server.recordValidation({
            $id: Now.ID['atf_cxt_validate_attestation'],
            table: 'x_daas_ham_attestation',
            recordId: attestationA.record_id,
            fieldValues: NOT_CLOSED_FIELDS,
            assert: 'record_validated',
        })
        atf.server.recordValidation({
            $id: Now.ID['atf_cxt_validate_item_unanswered'],
            table: 'x_daas_ham_attestation_item',
            recordId: item.record_id,
            fieldValues: 'responseISEMPTY',
            assert: 'record_validated',
        })
        // The control: the same calls as Customer A's admin find each record, so only the Customer told them apart.
        atf.server.impersonate({ $id: Now.ID['atf_cxt_impersonate_admin_a'], user: adminA.user })
        atf.server.runServerSideScript({
            $id: Now.ID['atf_cxt_own_customer_found'],
            script: `(function (outputs, steps, params, stepResult, assertEqual) {
    var customer = require('x_daas_ham/naas-ham/0.1.0/src/server/entry/customer.ts');
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
    function expectFound(what, reply, notFound) {
        var got = 'HTTP ' + reply.status + ' ' + JSON.stringify(reply.body);
        if (reply.status === notFound) throw new Error(what + ': expected HTTP other than ' + notFound + ', got ' + got);
        return what + ': ' + got;
    }
    try {
        var device = find('alm_hardware', 'serial_number=ATF-RTE-0001^x_daas_ham_fleet=true', false);
        var order = find('x_daas_ham_order', 'short_description=ATF routes self-install order', false);
        var own = find('x_daas_ham_attestation', 'short_description=ATF routes attestation A', false);
        var item = find('x_daas_ham_attestation_item', 'attestation=' + own, false);
        var seen = [];
        seen.push(expectFound('A fault on their own device', call(customer.reportFault, { asset: device, description: 'ATF routes fault' }), 404));
        seen.push(expectFound('Their own self-install', call(customer.confirmInstalled, {}, { id: order }), 409));
        seen.push(expectReply('Their own attestation', call(customer.answerAttestation, { items: [{ id: item, response: 'confirmed' }] }, { id: own }), 200));
        stepResult.setOutputMessage(seen.join('; '));
        return true;
    } catch (e) {
        stepResult.setOutputMessage(String(e && e.message ? e.message : e));
        return false;
    }
})(outputs, steps, params, stepResult, assertEqual);`,
        })
        atf.server.impersonate({ $id: Now.ID['atf_cxt_impersonate_manager_again'], user: manager.user })
        atf.server.recordValidation({
            $id: Now.ID['atf_cxt_validate_item_answered'],
            table: 'x_daas_ham_attestation_item',
            recordId: item.record_id,
            fieldValues: 'response=confirmed',
            assert: 'record_validated',
        })
    },
)
