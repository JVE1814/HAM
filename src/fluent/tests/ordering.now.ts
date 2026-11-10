import '@servicenow/sdk/global'
import { Test, TestSuite } from '@servicenow/sdk/core'
import { assetManager } from '../security/roles.now'
import { inventoryTechAuditScanTest, inventoryTechAuditVisibilityTest } from './audit-visibility.now'
import { addToFleetTest } from './fleet.now'
import { lifecycleImportTest } from './models.now'
import { cancelRefusedOnceShippedTest } from './order-lifecycle.now'
import { sparePoolTopUpTest } from './spare-pool.now'
import { transferStageTest } from './transfers.now'
import { customerAdminVisibilityTest, inventoryTechVisibilityTest } from './visibility.now'
import { warehouseScanRulesTest } from './warehouse.now'
import { DEVICE_CLASS, INSTALL_MODE, ORDER_TYPE } from '../../server/domain/vocabulary'

// The vocabulary's values the fixtures below are created with, each under a name: for a value, a Test takes a
// name, but no property access (VOCABULARY.value).
const DEVICE_ADD = ORDER_TYPE.device_add
const FSM_ENGINEER = INSTALL_MODE.fsm_engineer
const SELF_INSTALL = INSTALL_MODE.self_install
const SWITCH = DEVICE_CLASS.switch
const FIREWALL = DEVICE_CLASS.firewall

/* ATF: order entitlement routing. */

export const withinAgreementOrderTest = Test(
    {
        $id: Now.ID['atf_order_within_agreement'],
        name: 'NaaS - an order within the agreement is approved and sourced',
        description: 'Submitting an order for a catalogued model within contracted quantities needs no approval.',
        active: true,
        failOnServerError: true,
    },
    (atf) => {
        const customer = atf.server.recordInsert({
            $id: Now.ID['atf_owa_customer'],
            table: 'customer_account',
            fieldValues: { name: 'ATF Order Customer', customer: true },
        })
        const site = atf.server.recordInsert({
            $id: Now.ID['atf_owa_site'],
            table: 'cmn_location',
            fieldValues: { name: 'ATF Order Site', x_daas_ham_is_site: true, company: customer.record_id },
        })
        // No stock holds the Model, so sourcing buys it, and Procurement refuses a line item for a Model without a Model
        // category. The platform's own Network Gear (base system data), looked up by name: no sys_id is written here.
        const category = atf.server.recordQuery({
            $id: Now.ID['atf_owa_category'],
            table: 'cmdb_model_category',
            fieldValues: 'name=Network Gear',
            assert: 'records_match_query',
        })
        const model = atf.server.recordInsert({
            $id: Now.ID['atf_owa_model'],
            table: 'cmdb_model',
            fieldValues: {
                name: 'ATF Switch',
                x_daas_ham_oem_pid: 'ATF-SW-48',
                x_daas_ham_device_class: SWITCH,
                cmdb_model_category: category.first_record,
            },
        })
        const agreement = atf.server.recordInsert({
            $id: Now.ID['atf_owa_agreement'],
            table: 'x_daas_ham_agreement',
            fieldValues: { customer: customer.record_id, short_description: 'ATF agreement', state: 'active', currency: 'EUR' },
        })
        atf.server.recordInsert({
            $id: Now.ID['atf_owa_quantity'],
            table: 'x_daas_ham_agreement_quantity',
            fieldValues: { agreement: agreement.record_id, device_class: SWITCH, contracted_quantity: 10 },
        })
        atf.server.recordInsert({
            $id: Now.ID['atf_owa_catalog'],
            table: 'x_daas_ham_catalog_entry',
            fieldValues: { customer: customer.record_id, entry_type: 'model', model: model.record_id, active: true },
        })
        const order = atf.server.recordInsert({
            $id: Now.ID['atf_owa_order'],
            table: 'x_daas_ham_order',
            fieldValues: {
                customer: customer.record_id,
                site: site.record_id,
                agreement: agreement.record_id,
                order_type: DEVICE_ADD,
                install_mode: FSM_ENGINEER,
                short_description: 'ATF within-agreement order',
            },
        })
        atf.server.recordInsert({
            $id: Now.ID['atf_owa_line'],
            table: 'x_daas_ham_order_line',
            fieldValues: { order: order.record_id, model: model.record_id, quantity: 2 },
        })
        atf.server.createUser({
            $id: Now.ID['atf_owa_user'],
            firstName: 'ATF',
            lastName: 'Asset Manager',
            roles: [assetManager],
        })
        atf.form.openExistingRecord({
            $id: Now.ID['atf_owa_open'],
            table: 'x_daas_ham_order',
            recordId: order.record_id,
        })
        atf.form.clickUIAction({
            $id: Now.ID['atf_owa_submit'],
            table: 'x_daas_ham_order',
            uiAction: Now.ref('sys_ui_action', 'ua_order_submit'),
            assert: 'form_submitted_to_server',
        })
        atf.server.recordValidation({
            $id: Now.ID['atf_owa_validate'],
            table: 'x_daas_ham_order',
            recordId: order.record_id,
            fieldValues: 'entitlement_verdict=within_agreement^approval=approved^stage!=awaiting_approval',
            assert: 'record_validated',
        })
    },
)

