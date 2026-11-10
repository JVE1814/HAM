import '@servicenow/sdk/global'
import { Test } from '@servicenow/sdk/core'
import { DEVICE_CLASS, INSTALL_STATUS, LEGAL_OWNER, STAGE_FIELDS, STOCKROOM_TYPE } from '../../server/domain/vocabulary'
import { assetManager, inventoryTech } from '../shared/roles.now'

/*
 * ATF: adopting the Provider's existing equipment into the fleet with "Add to fleet" (ADR 0016; suite "NaaS - P1").
 * Fixtures setting the Fleet flag insert without security enforcement: the flag is read-only on forms.
 */

// The vocabulary's values the fixtures below are created with, each under a name: for a value, a Test takes a
// name, but no property access (VOCABULARY.value).
const IN_STOCK = INSTALL_STATUS.inStock
const AVAILABLE = STAGE_FIELDS.available.substatus
const CENTRAL_DEPOT = STOCKROOM_TYPE.central_depot
const SWITCH = DEVICE_CLASS.switch
const IN_USE = INSTALL_STATUS.inUse
const PROVIDER_OWNED = LEGAL_OWNER.provider

export const addToFleetTest = Test(
    {
        $id: Now.ID['atf_add_to_fleet'],
        name: 'NaaS - Add to fleet refuses an asset whose model has no OEM PID',
        description:
            'Add to fleet leaves an available asset in a NaaS stockroom outside the fleet when its model has no OEM PID, and adopts the same asset of a model with one.',
        active: true,
        // The refusal is the expected path, and shows an error message; the validations below check the outcome.
        failOnServerError: false,
    },
    (atf) => {
        const depot = atf.server.recordInsert({
            $id: Now.ID['atf_adopt_stockroom'],
            table: 'alm_stockroom',
            fieldValues: { name: 'ATF Adoption Depot', x_daas_ham_stockroom_type: CENTRAL_DEPOT },
        })
        // The asset form requires a model category, a model and a quantity before it submits.
        const category = atf.server.recordInsert({
            $id: Now.ID['atf_adopt_category'],
            table: 'cmdb_model_category',
            fieldValues: { name: 'ATF Adoption Gear', asset_class: 'alm_hardware' },
        })
        // No OEM PID: not a NaaS Model.
        const itModel = atf.server.recordInsert({
            $id: Now.ID['atf_adopt_model_it'],
            table: 'cmdb_model',
            fieldValues: { name: 'ATF IT Switch', cmdb_model_category: category.record_id },
        })
        const naasModel = atf.server.recordInsert({
            $id: Now.ID['atf_adopt_model_naas'],
            table: 'cmdb_model',
            fieldValues: {
                name: 'ATF NaaS Switch',
                x_daas_ham_oem_pid: 'ATF-ADOPT-24',
                x_daas_ham_device_class: SWITCH,
                cmdb_model_category: category.record_id,
            },
        })
        // Two units outside the fleet, alike but for their Model: each would join it, available in a NaaS stockroom.
        const refused = atf.server.recordInsert({
            $id: Now.ID['atf_adopt_asset_refused'],
            table: 'alm_hardware',
            fieldValues: {
                serial_number: 'ATF-ADOPT-NOPID',
                model: itModel.record_id,
                model_category: category.record_id,
                stockroom: depot.record_id,
                install_status: IN_STOCK,
                substatus: AVAILABLE,
                quantity: 1,
                x_daas_ham_fleet: false,
            },
            enforceSecurity: false,
        })
        const adopted = atf.server.recordInsert({
            $id: Now.ID['atf_adopt_asset_adopted'],
            table: 'alm_hardware',
            fieldValues: {
                serial_number: 'ATF-ADOPT-PID',
                model: naasModel.record_id,
                model_category: category.record_id,
                stockroom: depot.record_id,
                install_status: IN_STOCK,
                substatus: AVAILABLE,
                quantity: 1,
                x_daas_ham_fleet: false,
            },
            enforceSecurity: false,
        })
        atf.server.createUser({ $id: Now.ID['atf_adopt_user'], firstName: 'ATF', lastName: 'Fleet Manager', roles: [assetManager] })
        atf.form.openExistingRecord({ $id: Now.ID['atf_adopt_open_refused'], table: 'alm_hardware', recordId: refused.record_id })
        atf.form.clickUIAction({
            $id: Now.ID['atf_adopt_click_refused'],
            table: 'alm_hardware',
            uiAction: Now.ref('sys_ui_action', 'ua_asset_add_to_fleet'),
            assert: 'form_submitted_to_server',
        })
        atf.server.recordValidation({
            $id: Now.ID['atf_adopt_validate_refused'],
            table: 'alm_hardware',
            recordId: refused.record_id,
            fieldValues: 'x_daas_ham_fleet=false^install_status=6^substatus=available',
            assert: 'record_validated',
        })
        // The control: the action adopts a unit of a NaaS Model, so the refusal above is the OEM PID's.
        atf.form.openExistingRecord({ $id: Now.ID['atf_adopt_open_adopted'], table: 'alm_hardware', recordId: adopted.record_id })
        atf.form.clickUIAction({
            $id: Now.ID['atf_adopt_click_adopted'],
            table: 'alm_hardware',
            uiAction: Now.ref('sys_ui_action', 'ua_asset_add_to_fleet'),
            assert: 'form_submitted_to_server',
        })
        atf.server.recordValidation({
            $id: Now.ID['atf_adopt_validate_adopted'],
            table: 'alm_hardware',
            recordId: adopted.record_id,
            fieldValues: 'x_daas_ham_fleet=true^x_daas_ham_legal_owner=provider^install_status=6^substatus=available',
            assert: 'record_validated',
        })
    },
)

/*
 * ATF: the daily job "NaaS - spare pool top-up" (entry/spare-pool `topUpSparePools`; suite "NaaS - P1"), run on a
 * fixture by its entry function in a server-side script step, in the session of whoever runs the test: one Spare pool
 * per Customer and Model, sized from all their deployed fleet units of it across their Agreements, each Agreement's
 * ratio on its own units, rounded up once (owner decision; domain/sourcing `sparePools`). Here 2 units at 0.2 and 2 at
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
        // In service at the Site: two fleet units under each Agreement.
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
        // Free central stock of the Model: the pool takes one of the two.
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
 * ATF: the In transfer stage (ADR 0002), on a fleet asset (suite "NaaS - P1"). Inventory's transfer order logic saves
 * the Asset of a transfer order line in the transaction of whoever works the line, here an inventory tech. The fixture
 * setting the Fleet flag inserts without security enforcement: the flag is read-only on forms, and set server-side.
 * The tech's steps skip it too, still in the tech's session (so Inventory's rules and the app's run as for the tech):
 * the dictionary keeps a line's Transfer order and Stage read-only, its field write ACLs are for a draft line (and its
 * Quantity requested for consumables), and alm_asset.active_to (the Asset's Active transfer order flag) is unreadable
 * to every session (read ACL script false, no admin override). None of that is the app's.
 *
 * Not tested here: that the same move off any transfer order line is refused. The lifecycle rule checks only a save
 * that a user without admin makes in an interactive session (entry/assets lifecycleRefusal), and ATF's server steps run
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
        // Quantity requested keeps its default of 1. Without security enforcement, as said above.
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
        // in the same save the app gives it back the stage it left (entry/assets onTransferReleased).
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
