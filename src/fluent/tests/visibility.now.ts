import '@servicenow/sdk/global'
import { Test } from '@servicenow/sdk/core'
import { customerAdmin, inventoryTech } from '../security/roles.now'

/* ATF: before-query visibility rules (ADR 0005). Run: now-sdk cicd testsuite run (suite "NaaS - P1"). */

export const customerAdminVisibilityTest = Test(
    {
        $id: Now.ID['atf_customer_admin_visibility'],
        name: 'NaaS - customer admins only see their own customer assets',
        description: 'A customer admin sees assets of their customer and none of another customer.',
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
            fieldValues: { serial_number: 'ATF-CAV-A-0001', company: customerA.record_id, install_status: 1, quantity: 1 },
        })
        atf.server.recordInsert({
            $id: Now.ID['atf_cav_asset_b'],
            table: 'alm_hardware',
            fieldValues: { serial_number: 'ATF-CAV-B-0001', company: customerB.record_id, install_status: 1, quantity: 1 },
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
    },
)

export const inventoryTechVisibilityTest = Test(
    {
        $id: Now.ID['atf_inventory_tech_visibility'],
        name: 'NaaS - inventory techs only see their stockrooms',
        description: 'An inventory tech sees stock in an assigned stockroom and not in another one.',
        active: true,
        failOnServerError: true,
    },
    (atf) => {
        const assigned = atf.server.recordInsert({
            $id: Now.ID['atf_itv_stockroom_assigned'],
            table: 'alm_stockroom',
            fieldValues: { x_daas_ham_stockroom_type: 'central_depot' },
        })
        const other = atf.server.recordInsert({
            $id: Now.ID['atf_itv_stockroom_other'],
            table: 'alm_stockroom',
            fieldValues: { x_daas_ham_stockroom_type: 'central_depot' },
        })
        atf.server.recordInsert({
            $id: Now.ID['atf_itv_asset_assigned'],
            table: 'alm_hardware',
            fieldValues: { serial_number: 'ATF-ITV-IN-0001', stockroom: assigned.record_id, install_status: 6, quantity: 1 },
        })
        atf.server.recordInsert({
            $id: Now.ID['atf_itv_asset_other'],
            table: 'alm_hardware',
            fieldValues: { serial_number: 'ATF-ITV-OUT-0001', stockroom: other.record_id, install_status: 6, quantity: 1 },
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
            table: 'x_daas_ham_stockroom_member',
            fieldValues: { user: tech.user, stockroom: assigned.record_id },
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
    },
)