export const offCatalogOrderTest = Test(
    {
        $id: Now.ID['atf_order_off_catalog'],
        name: 'NaaS - an off-catalog order waits for approval',
        description: 'Submitting an order for a model outside the customer catalog requests approval.',
        active: true,
        failOnServerError: true,
    },
    (atf) => {
        const customer = atf.server.recordInsert({
            $id: Now.ID['atf_ooc_customer'],
            table: 'customer_account',
            fieldValues: { name: 'ATF Off-catalog Customer', customer: true },
        })
        const site = atf.server.recordInsert({
            $id: Now.ID['atf_ooc_site'],
            table: 'cmn_location',
            fieldValues: { name: 'ATF Off-catalog Site', x_daas_ham_is_site: true, company: customer.record_id },
        })
        const model = atf.server.recordInsert({
            $id: Now.ID['atf_ooc_model'],
            table: 'cmdb_model',
            fieldValues: { name: 'ATF Firewall', x_daas_ham_oem_pid: 'ATF-FW-1', x_daas_ham_device_class: FIREWALL },
        })
        const agreement = atf.server.recordInsert({
            $id: Now.ID['atf_ooc_agreement'],
            table: 'x_daas_ham_agreement',
            fieldValues: { customer: customer.record_id, short_description: 'ATF agreement', state: 'active', currency: 'EUR' },
        })
        const order = atf.server.recordInsert({
            $id: Now.ID['atf_ooc_order'],
            table: 'x_daas_ham_order',
            fieldValues: {
                customer: customer.record_id,
                site: site.record_id,
                agreement: agreement.record_id,
                order_type: DEVICE_ADD,
                install_mode: SELF_INSTALL,
                short_description: 'ATF off-catalog order',
            },
        })
        atf.server.recordInsert({
            $id: Now.ID['atf_ooc_line'],
            table: 'x_daas_ham_order_line',
            fieldValues: { order: order.record_id, model: model.record_id, quantity: 1 },
        })
        atf.server.createUser({
            $id: Now.ID['atf_ooc_user'],
            firstName: 'ATF',
            lastName: 'Asset Manager',
            roles: [assetManager],
        })
        atf.form.openExistingRecord({
            $id: Now.ID['atf_ooc_open'],
            table: 'x_daas_ham_order',
            recordId: order.record_id,
        })
        atf.form.clickUIAction({
            $id: Now.ID['atf_ooc_submit'],
            table: 'x_daas_ham_order',
            uiAction: Now.ref('sys_ui_action', 'ua_order_submit'),
            assert: 'form_submitted_to_server',
        })
        atf.server.recordValidation({
            $id: Now.ID['atf_ooc_validate'],
            table: 'x_daas_ham_order',
            recordId: order.record_id,
            fieldValues: 'entitlement_verdict=off_catalog^stage=awaiting_approval^approval=requested',
            assert: 'record_validated',
        })
    },
)

export const phase1Suite = TestSuite({
    $id: Now.ID['atf_suite_p1'],
    name: 'NaaS - P1',
    tests: [
        customerAdminVisibilityTest,
        inventoryTechVisibilityTest,
        inventoryTechAuditVisibilityTest,
        withinAgreementOrderTest,
        offCatalogOrderTest,
        transferStageTest,
        addToFleetTest,
        lifecycleImportTest,
        warehouseScanRulesTest,
        inventoryTechAuditScanTest,
        cancelRefusedOnceShippedTest,
        sparePoolTopUpTest,
    ],
})
