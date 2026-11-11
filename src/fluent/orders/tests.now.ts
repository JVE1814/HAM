import '@servicenow/sdk/global'
import { Test } from '@servicenow/sdk/core'
import {
    DEVICE_CLASS,
    INSTALL_MODE,
    INSTALL_STATUS,
    LEGAL_OWNER,
    LINE_STAGE,
    ORDER_STAGE,
    ORDER_TYPE,
    RMA_STATE,
    STAGE_FIELDS,
    STOCKROOM_TYPE,
} from '../../server/domain/vocabulary'
import { assetManager, inventoryTech } from '../shared/roles.now'

// The vocabulary's values the fixtures below are created with, each under a name: for a value, a Test takes a
// name, but no property access (VOCABULARY.value).
const DEVICE_ADD = ORDER_TYPE.device_add
const FSM_ENGINEER = INSTALL_MODE.fsm_engineer
const SELF_INSTALL = INSTALL_MODE.self_install
const SWITCH = DEVICE_CLASS.switch
const FIREWALL = DEVICE_CLASS.firewall
const IN_USE = INSTALL_STATUS.inUse
const IN_TRANSIT = INSTALL_STATUS.inTransit
const MISSING = INSTALL_STATUS.missing
const SHIPPED_TO_SITE = STAGE_FIELDS.shipped.substatus
const LOST = STAGE_FIELDS.missing.substatus
const DEVICE_REPLACE = ORDER_TYPE.device_replace
const ORDER_SOURCING = ORDER_STAGE.sourcing
const ORDER_PREPARING = ORDER_STAGE.preparing
const ORDER_DELIVERING = ORDER_STAGE.delivering
const LINE_AWAITING_STOCK = LINE_STAGE.awaiting_stock
const LINE_READY_TO_SHIP = LINE_STAGE.ready_to_ship
const LINE_SHIPPED = LINE_STAGE.shipped
const REPLACEMENT_RECEIVED = RMA_STATE.replacement_received
const PROVIDER_OWNED = LEGAL_OWNER.provider
const IN_STOCK = INSTALL_STATUS.inStock
const AVAILABLE = STAGE_FIELDS.available.substatus
const CENTRAL_DEPOT = STOCKROOM_TYPE.central_depot

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

/*
 * ATF: two owner decisions on Orders that the domain tests pin, here on the instance: a break-fix unit lost in transit
 * fills its line again under the same OEM RMA and the Order's approval, and Cancel order is refused
 * once anything has shipped. The fixtures stand where Ship and sourcing leave an Order (stages,
 * approval, entitlement and the Fleet flag are read-only on forms), so they insert without security enforcement.
 */

