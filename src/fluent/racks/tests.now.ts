import '@servicenow/sdk/global'
import { Test } from '@servicenow/sdk/core'
import { DEVICE_CLASS, INSTALL_STATUS } from '../../server/domain/vocabulary'

/*
 * The rack rules act on fleet assets only (ADR 0016), so the Assets
 * here are fleet assets. Fixtures setting the Fleet flag insert without security enforcement: the flag is read-only on
 * forms, and the app's intake paths set it server-side.
 */

// The vocabulary's values the fixtures below are created with, each under a name: for a value, a Test takes a
// name, but no property access (VOCABULARY.value).
const IN_USE = INSTALL_STATUS.inUse
const SWITCH = DEVICE_CLASS.switch

export const rackPowerBudgetTest = Test(
    {
        $id: Now.ID['atf_rack_power'],
        name: 'NaaS - a placement over the rack power budget is refused',
        description: 'Two 80 W fleet devices do not fit a 100 W rack: the second placement is not saved.',
        active: true,
        failOnServerError: false,
    },
    (atf) => {
        const model = atf.server.recordInsert({
            $id: Now.ID['atf_rp_model'],
            table: 'cmdb_model',
            fieldValues: { name: 'ATF 80 W switch', x_daas_ham_oem_pid: 'ATF-80W', x_daas_ham_device_class: SWITCH, power_consumption: 80 },
        })
        const rack = atf.server.recordInsert({
            $id: Now.ID['atf_rp_rack'],
            table: 'cmdb_ci_rack',
            fieldValues: { name: 'ATF-RACK-100W', rack_units: 42, x_daas_ham_power_capacity_w: 100 },
        })
        atf.server.recordInsert({
            $id: Now.ID['atf_rp_first'],
            table: 'alm_hardware',
            fieldValues: {
                serial_number: 'ATF-RP-0001',
                model: model.record_id,
                install_status: IN_USE,
                quantity: 1,
                x_daas_ham_fleet: true,
                x_daas_ham_rack: rack.record_id,
                x_daas_ham_ru_start: 40,
                x_daas_ham_rack_face: 'front',
            },
            enforceSecurity: false,
        })
        const second = atf.server.recordInsert({
            $id: Now.ID['atf_rp_second'],
            table: 'alm_hardware',
            fieldValues: { serial_number: 'ATF-RP-0002', model: model.record_id, install_status: IN_USE, quantity: 1, x_daas_ham_fleet: true },
            enforceSecurity: false,
        })
        atf.server.recordUpdate({
            $id: Now.ID['atf_rp_place'],
            table: 'alm_hardware',
            recordId: second.record_id,
            fieldValues: { x_daas_ham_rack: rack.record_id, x_daas_ham_ru_start: 30, x_daas_ham_rack_face: 'rear' },
            assert: 'record_not_updated',
        })
    },
)
