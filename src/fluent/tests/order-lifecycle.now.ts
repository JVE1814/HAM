import '@servicenow/sdk/global'
import { Test } from '@servicenow/sdk/core'
import { assetManager } from '../security/roles.now'

/*
 * ATF: two owner decisions on Orders that the domain tests pin (domain/fulfilment `leftInTransit`, `refillsLine`,
 * `anythingShipped`; domain/sourcing `advanceReplacementRma`), here on the instance: a break-fix unit lost in transit
 * fills its line again under the same OEM RMA and the Order's approval (suite "NaaS - P2"), and Cancel order is refused
 * once anything has shipped (suite "NaaS - P1"). The fixtures stand where Ship and sourcing leave an Order (stages,
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
            fieldValues: { name: 'ATF Lost In Transit Switch', x_daas_ham_oem_pid: 'ATF-LIT-24', x_daas_ham_device_class: 'switch' },
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
                install_status: 1,
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
                order_type: 'device_replace',
                install_mode: 'fsm_engineer',
                short_description: 'ATF lost in transit order',
                stage: 'delivering',
                approval: 'approved',
                entitlement_verdict: 'within_agreement',
            },
            enforceSecurity: false,
        })
        const line = atf.server.recordInsert({
            $id: Now.ID['atf_lit_line'],
            table: 'x_daas_ham_order_line',
            fieldValues: { order: order.record_id, model: model.record_id, quantity: 1, replaces_asset: failed.record_id, line_stage: 'shipped' },
            enforceSecurity: false,
        })
        // The OEM's replacement arrived under this RMA and was shipped to the Site.
        const rma = atf.server.recordInsert({
            $id: Now.ID['atf_lit_rma'],
            table: 'x_daas_ham_oem_rma',
            fieldValues: {
                vendor: 'cisco',
                rma_number: 'ATF-RMA-0001',
                defective_asset: failed.record_id,
                order_line: line.record_id,
                state: 'replacement_received',
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
                install_status: 9,
                substatus: 'shipped_to_site',
                quantity: 1,
                x_daas_ham_fleet: true,
                x_daas_ham_legal_owner: 'provider',
                x_daas_ham_order_line: line.record_id,
                x_daas_ham_agreement: agreement.record_id,
                x_daas_ham_site: site.record_id,
            },
            enforceSecurity: false,
        })
        atf.server.createUser({ $id: Now.ID['atf_lit_user'], firstName: 'ATF', lastName: 'Lost In Transit Manager', roles: [assetManager] })
        // The carrier lost it: the asset manager declares it missing on the way (Shipped -> Missing).
        atf.server.recordUpdate({
            $id: Now.ID['atf_lit_declare_missing'],
            table: 'alm_hardware',
            recordId: replacement.record_id,
            fieldValues: { install_status: 8, substatus: 'lost' },
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
        // The save queued the Order's sourcing (entry/orders `resourceOrder`); the pass runs here, as its script action
        // runs it, so the test does not wait on the event queue. A pass the queued event runs first leaves this one
        // nothing to do, and the same outcome; one it is still running holds the Order's lock, so this one waits for
        // the RMA to be reopened, 20 seconds at most.
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
        // The same RMA serves the line, open again to ask the vendor for another replacement.
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
            fieldValues: { name: 'ATF Cancel Switch', x_daas_ham_oem_pid: 'ATF-CAN-24', x_daas_ham_device_class: 'switch' },
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
                order_type: 'device_add',
                install_mode: 'fsm_engineer',
                short_description: 'ATF shipped order',
                stage: 'preparing',
                approval: 'approved',
                entitlement_verdict: 'within_agreement',
            },
            enforceSecurity: false,
        })
        const shippedLine = atf.server.recordInsert({
            $id: Now.ID['atf_cro_shipped_line'],
            table: 'x_daas_ham_order_line',
            // A partial Ship: one of its two units sent, so only that unit says the Order has shipped.
            fieldValues: { order: shippedOrder.record_id, model: model.record_id, quantity: 2, line_stage: 'ready_to_ship' },
            enforceSecurity: false,
        })
        const shippedUnit = atf.server.recordInsert({
            $id: Now.ID['atf_cro_shipped_unit'],
            table: 'alm_hardware',
            fieldValues: {
                serial_number: 'ATF-CAN-SHIPPED',
                model: model.record_id,
                company: customer.record_id,
                install_status: 9,
                substatus: 'shipped_to_site',
                quantity: 1,
                x_daas_ham_fleet: true,
                x_daas_ham_legal_owner: 'provider',
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
                order_type: 'device_add',
                install_mode: 'fsm_engineer',
                short_description: 'ATF unshipped order',
                stage: 'sourcing',
                approval: 'approved',
                entitlement_verdict: 'within_agreement',
            },
            enforceSecurity: false,
        })
        const openLine = atf.server.recordInsert({
            $id: Now.ID['atf_cro_open_line'],
            table: 'x_daas_ham_order_line',
            fieldValues: { order: openOrder.record_id, model: model.record_id, quantity: 1, line_stage: 'awaiting_stock' },
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
