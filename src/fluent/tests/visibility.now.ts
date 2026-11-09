import '@servicenow/sdk/global'
import { Test } from '@servicenow/sdk/core'
import { customerAdmin, inventoryTech } from '../security/roles.now'

/*
 * ATF: before-query visibility rules (ADR 0005) on the hardware the app shares with the Provider's IT (ADR 0016). Run:
 * now-sdk cicd testsuite run (suite "NaaS - P1"). Fixtures setting the Fleet flag insert without security enforcement:
 * the flag is read-only on forms, and the app's intake paths set it server-side, as these do.
 */

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
            fieldValues: { serial_number: 'ATF-CAV-A-0001', company: customerA.record_id, install_status: 1, quantity: 1, x_daas_ham_fleet: true },
            enforceSecurity: false,
        })
        atf.server.recordInsert({
            $id: Now.ID['atf_cav_asset_b'],
            table: 'alm_hardware',
            fieldValues: { serial_number: 'ATF-CAV-B-0001', company: customerB.record_id, install_status: 1, quantity: 1, x_daas_ham_fleet: true },
            enforceSecurity: false,
        })
        // Outside the fleet: the rules keep a Customer contact to their Customer on every record, unlike an inventory tech.
        atf.server.recordInsert({
            $id: Now.ID['atf_cav_asset_b_outside'],
            table: 'alm_hardware',
            fieldValues: { serial_number: 'ATF-CAV-B-IT-0001', company: customerB.record_id, install_status: 1, quantity: 1, x_daas_ham_fleet: false },
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
            fieldValues: { x_daas_ham_stockroom_type: 'central_depot', assignment_group: team.record_id },
        })
        const other = atf.server.recordInsert({
            $id: Now.ID['atf_itv_stockroom_other'],
            table: 'alm_stockroom',
            fieldValues: { x_daas_ham_stockroom_type: 'central_depot' },
        })
        atf.server.recordInsert({
            $id: Now.ID['atf_itv_asset_assigned'],
            table: 'alm_hardware',
            fieldValues: { serial_number: 'ATF-ITV-IN-0001', stockroom: assigned.record_id, install_status: 6, quantity: 1, x_daas_ham_fleet: true },
            enforceSecurity: false,
        })
        atf.server.recordInsert({
            $id: Now.ID['atf_itv_asset_other'],
            table: 'alm_hardware',
            fieldValues: { serial_number: 'ATF-ITV-OUT-0001', stockroom: other.record_id, install_status: 6, quantity: 1, x_daas_ham_fleet: true },
            enforceSecurity: false,
        })
        // The same unit outside the fleet: the rule keeps it in (domain/visibility `outsideNaasConditions`), for the platform to decide.
        atf.server.recordInsert({
            $id: Now.ID['atf_itv_asset_outside'],
            table: 'alm_hardware',
            fieldValues: { serial_number: 'ATF-ITV-IT-0001', stockroom: other.record_id, install_status: 6, quantity: 1, x_daas_ham_fleet: false },
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
