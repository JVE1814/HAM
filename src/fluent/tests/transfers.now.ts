import '@servicenow/sdk/global'
import { Test } from '@servicenow/sdk/core'
import { inventoryTech } from '../security/roles.now'

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
 * outside one. Like the lifecycle rule's other refusals, it is left to the manual checks of a first install (README,
 * Verify on the first install).
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
        const depot = atf.server.recordInsert({
            $id: Now.ID['atf_xfer_from'],
            table: 'alm_stockroom',
            fieldValues: { name: 'ATF Transfer Depot', x_daas_ham_stockroom_type: 'central_depot' },
        })
        const destination = atf.server.recordInsert({
            $id: Now.ID['atf_xfer_to'],
            table: 'alm_stockroom',
            fieldValues: { name: 'ATF Transfer Destination', x_daas_ham_stockroom_type: 'central_depot' },
        })
        const model = atf.server.recordInsert({
            $id: Now.ID['atf_xfer_model'],
            table: 'cmdb_model',
            fieldValues: { name: 'ATF Transfer Switch', x_daas_ham_oem_pid: 'ATF-XFER-24', x_daas_ham_device_class: 'switch' },
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
                install_status: 6,
                substatus: 'available',
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
            table: 'x_daas_ham_stockroom_member',
            fieldValues: { user: tech.user, stockroom: depot.record_id },
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
