import '@servicenow/sdk/global'
import { Test } from '@servicenow/sdk/core'
import { DEVICE_CLASS, INSTALL_MODE, INSTALL_STATUS, ORDER_TYPE } from '../../server/domain/vocabulary'
import { assetManager } from '../shared/roles.now'

/*
 * Fixtures setting the Fleet flag insert without security enforcement: the flag is read-only on forms,
 * and the app's intake paths set it server-side.
 */

// The vocabulary's values the fixtures below are created with, each under a name: for a value, a Test takes a
// name, but no property access (VOCABULARY.value).
const IN_USE = INSTALL_STATUS.inUse
const DEVICE_REPLACE = ORDER_TYPE.device_replace
const FSM_ENGINEER = INSTALL_MODE.fsm_engineer
const SWITCH = DEVICE_CLASS.switch

export const replacementWithinAgreementTest = Test(
    {
        $id: Now.ID['atf_replacement_within_agreement'],
        name: 'NaaS - a like-for-like replacement needs no approval',
        description: 'A device-replace order for an uncatalogued model at its contracted cap is still within the agreement.',
        active: true,
        failOnServerError: true,
    },
    (atf) => {
        const customer = atf.server.recordInsert({
            $id: Now.ID['atf_rwa_customer'],
            table: 'customer_account',
            fieldValues: { name: 'ATF Replacement Customer', customer: true },
        })
        const site = atf.server.recordInsert({
            $id: Now.ID['atf_rwa_site'],
            table: 'cmn_location',
            fieldValues: { name: 'ATF Replacement Site', x_daas_ham_is_site: true, company: customer.record_id },
        })
        // Sourcing buys the replacement (no stock holds the Model, and the failed unit has no OEM coverage), and
        // Procurement refuses a line item for a Model without a Model category: Network Gear, looked up by name.
        const category = atf.server.recordQuery({
            $id: Now.ID['atf_rwa_category'],
            table: 'cmdb_model_category',
            fieldValues: 'name=Network Gear',
            assert: 'records_match_query',
        })
        const model = atf.server.recordInsert({
            $id: Now.ID['atf_rwa_model'],
            table: 'cmdb_model',
            fieldValues: {
                name: 'ATF Legacy Switch',
                x_daas_ham_oem_pid: 'ATF-LEGACY-24',
                x_daas_ham_device_class: SWITCH,
                cmdb_model_category: category.first_record,
            },
        })
        const agreement = atf.server.recordInsert({
            $id: Now.ID['atf_rwa_agreement'],
            table: 'x_daas_ham_agreement',
            fieldValues: { customer: customer.record_id, short_description: 'ATF agreement', state: 'active', currency: 'EUR' },
        })
        atf.server.recordInsert({
            $id: Now.ID['atf_rwa_quantity'],
            table: 'x_daas_ham_agreement_quantity',
            fieldValues: { agreement: agreement.record_id, device_class: SWITCH, contracted_quantity: 1 },
        })
        // In service under the Agreement, a fleet asset puts it at its cap of one switch: the usage counts fleet assets only.
        const failed = atf.server.recordInsert({
            $id: Now.ID['atf_rwa_failed'],
            table: 'alm_hardware',
            fieldValues: {
                serial_number: 'ATF-RWA-FAILED',
                model: model.record_id,
                company: customer.record_id,
                install_status: IN_USE,
                quantity: 1,
                x_daas_ham_fleet: true,
                x_daas_ham_agreement: agreement.record_id,
                x_daas_ham_site: site.record_id,
            },
            enforceSecurity: false,
        })
        const order = atf.server.recordInsert({
            $id: Now.ID['atf_rwa_order'],
            table: 'x_daas_ham_order',
            fieldValues: {
                customer: customer.record_id,
                site: site.record_id,
                agreement: agreement.record_id,
                order_type: DEVICE_REPLACE,
                install_mode: FSM_ENGINEER,
                short_description: 'ATF replacement',
            },
        })
        atf.server.recordInsert({
            $id: Now.ID['atf_rwa_line'],
            table: 'x_daas_ham_order_line',
            fieldValues: { order: order.record_id, model: model.record_id, quantity: 1, replaces_asset: failed.record_id },
        })
        atf.server.createUser({ $id: Now.ID['atf_rwa_user'], firstName: 'ATF', lastName: 'Asset Manager', roles: [assetManager] })
        atf.form.openExistingRecord({ $id: Now.ID['atf_rwa_open'], table: 'x_daas_ham_order', recordId: order.record_id })
        atf.form.clickUIAction({
            $id: Now.ID['atf_rwa_submit'],
            table: 'x_daas_ham_order',
            uiAction: Now.ref('sys_ui_action', 'ua_order_submit'),
            assert: 'form_submitted_to_server',
        })
        atf.server.recordValidation({
            $id: Now.ID['atf_rwa_validate'],
            table: 'x_daas_ham_order',
            recordId: order.record_id,
            fieldValues: 'entitlement_verdict=within_agreement^approval=approved',
            assert: 'record_validated',
        })
    },
)
