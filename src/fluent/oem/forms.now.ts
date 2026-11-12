import '@servicenow/sdk/global'
import { default_view, Form, List, Record } from '@servicenow/sdk/core'
import { BROAD_STAFF, ROLE } from '../../server/domain/roles'
import { naasMenu } from '../shared/menu.now'

Form({
    table: 'x_daas_ham_oem_coverage',
    view: default_view,
    sections: [
        {
            caption: 'Coverage',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'serial_number', type: 'table_field' }, { field: 'asset', type: 'table_field' }, { field: 'vendor', type: 'table_field' }, { field: 'contract_number', type: 'table_field' }, { field: 'service_level', type: 'table_field' }, { field: 'annual_cost', type: 'table_field' }],
                    rightElements: [{ field: 'covered', type: 'table_field' }, { field: 'start_date', type: 'table_field' }, { field: 'end_date', type: 'table_field' }, { field: 'source', type: 'table_field' }, { field: 'last_checked', type: 'table_field' }, { field: 'expiry_notified', type: 'table_field' }],
                },
            ],
        },
    ],
})

List({ table: 'x_daas_ham_oem_coverage', view: default_view, columns: ['serial_number', 'asset', 'vendor', 'service_level', 'end_date', 'covered', 'source'] })

Form({
    table: 'x_daas_ham_cloud_account',
    view: default_view,
    sections: [
        {
            caption: 'OEM cloud account',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'customer', type: 'table_field' }, { field: 'vendor', type: 'table_field' }],
                    rightElements: [{ field: 'purpose', type: 'table_field' }, { field: 'account_id', type: 'table_field' }],
                },
            ],
        },
    ],
})

Record({
    $id: Now.ID['module_oem_coverage'],
    table: 'sys_app_module',
    data: {
        title: 'OEM coverage',
        application: naasMenu,
        link_type: 'LIST',
        name: 'x_daas_ham_oem_coverage',
        roles: BROAD_STAFF,
        active: true,
        order: 365,
    },
})

Record({
    $id: Now.ID['module_coverage_import'],
    table: 'sys_app_module',
    data: {
        title: 'OEM coverage import rows',
        application: naasMenu,
        link_type: 'LIST',
        name: 'x_daas_ham_coverage_import',
        roles: [ROLE.assetManager],
        active: true,
        order: 625,
    },
})