export const lostInTransitResourcingTest = Test(
    {
        $id: Now.ID['atf_lost_in_transit_resourcing'],
        name: 'NaaS - a replacement lost in transit is sourced again under its RMA and approval',
        description:
            "Declares missing the OEM replacement shipped on an approved break-fix line: the unit comes off the line, which goes back to awaiting stock with its quantity, and the sourcing pass reopens the line's own RMA to ask the vendor for another; no second RMA and no approval request are raised, and the Order stays approved within its agreement.",
        active: true,
        // The sourcing pass logs what it does; the validations below check the outcome.
        failOnServerError: false,
    },
    (atf) => {
        const customer = atf.server.recordInsert({
            $id: Now.ID['atf_lit_customer'],
            table: 'customer_account',
            fieldValues: { name: 'ATF Lost In Transit Customer', customer: true },
        })
        const site = atf.server.recordInsert({
            $id: Now.ID['atf_lit_site'],
            table: 'cmn_location',
            fieldValues: { name: 'ATF Lost In Transit Site', x_daas_ham_is_site: true, company: customer.record_id },
        })
        // A Model no stock holds, so the pass finds none to pick and routes the line to the OEM.
        const model = atf.server.recordInsert({
            $id: Now.ID['atf_lit_model'],
            table: 'cmdb_model',
            fieldValues: { name: 'ATF Lost In Transit Switch', x_daas_ham_oem_pid: 'ATF-LIT-24', x_daas_ham_device_class: SWITCH },
        })
        const agreement = atf.server.recordInsert({
            $id: Now.ID['atf_lit_agreement'],
            table: 'x_daas_ham_agreement',
            fieldValues: { customer: customer.record_id, short_description: 'ATF lost in transit agreement', state: 'active', currency: 'EUR' },
        })
        // The failed unit, still in service and under OEM coverage, so its shortfall goes to an advance replacement.
        const failed = atf.server.recordInsert({
            $id: Now.ID['atf_lit_failed'],
            table: 'alm_hardware',
            fieldValues: {
                serial_number: 'ATF-LIT-FAILED',
                model: model.record_id,
                company: customer.record_id,
                install_status: IN_USE,
                quantity: 1,
                x_daas_ham_fleet: true,
                x_daas_ham_agreement: agreement.record_id,
                x_daas_ham_site: site.record_id,
                x_daas_ham_coverage_end: '2099-12-31',
            },
            enforceSecurity: false,
        })
        const order = atf.server.recordInsert({
            $id: Now.ID['atf_lit_order'],
            table: 'x_daas_ham_order',
            fieldValues: {
                customer: customer.record_id,
                site: site.record_id,
                agreement: agreement.record_id,
                order_type: DEVICE_REPLACE,
                install_mode: FSM_ENGINEER,
                short_description: 'ATF lost in transit order',
                stage: ORDER_DELIVERING,
                approval: 'approved',
                entitlement_verdict: 'within_agreement',
            },
            enforceSecurity: false,
        })
        const line = atf.server.recordInsert({
            $id: Now.ID['atf_lit_line'],
            table: 'x_daas_ham_order_line',
            fieldValues: { order: order.record_id, model: model.record_id, quantity: 1, replaces_asset: failed.record_id, line_stage: LINE_SHIPPED },
            enforceSecurity: false,
        })
        const rma = atf.server.recordInsert({
            $id: Now.ID['atf_lit_rma'],
            table: 'x_daas_ham_oem_rma',
            fieldValues: {
                vendor: 'cisco',
                rma_number: 'ATF-RMA-0001',
                defective_asset: failed.record_id,
                order_line: line.record_id,
                state: REPLACEMENT_RECEIVED,
                replacement_serial: 'ATF-LIT-REPL',
            },
            enforceSecurity: false,
        })
        const replacement = atf.server.recordInsert({
            $id: Now.ID['atf_lit_replacement'],
            table: 'alm_hardware',
            fieldValues: {
                serial_number: 'ATF-LIT-REPL',
                model: model.record_id,
                company: customer.record_id,
                install_status: IN_TRANSIT,
                substatus: SHIPPED_TO_SITE,
                quantity: 1,
                x_daas_ham_fleet: true,
                x_daas_ham_legal_owner: PROVIDER_OWNED,
                x_daas_ham_order_line: line.record_id,
                x_daas_ham_agreement: agreement.record_id,
                x_daas_ham_site: site.record_id,
            },
            enforceSecurity: false,
        })
        atf.server.createUser({ $id: Now.ID['atf_lit_user'], firstName: 'ATF', lastName: 'Lost In Transit Manager', roles: [assetManager] })
        atf.server.recordUpdate({
            $id: Now.ID['atf_lit_declare_missing'],
            table: 'alm_hardware',
            recordId: replacement.record_id,
            fieldValues: { install_status: MISSING, substatus: LOST },
            assert: 'record_successfully_updated',
        })
        atf.server.recordValidation({
            $id: Now.ID['atf_lit_validate_off_line'],
            table: 'alm_hardware',
            recordId: replacement.record_id,
            fieldValues: 'install_status=8^substatus=lost^x_daas_ham_order_lineISEMPTY',
            assert: 'record_validated',
        })
        // Filled again: the line left Shipped. The save also queued its Order's sourcing (below), which the event
        // processor may run before this step and save the line as sourced; a pass sources only lines that are new or
        // awaiting stock, so either stage shows the line was reopened. Off the line (above) and the same RMA reopened
        // (below) are what the queued pass cannot change.
        atf.server.recordValidation({
            $id: Now.ID['atf_lit_validate_refilled'],
            table: 'x_daas_ham_order_line',
            recordId: line.record_id,
            fieldValues: `line_stageINawaiting_stock,sourced^quantity=1^replaces_asset=${failed.record_id}`,
            assert: 'record_validated',
        })
        // The save queued the Order's sourcing; the pass runs here, as its
        // script action runs it, so the test does not wait on the event queue. A pass the queued event runs first
        // leaves this one nothing to do, and the same outcome; one it is still running holds the Order's lock, so this
        // one waits for the RMA to be reopened, 20 seconds at most.
        atf.server.runServerSideScript({
            $id: Now.ID['atf_lit_source_again'],
            script: `(function (outputs, steps, params, stepResult, assertEqual) {
    var orders = require('x_daas_ham/naas-ham/0.1.0/src/server/entry/orders.ts');
    function reopened() {
        var rma = new GlideRecord('x_daas_ham_oem_rma');
        rma.addQuery('rma_number', 'ATF-RMA-0001');
        rma.addQuery('state', 'open');
        rma.query();
        return rma.hasNext();
    }
    try {
        var order = new GlideRecord('x_daas_ham_order');
        order.addQuery('short_description', 'ATF lost in transit order');
        order.query();
        if (!order.next()) throw new Error('no Order ATF lost in transit order');
        var queued = { getValue: function (field) { return field === 'parm2' ? '0' : ''; } };
        orders.sourceOrder(queued, order);
        var until = new Date().getTime() + 20000;
        while (!reopened()) {
            if (new Date().getTime() > until) throw new Error('No sourcing pass reopened RMA ATF-RMA-0001 within 20 s');
            var next = new Date().getTime() + 250;
            while (new Date().getTime() < next) { /* a pass the queued event started holds the Order lock */ }
        }
        stepResult.setOutputMessage('Sourced ' + order.getValue('number') + ' again');
        return true;
    } catch (e) {
        stepResult.setOutputMessage(String(e && e.message ? e.message : e));
        return false;
    }
})(outputs, steps, params, stepResult, assertEqual);`,
        })
        atf.server.recordValidation({
            $id: Now.ID['atf_lit_validate_rma'],
            table: 'x_daas_ham_oem_rma',
            recordId: rma.record_id,
            fieldValues: `state=open^order_line=${line.record_id}^rma_number=ATF-RMA-0001`,
            assert: 'record_validated',
        })
        atf.server.recordQuery({
            $id: Now.ID['atf_lit_no_second_rma'],
            table: 'x_daas_ham_oem_rma',
            fieldValues: `defective_asset=${failed.record_id}^sys_id!=${rma.record_id}`,
            assert: 'no_records_match_query',
        })
        atf.server.recordValidation({
            $id: Now.ID['atf_lit_validate_line_sourced'],
            table: 'x_daas_ham_order_line',
            recordId: line.record_id,
            fieldValues: 'line_stageINawaiting_stock,sourced^quantity=1^quantity_to_purchase=0^sourcing_summaryLIKEATF-RMA-0001',
            assert: 'record_validated',
        })
        atf.server.recordValidation({
            $id: Now.ID['atf_lit_validate_order'],
            table: 'x_daas_ham_order',
            recordId: order.record_id,
            fieldValues: 'approval=approved^entitlement_verdict=within_agreement^stageNOT INawaiting_approval,cancelled,rejected',
            assert: 'record_validated',
        })
        atf.server.recordQuery({
            $id: Now.ID['atf_lit_no_approval_asked'],
            table: 'sysapproval_approver',
            fieldValues: `sysapproval=${order.record_id}`,
            assert: 'no_records_match_query',
        })
    },
)

