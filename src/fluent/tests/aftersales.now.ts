import '@servicenow/sdk/global'
import { Test, TestSuite } from '@servicenow/sdk/core'
import { assetManager, inventoryTech } from '../security/roles.now'

/* ATF: break-fix entitlement neutrality (D46) and depot evaluation routing (D60). */

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
        const model = atf.server.recordInsert({
            $id: Now.ID['atf_rwa_model'],
            table: 'cmdb_model',
            fieldValues: { name: 'ATF Legacy Switch', x_daas_ham_oem_pid: 'ATF-LEGACY-24', x_daas_ham_device_class: 'switch' },
        })
        const agreement = atf.server.recordInsert({
            $id: Now.ID['atf_rwa_agreement'],
            table: 'x_daas_ham_agreement',
            fieldValues: { customer: customer.record_id, short_description: 'ATF agreement', state: 'active' },
        })
        atf.server.recordInsert({
            $id: Now.ID['atf_rwa_quantity'],
            table: 'x_daas_ham_agreement_quantity',
            fieldValues: { agreement: agreement.record_id, device_class: 'switch', contracted_quantity: 1 },
        })
        const failed = atf.server.recordInsert({
            $id: Now.ID['atf_rwa_failed'],
            table: 'alm_hardware',
            fieldValues: {
                serial_number: 'ATF-RWA-FAILED',
                model: model.record_id,
                company: customer.record_id,
                install_status: 1,
                quantity: 1,
                x_daas_ham_agreement: agreement.record_id,
                x_daas_ham_site: site.record_id,
            },
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
        description: 'A received provider-owned unit evaluated "refurbish" becomes available and its line evaluated.',
        active: true,
        failOnServerError: true,
    },
    (atf) => {
        const customer = atf.server.recordInsert({
            $id: Now.ID['atf_rev_customer'],
            table: 'customer_account',
            fieldValues: { name: 'ATF Return Customer', customer: true },
        })
        const asset = atf.server.recordInsert({
            $id: Now.ID['atf_rev_asset'],
            table: 'alm_hardware',
            fieldValues: {
                serial_number: 'ATF-REV-0001',
                company: customer.record_id,
                install_status: 6,
                substatus: 'pending_evaluation',
                quantity: 1,
                x_daas_ham_legal_owner: 'provider',
            },
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
        atf.server.createUser({ $id: Now.ID['atf_rev_user'], firstName: 'ATF', lastName: 'Inventory Tech', roles: [inventoryTech] })
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
    tests: [replacementWithinAgreementTest, returnEvaluationTest],
})
