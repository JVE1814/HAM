import '@servicenow/sdk/global'
import { Test } from '@servicenow/sdk/core'
import { INSTALL_STATUS, LEASE_END_ACTION, STAGE_FIELDS, TASK_STATE } from '../../server/domain/vocabulary'
import { assetManager } from '../shared/roles.now'

/*
 * ATF: lessor ownership and lease extension (Q65; suite "NaaS - P3"). The lease rules act on fleet assets only
 * (ADR 0016), so the Assets here are fleet assets. Fixtures setting the Fleet flag insert without security enforcement:
 * the flag is read-only on forms, and the app's intake paths set it server-side.
 */

// The vocabulary's values the fixtures below are created with, each under a name: for a value, a Test takes a
// name, but no property access (VOCABULARY.value).
const IN_STOCK = INSTALL_STATUS.inStock
const AVAILABLE = STAGE_FIELDS.available.substatus
const EXTENDED_LEASE_FIELDS = `endsON2028-01-31@javascript:gs.dateGenerate('2028-01-31','start')@javascript:gs.dateGenerate('2028-01-31','end')^end_action=${LEASE_END_ACTION.undecided}`
const DECISION_CLOSED_FIELDS = `state=${TASK_STATE.closedComplete}`

export const leasedAssetOwnershipTest = Test(
    {
        $id: Now.ID['atf_leased_asset_owner'],
        name: 'NaaS - a fleet asset on a lease schedule is owned by its lessor',
        description: "Setting a fleet asset's lease schedule makes its legal owner the lessor, which is that schedule's vendor.",
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
                install_status: IN_STOCK,
                substatus: AVAILABLE,
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
            fieldValues: `x_daas_ham_legal_owner=lessor^x_daas_ham_lease.vendor=${lessor.record_id}`,
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
        // "on", as the condition builder writes it: Record Validation matches the loaded record against the condition,
        // and there a date `=` a literal day shifts by the session's time zone (west of UTC it matches the day after,
        // so `ends=2028-01-31` fails on an instance in America/Los_Angeles). "on" matches the day in every time zone.
        atf.server.recordValidation({
            $id: Now.ID['atf_lext_validate_lease'],
            table: 'x_daas_ham_lease_schedule',
            recordId: lease.record_id,
            fieldValues: EXTENDED_LEASE_FIELDS,
            assert: 'record_validated',
        })
        atf.server.recordValidation({
            $id: Now.ID['atf_lext_validate_decision'],
            table: 'x_daas_ham_lease_decision',
            recordId: decision.record_id,
            fieldValues: DECISION_CLOSED_FIELDS,
            assert: 'record_validated',
        })
    },
)
