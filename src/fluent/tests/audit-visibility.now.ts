import '@servicenow/sdk/global'
import { Test } from '@servicenow/sdk/core'
import { inventoryTech, noc } from '../security/roles.now'

/*
 * ATF: the audit before-query rules (ADR 0005) keep an inventory tech to the blind counts of their stockrooms, and
 * POST /api/x_daas_ham/naas/audits/{id}/scan records a scan only on one of those (suite "NaaS - P1"). As in
 * customer-returns.now.ts, the scan test's scripts call the route's handler (entry/assurance `scanAudit`) in the
 * impersonated user's session; the other stockroom's blind count is found past the visibility rules
 * (platform/beyond-visibility), as the app's own server logic does.
 */

export const inventoryTechAuditVisibilityTest = Test(
    {
        $id: Now.ID['atf_inventory_tech_audit_visibility'],
        name: 'NaaS - inventory techs only see the audits of their stockrooms',
        description: 'An inventory tech sees the blind count of an assigned stockroom and its lines, not the blind count of another stockroom or a site audit.',
        active: true,
        failOnServerError: true,
    },
    (atf) => {
        const assigned = atf.server.recordInsert({
            $id: Now.ID['atf_itav_stockroom_assigned'],
            table: 'alm_stockroom',
            fieldValues: { x_daas_ham_stockroom_type: 'central_depot' },
        })
        const other = atf.server.recordInsert({
            $id: Now.ID['atf_itav_stockroom_other'],
            table: 'alm_stockroom',
            fieldValues: { x_daas_ham_stockroom_type: 'central_depot' },
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
            table: 'x_daas_ham_stockroom_member',
            fieldValues: { user: tech.user, stockroom: assigned.record_id },
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
        const assigned = atf.server.recordInsert({
            $id: Now.ID['atf_itas_stockroom_assigned'],
            table: 'alm_stockroom',
            fieldValues: { name: 'ATF-ITAS Own Depot', x_daas_ham_stockroom_type: 'central_depot' },
        })
        const other = atf.server.recordInsert({
            $id: Now.ID['atf_itas_stockroom_other'],
            table: 'alm_stockroom',
            fieldValues: { name: 'ATF-ITAS Other Depot', x_daas_ham_stockroom_type: 'central_depot' },
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
            table: 'x_daas_ham_stockroom_member',
            fieldValues: { user: tech.user, stockroom: assigned.record_id },
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
