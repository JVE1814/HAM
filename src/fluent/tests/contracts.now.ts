import '@servicenow/sdk/global'
import { Test, TestSuite } from '@servicenow/sdk/core'
import { assetManager, finance } from '../security/roles.now'

/*
 * ATF: lessor ownership and lease extension (D65), billing period lock (D66), rack power budget (P3.29). The lease and
 * rack rules act on fleet assets only (ADR 0016), so the Assets here are fleet assets. Fixtures setting the Fleet flag
 * insert without security enforcement: the flag is read-only on forms, and the app's intake paths set it server-side.
 */

export const leasedAssetOwnershipTest = Test(
    {
        $id: Now.ID['atf_leased_asset_owner'],
        name: 'NaaS - a fleet asset on a lease schedule is owned by its lessor',
        description: "Setting a fleet asset's lease schedule makes its legal owner the lessor of that schedule.",
        active: true,
        failOnServerError: true,
    },
    (atf) => {
        const lessor = atf.server.recordInsert({
            $id: Now.ID['atf_lao_lessor'],
            table: 'core_company',
            fieldValues: { name: 'ATF Leasing Ltd', vendor: true },
        })
        // Lease schedules extend ast_contract, whose before rule "Verify contract's start and end dates" refuses an end
        // date without a start date (or before it).
        const lease = atf.server.recordInsert({
            $id: Now.ID['atf_lao_lease'],
            table: 'x_daas_ham_lease_schedule',
            fieldValues: { vendor: lessor.record_id, vendor_contract: 'ATF-LS-1', short_description: 'ATF lease', starts: '2024-07-01', ends: '2027-06-30' },
        })
        const asset = atf.server.recordInsert({
            $id: Now.ID['atf_lao_asset'],
            table: 'alm_hardware',
            fieldValues: {
                serial_number: 'ATF-LAO-0001',
                install_status: 6,
                substatus: 'available',
                quantity: 1,
                x_daas_ham_fleet: true,
                x_daas_ham_lease: lease.record_id,
            },
            enforceSecurity: false,
        })
        atf.server.recordValidation({
            $id: Now.ID['atf_lao_validate'],
            table: 'alm_hardware',
            recordId: asset.record_id,
            fieldValues: `x_daas_ham_legal_owner=lessor^x_daas_ham_lessor=${lessor.record_id}`,
            assert: 'record_validated',
        })
    },
)

export const leaseExtensionTest = Test(
    {
        $id: Now.ID['atf_lease_extension'],
        name: 'NaaS - extending a lease moves its end date and closes the decision',
        description: 'Apply decision with "extend" and a later end date updates the lease and closes the task.',
        active: true,
        failOnServerError: true,
    },
    (atf) => {
        const lessor = atf.server.recordInsert({
            $id: Now.ID['atf_lext_lessor'],
            table: 'core_company',
            fieldValues: { name: 'ATF Extension Leasing', vendor: true },
        })
        const lease = atf.server.recordInsert({
            $id: Now.ID['atf_lext_lease'],
            table: 'x_daas_ham_lease_schedule',
            // A start date too: ast_contract refuses an end date without one (see the test above).
            fieldValues: {
                vendor: lessor.record_id,
                vendor_contract: 'ATF-LS-2',
                short_description: 'ATF lease to extend',
                starts: '2024-02-01',
                ends: '2027-01-31',
            },
        })
        const decision = atf.server.recordInsert({
            $id: Now.ID['atf_lext_decision'],
            table: 'x_daas_ham_lease_decision',
            fieldValues: { lease: lease.record_id, lease_end: '2027-01-31', decision: 'extend', new_end_date: '2028-01-31', short_description: 'ATF decision' },
        })
        atf.server.createUser({ $id: Now.ID['atf_lext_user'], firstName: 'ATF', lastName: 'Lease Manager', roles: [assetManager] })
        atf.form.openExistingRecord({ $id: Now.ID['atf_lext_open'], table: 'x_daas_ham_lease_decision', recordId: decision.record_id })
        atf.form.clickUIAction({
            $id: Now.ID['atf_lext_apply'],
            table: 'x_daas_ham_lease_decision',
            uiAction: Now.ref('sys_ui_action', 'ua_lease_apply_decision'),
            assert: 'form_submitted_to_server',
        })
        atf.server.recordValidation({
            $id: Now.ID['atf_lext_validate_lease'],
            table: 'x_daas_ham_lease_schedule',
            recordId: lease.record_id,
            fieldValues: 'ends=2028-01-31^end_action=undecided',
            assert: 'record_validated',
        })
        atf.server.recordValidation({
            $id: Now.ID['atf_lext_validate_decision'],
            table: 'x_daas_ham_lease_decision',
            recordId: decision.record_id,
            fieldValues: 'state=3',
            assert: 'record_validated',
        })
    },
)

