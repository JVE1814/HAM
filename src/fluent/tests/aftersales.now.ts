import '@servicenow/sdk/global'
import { Test, TestSuite } from '@servicenow/sdk/core'
import { assetManager, inventoryTech } from '../security/roles.now'
import { customerReturnRequestTest } from './customer-returns.now'
import { lostInTransitResourcingTest } from './order-lifecycle.now'

/*
 * ATF: break-fix entitlement neutrality (Q46) and depot evaluation routing (Q60), on fleet assets: the app counts and
 * moves those only (ADR 0016). Fixtures setting the Fleet flag insert without security enforcement: the flag is
 * read-only on forms, and the app's intake paths set it server-side.
 */

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
                x_daas_ham_device_class: 'switch',
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
            fieldValues: { agreement: agreement.record_id, device_class: 'switch', contracted_quantity: 1 },
        })
        // In service under the Agreement, a fleet asset puts it at its cap of one switch: the usage counts fleet assets only.
        const failed = atf.server.recordInsert({
            $id: Now.ID['atf_rwa_failed'],
            table: 'alm_hardware',
            fieldValues: {
                serial_number: 'ATF-RWA-FAILED',
                model: model.record_id,
                company: customer.record_id,
                install_status: 1,
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
                order_type: 'device_replace',
                install_mode: 'fsm_engineer',
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
        // The tech sees only the Assets of their Stockrooms (ADR 0005), so the unit waits in a depot they work at.
        const depot = atf.server.recordInsert({
            $id: Now.ID['atf_rev_stockroom'],
            table: 'alm_stockroom',
            fieldValues: { name: 'ATF Return Depot', x_daas_ham_stockroom_type: 'central_depot' },
        })
        const asset = atf.server.recordInsert({
            $id: Now.ID['atf_rev_asset'],
            table: 'alm_hardware',
            fieldValues: {
                serial_number: 'ATF-REV-0001',
                stockroom: depot.record_id,
                company: customer.record_id,
                install_status: 6,
                substatus: 'pending_evaluation',
                quantity: 1,
                x_daas_ham_fleet: true,
                x_daas_ham_legal_owner: 'provider',
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
            table: 'x_daas_ham_stockroom_member',
            fieldValues: { user: tech.user, stockroom: depot.record_id },
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
            fieldValues: 'install_status=6^substatus=available',
            assert: 'record_validated',
        })
    },
)

export const phase2Suite = TestSuite({
    $id: Now.ID['atf_suite_p2'],
    name: 'NaaS - P2',
    tests: [replacementWithinAgreementTest, returnEvaluationTest, customerReturnRequestTest, lostInTransitResourcingTest],
})