export const cancelRefusedOnceShippedTest = Test(
    {
        $id: Now.ID['atf_cancel_refused_once_shipped'],
        name: 'NaaS - Cancel order is refused once equipment has shipped',
        description:
            'Cancel order on an Order partly shipped (one unit of a two-unit line sent, the line not delivered whole) leaves the Order preparing, its line ready to ship and the unit on it; the same action on an Order with nothing shipped cancels it and its line.',
        active: true,
        // The refusal is the expected path, and shows an error message; the validations below check the outcome.
        failOnServerError: false,
    },
    (atf) => {
        const customer = atf.server.recordInsert({
            $id: Now.ID['atf_cro_customer'],
            table: 'customer_account',
            fieldValues: { name: 'ATF Cancel Customer', customer: true },
        })
        const site = atf.server.recordInsert({
            $id: Now.ID['atf_cro_site'],
            table: 'cmn_location',
            fieldValues: { name: 'ATF Cancel Site', x_daas_ham_is_site: true, company: customer.record_id },
        })
        const model = atf.server.recordInsert({
            $id: Now.ID['atf_cro_model'],
            table: 'cmdb_model',
            fieldValues: { name: 'ATF Cancel Switch', x_daas_ham_oem_pid: 'ATF-CAN-24', x_daas_ham_device_class: SWITCH },
        })
        const agreement = atf.server.recordInsert({
            $id: Now.ID['atf_cro_agreement'],
            table: 'x_daas_ham_agreement',
            fieldValues: { customer: customer.record_id, short_description: 'ATF cancel agreement', state: 'active', currency: 'EUR' },
        })
        const shippedOrder = atf.server.recordInsert({
            $id: Now.ID['atf_cro_shipped_order'],
            table: 'x_daas_ham_order',
            fieldValues: {
                customer: customer.record_id,
                site: site.record_id,
                agreement: agreement.record_id,
                order_type: DEVICE_ADD,
                install_mode: FSM_ENGINEER,
                short_description: 'ATF shipped order',
                stage: ORDER_PREPARING,
                approval: 'approved',
                entitlement_verdict: 'within_agreement',
            },
            enforceSecurity: false,
        })
        const shippedLine = atf.server.recordInsert({
            $id: Now.ID['atf_cro_shipped_line'],
            table: 'x_daas_ham_order_line',
            // A partial Ship: one of its two units sent, so only that unit says the Order has shipped.
            fieldValues: { order: shippedOrder.record_id, model: model.record_id, quantity: 2, line_stage: LINE_READY_TO_SHIP },
            enforceSecurity: false,
        })
        const shippedUnit = atf.server.recordInsert({
            $id: Now.ID['atf_cro_shipped_unit'],
            table: 'alm_hardware',
            fieldValues: {
                serial_number: 'ATF-CAN-SHIPPED',
                model: model.record_id,
                company: customer.record_id,
                install_status: IN_TRANSIT,
                substatus: SHIPPED_TO_SITE,
                quantity: 1,
                x_daas_ham_fleet: true,
                x_daas_ham_legal_owner: PROVIDER_OWNED,
                x_daas_ham_order_line: shippedLine.record_id,
                x_daas_ham_agreement: agreement.record_id,
                x_daas_ham_site: site.record_id,
            },
            enforceSecurity: false,
        })
        // The control: alike, but nothing sourced or shipped yet.
        const openOrder = atf.server.recordInsert({
            $id: Now.ID['atf_cro_open_order'],
            table: 'x_daas_ham_order',
            fieldValues: {
                customer: customer.record_id,
                site: site.record_id,
                agreement: agreement.record_id,
                order_type: DEVICE_ADD,
                install_mode: FSM_ENGINEER,
                short_description: 'ATF unshipped order',
                stage: ORDER_SOURCING,
                approval: 'approved',
                entitlement_verdict: 'within_agreement',
            },
            enforceSecurity: false,
        })
        const openLine = atf.server.recordInsert({
            $id: Now.ID['atf_cro_open_line'],
            table: 'x_daas_ham_order_line',
            fieldValues: { order: openOrder.record_id, model: model.record_id, quantity: 1, line_stage: LINE_AWAITING_STOCK },
            enforceSecurity: false,
        })
        atf.server.createUser({ $id: Now.ID['atf_cro_user'], firstName: 'ATF', lastName: 'Cancel Manager', roles: [assetManager] })
        atf.form.openExistingRecord({ $id: Now.ID['atf_cro_open_shipped'], table: 'x_daas_ham_order', recordId: shippedOrder.record_id })
        atf.form.clickUIAction({
            $id: Now.ID['atf_cro_cancel_shipped'],
            table: 'x_daas_ham_order',
            uiAction: Now.ref('sys_ui_action', 'ua_order_cancel'),
            assert: 'form_submitted_to_server',
        })
        atf.server.recordValidation({
            $id: Now.ID['atf_cro_validate_shipped_order'],
            table: 'x_daas_ham_order',
            recordId: shippedOrder.record_id,
            fieldValues: 'stage=preparing^state!=7',
            assert: 'record_validated',
        })
        atf.server.recordValidation({
            $id: Now.ID['atf_cro_validate_shipped_line'],
            table: 'x_daas_ham_order_line',
            recordId: shippedLine.record_id,
            fieldValues: 'line_stage=ready_to_ship^quantity=2',
            assert: 'record_validated',
        })
        atf.server.recordValidation({
            $id: Now.ID['atf_cro_validate_shipped_unit'],
            table: 'alm_hardware',
            recordId: shippedUnit.record_id,
            fieldValues: `install_status=9^substatus=shipped_to_site^x_daas_ham_order_line=${shippedLine.record_id}`,
            assert: 'record_validated',
        })
        atf.form.openExistingRecord({ $id: Now.ID['atf_cro_open_unshipped'], table: 'x_daas_ham_order', recordId: openOrder.record_id })
        atf.form.clickUIAction({
            $id: Now.ID['atf_cro_cancel_unshipped'],
            table: 'x_daas_ham_order',
            uiAction: Now.ref('sys_ui_action', 'ua_order_cancel'),
            assert: 'form_submitted_to_server',
        })
        atf.server.recordValidation({
            $id: Now.ID['atf_cro_validate_open_order'],
            table: 'x_daas_ham_order',
            recordId: openOrder.record_id,
            fieldValues: 'stage=cancelled^state=7',
            assert: 'record_validated',
        })
        atf.server.recordValidation({
            $id: Now.ID['atf_cro_validate_open_line'],
            table: 'x_daas_ham_order_line',
            recordId: openLine.record_id,
            fieldValues: 'line_stage=cancelled',
            assert: 'record_validated',
        })
    },
)

