import '@servicenow/sdk/global'
import { Test } from '@servicenow/sdk/core'
import { inventoryTech } from '../security/roles.now'

/* ATF: the audit before-query rules (ADR 0005) keep an inventory tech to the blind counts of their stockrooms (suite "NaaS - P1"). */

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
            fieldValues: { x_daas_ham_stockroom_type: 'central_depot', assignment_group: team.record_id },
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