export const closedBillingPeriodLockedTest = Test(
    {
        $id: Now.ID['atf_billing_locked'],
        name: 'NaaS - lines of a closed billing period cannot change',
        description: 'Updating a billing line of a closed period is refused.',
        active: true,
        failOnServerError: false,
    },
    (atf) => {
        const customer = atf.server.recordInsert({
            $id: Now.ID['atf_bl_customer'],
            table: 'customer_account',
            fieldValues: { name: 'ATF Billing Customer', customer: true },
        })
        const period = atf.server.recordInsert({
            $id: Now.ID['atf_bl_period'],
            table: 'x_daas_ham_billing_period',
            fieldValues: { period: '1999-01', status: 'closed' },
        })
        const line = atf.server.recordInsert({
            $id: Now.ID['atf_bl_line'],
            table: 'x_daas_ham_billing_line',
            fieldValues: { billing_period: period.record_id, kind: 'subscription', customer: customer.record_id, description: 'ATF line', amount: 100 },
        })
        atf.server.createUser({ $id: Now.ID['atf_bl_user'], firstName: 'ATF', lastName: 'Finance', roles: [finance] })
        atf.server.recordUpdate({
            $id: Now.ID['atf_bl_update'],
            table: 'x_daas_ham_billing_line',
            recordId: line.record_id,
            fieldValues: { amount: 1 },
            assert: 'record_not_updated',
        })
        atf.server.recordValidation({
            $id: Now.ID['atf_bl_validate'],
            table: 'x_daas_ham_billing_line',
            recordId: line.record_id,
            fieldValues: 'amount=100',
            assert: 'record_validated',
        })
    },
)

export const rackPowerBudgetTest = Test(
    {
        $id: Now.ID['atf_rack_power'],
        name: 'NaaS - a placement over the rack power budget is refused',
        description: 'Two 80 W fleet devices do not fit a 100 W rack: the second placement is not saved.',
        active: true,
        failOnServerError: false,
    },
    (atf) => {
        const model = atf.server.recordInsert({
            $id: Now.ID['atf_rp_model'],
            table: 'cmdb_model',
            fieldValues: { name: 'ATF 80 W switch', x_daas_ham_oem_pid: 'ATF-80W', x_daas_ham_device_class: 'switch', power_consumption: 80 },
        })
        const rack = atf.server.recordInsert({
            $id: Now.ID['atf_rp_rack'],
            table: 'cmdb_ci_rack',
            fieldValues: { name: 'ATF-RACK-100W', rack_units: 42, x_daas_ham_power_capacity_w: 100 },
        })
        atf.server.recordInsert({
            $id: Now.ID['atf_rp_first'],
            table: 'alm_hardware',
            fieldValues: {
                serial_number: 'ATF-RP-0001',
                model: model.record_id,
                install_status: 1,
                quantity: 1,
                x_daas_ham_fleet: true,
                x_daas_ham_rack: rack.record_id,
                x_daas_ham_ru_start: 40,
                x_daas_ham_rack_face: 'front',
            },
            enforceSecurity: false,
        })
        const second = atf.server.recordInsert({
            $id: Now.ID['atf_rp_second'],
            table: 'alm_hardware',
            fieldValues: { serial_number: 'ATF-RP-0002', model: model.record_id, install_status: 1, quantity: 1, x_daas_ham_fleet: true },
            enforceSecurity: false,
        })
        atf.server.recordUpdate({
            $id: Now.ID['atf_rp_place'],
            table: 'alm_hardware',
            recordId: second.record_id,
            fieldValues: { x_daas_ham_rack: rack.record_id, x_daas_ham_ru_start: 30, x_daas_ham_rack_face: 'rear' },
            assert: 'record_not_updated',
        })
    },
)

export const phase3Suite = TestSuite({
    $id: Now.ID['atf_suite_p3'],
    name: 'NaaS - P3',
    tests: [leasedAssetOwnershipTest, leaseExtensionTest, closedBillingPeriodLockedTest, rackPowerBudgetTest],
})