/*
 * One Spare pool
 * per Customer and Model, sized from all their deployed fleet units of it across their Agreements, each Agreement's
 * ratio on its own units, rounded up once (owner decision). Here 2 units at 0.2 and 2 at
 * 0.3 make a pool of ceil(1.0) = 1; rounding per Agreement would make it ceil(0.4) + ceil(0.6) = 2. The job runs over
 * every Customer's pools on the instance, as its daily run does; ATF rolls its changes back with the test's. A script
 * cannot read an earlier step's output, so it finds the fixtures by their serial numbers. Fixtures setting the Fleet
 * flag insert without security enforcement: the flag is read-only on forms.
 */

export const sparePoolTopUpTest = Test(
    {
        $id: Now.ID['atf_spare_pool_top_up'],
        name: 'NaaS - the spare-pool top-up fills one pool per Customer and Model across their Agreements',
        description:
            "Runs the spare-pool top-up job for a Customer with two Agreements (spare-pool ratios 0.2 and 0.3), each with two deployed fleet units of one Model, and two free units of it in a central depot: one unit moves into the Customer's Spare pool, carrying the Agreement with the larger share, and the other stays available.",
        active: true,
        // The job logs what it does for every pool on the instance; the validations below check the fixture's.
        failOnServerError: false,
    },
    (atf) => {
        const customer = atf.server.recordInsert({
            $id: Now.ID['atf_spt_customer'],
            table: 'customer_account',
            fieldValues: { name: 'ATF Spare Pool Customer', customer: true },
        })
        const site = atf.server.recordInsert({
            $id: Now.ID['atf_spt_site'],
            table: 'cmn_location',
            fieldValues: { name: 'ATF Spare Pool Site', x_daas_ham_is_site: true, company: customer.record_id },
        })
        // The top-up buys what stock does not cover when auto-purchase is on, and Procurement refuses a line item for a
        // Model without a Model category: the platform's Network Gear, looked up by name.
        const category = atf.server.recordQuery({
            $id: Now.ID['atf_spt_category'],
            table: 'cmdb_model_category',
            fieldValues: 'name=Network Gear',
            assert: 'records_match_query',
        })
        const model = atf.server.recordInsert({
            $id: Now.ID['atf_spt_model'],
            table: 'cmdb_model',
            fieldValues: {
                name: 'ATF Spare Pool Switch',
                x_daas_ham_oem_pid: 'ATF-SPT-24',
                x_daas_ham_device_class: SWITCH,
                cmdb_model_category: category.first_record,
            },
        })
        const smaller = atf.server.recordInsert({
            $id: Now.ID['atf_spt_agreement_small'],
            table: 'x_daas_ham_agreement',
            fieldValues: {
                customer: customer.record_id,
                short_description: 'ATF spare pool agreement 0.2',
                state: 'active',
                currency: 'EUR',
                spare_pool_ratio: 0.2,
            },
        })
        const larger = atf.server.recordInsert({
            $id: Now.ID['atf_spt_agreement_large'],
            table: 'x_daas_ham_agreement',
            fieldValues: {
                customer: customer.record_id,
                short_description: 'ATF spare pool agreement 0.3',
                state: 'active',
                currency: 'EUR',
                spare_pool_ratio: 0.3,
            },
        })
        const depot = atf.server.recordInsert({
            $id: Now.ID['atf_spt_depot'],
            table: 'alm_stockroom',
            fieldValues: { name: 'ATF Spare Pool Depot', x_daas_ham_stockroom_type: CENTRAL_DEPOT },
        })
        atf.server.recordInsert({
            $id: Now.ID['atf_spt_live_small_1'],
            table: 'alm_hardware',
            fieldValues: {
                serial_number: 'ATF-SPT-LIVE-S1',
                model: model.record_id,
                company: customer.record_id,
                install_status: IN_USE,
                quantity: 1,
                x_daas_ham_fleet: true,
                x_daas_ham_legal_owner: PROVIDER_OWNED,
                x_daas_ham_agreement: smaller.record_id,
                x_daas_ham_site: site.record_id,
            },
            enforceSecurity: false,
        })
        atf.server.recordInsert({
            $id: Now.ID['atf_spt_live_small_2'],
            table: 'alm_hardware',
            fieldValues: {
                serial_number: 'ATF-SPT-LIVE-S2',
                model: model.record_id,
                company: customer.record_id,
                install_status: IN_USE,
                quantity: 1,
                x_daas_ham_fleet: true,
                x_daas_ham_legal_owner: PROVIDER_OWNED,
                x_daas_ham_agreement: smaller.record_id,
                x_daas_ham_site: site.record_id,
            },
            enforceSecurity: false,
        })
        atf.server.recordInsert({
            $id: Now.ID['atf_spt_live_large_1'],
            table: 'alm_hardware',
            fieldValues: {
                serial_number: 'ATF-SPT-LIVE-L1',
                model: model.record_id,
                company: customer.record_id,
                install_status: IN_USE,
                quantity: 1,
                x_daas_ham_fleet: true,
                x_daas_ham_legal_owner: PROVIDER_OWNED,
                x_daas_ham_agreement: larger.record_id,
                x_daas_ham_site: site.record_id,
            },
            enforceSecurity: false,
        })
        atf.server.recordInsert({
            $id: Now.ID['atf_spt_live_large_2'],
            table: 'alm_hardware',
            fieldValues: {
                serial_number: 'ATF-SPT-LIVE-L2',
                model: model.record_id,
                company: customer.record_id,
                install_status: IN_USE,
                quantity: 1,
                x_daas_ham_fleet: true,
                x_daas_ham_legal_owner: PROVIDER_OWNED,
                x_daas_ham_agreement: larger.record_id,
                x_daas_ham_site: site.record_id,
            },
            enforceSecurity: false,
        })
        atf.server.recordInsert({
            $id: Now.ID['atf_spt_stock_1'],
            table: 'alm_hardware',
            fieldValues: {
                serial_number: 'ATF-SPT-STOCK-1',
                model: model.record_id,
                stockroom: depot.record_id,
                install_status: IN_STOCK,
                substatus: AVAILABLE,
                quantity: 1,
                x_daas_ham_fleet: true,
                x_daas_ham_legal_owner: PROVIDER_OWNED,
            },
            enforceSecurity: false,
        })
        atf.server.recordInsert({
            $id: Now.ID['atf_spt_stock_2'],
            table: 'alm_hardware',
            fieldValues: {
                serial_number: 'ATF-SPT-STOCK-2',
                model: model.record_id,
                stockroom: depot.record_id,
                install_status: IN_STOCK,
                substatus: AVAILABLE,
                quantity: 1,
                x_daas_ham_fleet: true,
                x_daas_ham_legal_owner: PROVIDER_OWNED,
            },
            enforceSecurity: false,
        })
        // A run that resumes a pass an earlier run paused on its time budget (ADR 0007) may end before the fixture's
        // Agreements; the run after it starts a fresh pass. So the job runs until the pool is filled, three times at most.
        atf.server.runServerSideScript({
            $id: Now.ID['atf_spt_run_job'],
            script: `(function (outputs, steps, params, stepResult, assertEqual) {
    var sparePool = require('x_daas_ham/naas-ham/0.1.0/src/server/entry/spare-pool.ts');
    function pooled() {
        var spare = new GlideRecord('alm_hardware');
        spare.addQuery('serial_number', 'STARTSWITH', 'ATF-SPT-STOCK');
        spare.addQuery('substatus', 'reserved_spare_pool');
        spare.query();
        return spare.hasNext();
    }
    try {
        for (var run = 1; run <= 3; run++) {
            sparePool.topUpSparePools();
            if (pooled()) {
                stepResult.setOutputMessage('The top-up filled the pool of ATF Spare Pool Customer on run ' + run);
                return true;
            }
        }
        stepResult.setOutputMessage('No ATF-SPT-STOCK unit moved into a Spare pool in 3 runs of the top-up');
        return false;
    } catch (e) {
        stepResult.setOutputMessage(String(e && e.message ? e.message : e));
        return false;
    }
})(outputs, steps, params, stepResult, assertEqual);`,
        })
        // One spare in the pool, carrying the Agreement whose units make the larger share (0.6 against 0.4) ...
        atf.server.recordQuery({
            $id: Now.ID['atf_spt_pooled'],
            table: 'alm_hardware',
            fieldValues: `model=${model.record_id}^install_status=6^substatus=reserved_spare_pool^company=${customer.record_id}^x_daas_ham_agreement=${larger.record_id}`,
            assert: 'records_match_query',
        })
        // ... and the other still free in the depot: the pool is one unit, not one per Agreement.
        atf.server.recordQuery({
            $id: Now.ID['atf_spt_left_free'],
            table: 'alm_hardware',
            fieldValues: `model=${model.record_id}^install_status=6^substatus=available^stockroom=${depot.record_id}`,
            assert: 'records_match_query',
        })
    },
)

