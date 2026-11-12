import '@servicenow/sdk/global'
import { Test } from '@servicenow/sdk/core'
import { DEVICE_CLASS, INSTALL_STATUS, LEGAL_OWNER, STAGE_FIELDS, STOCKROOM_TYPE } from '../../server/domain/vocabulary'
import { assetManager } from '../shared/roles.now'

/*
 * Fixtures setting the Fleet flag insert without security enforcement: the flag is read-only on forms.
 */

// The vocabulary's values the fixtures below are created with, each under a name: for a value, a Test takes a
// name, but no property access (VOCABULARY.value).
const IN_STOCK = INSTALL_STATUS.inStock
const AVAILABLE = STAGE_FIELDS.available.substatus
const CENTRAL_DEPOT = STOCKROOM_TYPE.central_depot
const SWITCH = DEVICE_CLASS.switch
const REFUSED_FIELDS = `x_daas_ham_fleet=false^install_status=${STAGE_FIELDS.available.installStatus}^substatus=${STAGE_FIELDS.available.substatus}`
const ADOPTED_FIELDS = `x_daas_ham_fleet=true^x_daas_ham_legal_owner=${LEGAL_OWNER.provider}^install_status=${STAGE_FIELDS.available.installStatus}^substatus=${STAGE_FIELDS.available.substatus}`

export const addToFleetTest = Test(
    {
        $id: Now.ID['atf_add_to_fleet'],
        name: 'NaaS - Add to fleet refuses an asset whose model has no OEM PID',
        description:
            'Add to fleet leaves an available asset in a NaaS stockroom outside the fleet when its model has no OEM PID, and adopts the same asset of a model with one.',
        active: true,
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
            fieldValues: REFUSED_FIELDS,
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
            fieldValues: ADOPTED_FIELDS,
            assert: 'record_validated',
        })
    },
)
