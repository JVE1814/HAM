import '@servicenow/sdk/global'
import { Test } from '@servicenow/sdk/core'

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
                x_daas_ham_device_class: 'switch',
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
            fieldValues: { name: 'ATF Spare Pool Depot', x_daas_ham_stockroom_type: 'central_depot' },
        })
        // In service at the Site: two fleet units under each Agreement.
        atf.server.recordInsert({
            $id: Now.ID['atf_spt_live_small_1'],
            table: 'alm_hardware',
            fieldValues: {
                serial_number: 'ATF-SPT-LIVE-S1',
                model: model.record_id,
                company: customer.record_id,
                install_status: 1,
                quantity: 1,
                x_daas_ham_fleet: true,
                x_daas_ham_legal_owner: 'provider',
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
                install_status: 1,
                quantity: 1,
                x_daas_ham_fleet: true,
                x_daas_ham_legal_owner: 'provider',
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
                install_status: 1,
                quantity: 1,
                x_daas_ham_fleet: true,
                x_daas_ham_legal_owner: 'provider',
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
                install_status: 1,
                quantity: 1,
                x_daas_ham_fleet: true,
                x_daas_ham_legal_owner: 'provider',
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
                install_status: 6,
                substatus: 'available',
                quantity: 1,
                x_daas_ham_fleet: true,
                x_daas_ham_legal_owner: 'provider',
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
                install_status: 6,
                substatus: 'available',
                quantity: 1,
                x_daas_ham_fleet: true,
                x_daas_ham_legal_owner: 'provider',
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