/*
 * ATF: the In transfer stage (ADR 0002), on a fleet asset. Inventory's transfer order logic saves
 * the Asset of a transfer order line in the transaction of whoever works the line, here an inventory tech. The fixture
 * setting the Fleet flag inserts without security enforcement: the flag is read-only on forms, and set server-side.
 * The tech's steps skip it too, still in the tech's session (so Inventory's rules and the app's run as for the tech):
 * the dictionary keeps a line's Transfer order and Stage read-only, its field write ACLs are for a draft line (and its
 * Quantity requested for consumables), and alm_asset.active_to (the Asset's Active transfer order flag) is unreadable
 * to every session (read ACL script false, no admin override). None of that is the app's.
 *
 * Not tested here: that the same move off any transfer order line is refused. The lifecycle rule checks only a save
 * that a user without admin makes in an interactive session, and ATF's server steps run
 * outside one. Like the lifecycle rule's other refusals, it is left to the manual checks of a first install
 * (docs/verify-on-instance.md, Transfer refusals).
 */

export const transferStageTest = Test(
    {
        $id: Now.ID['atf_transfer_stage'],
        name: 'NaaS - an asset on a transfer order line is in transfer until Inventory lets it go',
        description:
            "Inventory puts a fleet asset on a transfer order line In stock / Pending transfer, which the app takes as in transfer; once the line is cancelled, a Customer's spare unit goes back to its spare pool, not to Inventory's In stock / Available.",
        active: true,
        // Inventory's transfer order flows run on these saves, outside what this test checks.
        failOnServerError: false,
    },
    (atf) => {
        const customer = atf.server.recordInsert({
            $id: Now.ID['atf_xfer_customer'],
            table: 'customer_account',
            fieldValues: { name: 'ATF Transfer Customer', customer: true },
        })
        // The tech works at the depot: a member of its Assignment group (ADR 0018).
        const depotGroup = atf.server.recordInsert({
            $id: Now.ID['atf_xfer_group'],
            table: 'sys_user_group',
            fieldValues: { name: 'ATF Transfer Depot team' },
        })
        const depot = atf.server.recordInsert({
            $id: Now.ID['atf_xfer_from'],
            table: 'alm_stockroom',
            fieldValues: { name: 'ATF Transfer Depot', x_daas_ham_stockroom_type: CENTRAL_DEPOT, assignment_group: depotGroup.record_id },
        })
        const destination = atf.server.recordInsert({
            $id: Now.ID['atf_xfer_to'],
            table: 'alm_stockroom',
            fieldValues: { name: 'ATF Transfer Destination', x_daas_ham_stockroom_type: CENTRAL_DEPOT },
        })
        const model = atf.server.recordInsert({
            $id: Now.ID['atf_xfer_model'],
            table: 'cmdb_model',
            fieldValues: { name: 'ATF Transfer Switch', x_daas_ham_oem_pid: 'ATF-XFER-24', x_daas_ham_device_class: SWITCH },
        })
        // A Customer's spare unit handed over to Inventory, which takes a unit onto a line only from In stock / Available
        // in the line's from-stockroom (its rule "Validate TOL and check availibility").
        const asset = atf.server.recordInsert({
            $id: Now.ID['atf_xfer_asset'],
            table: 'alm_hardware',
            fieldValues: {
                serial_number: 'ATF-XFER-0001',
                model: model.record_id,
                company: customer.record_id,
                stockroom: depot.record_id,
                install_status: IN_STOCK,
                substatus: AVAILABLE,
                quantity: 1,
                x_daas_ham_fleet: true,
            },
            enforceSecurity: false,
        })
        const transfer = atf.server.recordInsert({
            $id: Now.ID['atf_xfer_order'],
            table: 'alm_transfer_order',
            fieldValues: { from_stockroom: depot.record_id, to_stockroom: destination.record_id },
        })
        const tech = atf.server.createUser({
            $id: Now.ID['atf_xfer_user'],
            firstName: 'ATF',
            lastName: 'Transfer Tech',
            roles: [inventoryTech],
            impersonate: false,
        })
        atf.server.recordInsert({
            $id: Now.ID['atf_xfer_member'],
            table: 'sys_user_grmember',
            fieldValues: { user: tech.user, group: depotGroup.record_id },
        })
        atf.server.impersonate({ $id: Now.ID['atf_xfer_impersonate'], user: tech.user })
        // Inventory's "Push Status to Asset/Consumable" saves the Asset In stock / Pending transfer, with its Active
        // transfer order flag set: the In transfer stage, which the app's rules on alm_hardware take as it is.
        const line = atf.server.recordInsert({
            $id: Now.ID['atf_xfer_line'],
            table: 'alm_transfer_order_line',
            fieldValues: { transfer_order: transfer.record_id, model: model.record_id, asset: asset.record_id },
            enforceSecurity: false,
        })
        atf.server.recordValidation({
            $id: Now.ID['atf_xfer_validate_in_transfer'],
            table: 'alm_hardware',
            recordId: asset.record_id,
            fieldValues: 'install_status=6^substatus=pending_transfer^active_to=true',
            assert: 'record_validated',
            enforceSecurity: false,
        })
        // Inventory's "Release Asset on TOL cancel/delete" saves it In stock / Available where it was, clearing the flag;
        // in the same save the app gives it back the stage it left.
        atf.server.recordUpdate({
            $id: Now.ID['atf_xfer_cancel_line'],
            table: 'alm_transfer_order_line',
            recordId: line.record_id,
            fieldValues: { stage: 'cancelled' },
            assert: 'record_successfully_updated',
            enforceSecurity: false,
        })
        atf.server.recordValidation({
            $id: Now.ID['atf_xfer_validate_released'],
            table: 'alm_hardware',
            recordId: asset.record_id,
            fieldValues: `install_status=6^substatus=reserved_spare_pool^active_to=false^stockroom=${depot.record_id}`,
            assert: 'record_validated',
            enforceSecurity: false,
        })
    },
)
