import '@servicenow/sdk/global'
import { default_view, Form, List, Record } from '@servicenow/sdk/core'
import { NAAS_MODEL_MILESTONES } from '../../server/domain/fleet'
import { OPEN_NORM_EXCEPTIONS_QUERY } from '../../server/domain/normalization'
import { ROLE } from '../../server/domain/visibility'
import { broadStaff } from '../shared/roles.now'
import { naasMenu } from '../shared/menu.now'

Form({
    table: 'x_daas_ham_manufacturer_alias',
    view: default_view,
    sections: [
        {
            caption: 'Alias',
            content: [
                {
                    layout: 'one-column',
                    elements: [{ field: 'alias', type: 'table_field' }, { field: 'manufacturer', type: 'table_field' }],
                },
            ],
        },
    ],
})

Form({
    table: 'x_daas_ham_model_match_rule',
    view: default_view,
    sections: [
        {
            caption: 'Rule',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'order', type: 'table_field' }, { field: 'manufacturer', type: 'table_field' }, { field: 'match_type', type: 'table_field' }],
                    rightElements: [{ field: 'pattern', type: 'table_field' }, { field: 'model', type: 'table_field' }, { field: 'active', type: 'table_field' }],
                },
            ],
        },
    ],
})

Form({
    table: 'x_daas_ham_norm_exception',
    view: default_view,
    sections: [
        {
            caption: 'Exception',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'raw_manufacturer', type: 'table_field' }, { field: 'raw_model', type: 'table_field' }, { field: 'reason', type: 'table_field' }, { field: 'occurrences', type: 'table_field' }],
                    rightElements: [{ field: 'status', type: 'table_field' }, { field: 'resolved_model', type: 'table_field' }, { field: 'source_table', type: 'table_field' }, { field: 'source_record', type: 'table_field' }],
                },
            ],
        },
    ],
})

List({ table: 'x_daas_ham_manufacturer_alias', view: default_view, columns: ['alias', 'manufacturer'] })

List({ table: 'x_daas_ham_model_match_rule', view: default_view, columns: ['order', 'manufacturer', 'match_type', 'pattern', 'model', 'active'] })

List({ table: 'x_daas_ham_norm_exception', view: default_view, columns: ['raw_manufacturer', 'raw_model', 'reason', 'occurrences', 'status', 'resolved_model'] })

// The platform's table (ADR 0017), kept to the rows the app reads: the manufacturer milestones (lifecycle type
// Publisher) of NaaS Models. The form's default type, Internal, is an organisation's own plan, which the app ignores.
Record({
    $id: Now.ID['module_model_lifecycle'],
    table: 'sys_app_module',
    data: {
        title: 'Model lifecycle',
        application: naasMenu,
        link_type: 'LIST',
        name: 'cmdb_model_lifecycle',
        filter: NAAS_MODEL_MILESTONES,
        roles: broadStaff,
        active: true,
        order: 510,
    },
})

Record({
    $id: Now.ID['module_norm_exceptions'],
    table: 'sys_app_module',
    data: {
        title: 'Normalization exceptions',
        application: naasMenu,
        link_type: 'FILTER',
        name: 'x_daas_ham_norm_exception',
        filter: OPEN_NORM_EXCEPTIONS_QUERY,
        roles: broadStaff,
        active: true,
        order: 520,
    },
})

Record({
    $id: Now.ID['module_match_rules'],
    table: 'sys_app_module',
    data: {
        title: 'Model match rules',
        application: naasMenu,
        link_type: 'LIST',
        name: 'x_daas_ham_model_match_rule',
        roles: [ROLE.assetManager],
        active: true,
        order: 530,
    },
})

Record({
    $id: Now.ID['module_aliases'],
    table: 'sys_app_module',
    data: {
        title: 'Manufacturer aliases',
        application: naasMenu,
        link_type: 'LIST',
        name: 'x_daas_ham_manufacturer_alias',
        roles: [ROLE.assetManager],
        active: true,
        order: 540,
    },
})

Record({
    $id: Now.ID['module_eox_import'],
    table: 'sys_app_module',
    data: {
        title: 'Lifecycle import rows',
        application: naasMenu,
        link_type: 'LIST',
        name: 'x_daas_ham_eox_import',
        roles: [ROLE.assetManager],
        active: true,
        order: 620,
    },
})
