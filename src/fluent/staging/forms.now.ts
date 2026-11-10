import '@servicenow/sdk/global'
import { default_view, Form, List, Record } from '@servicenow/sdk/core'
import { ROLE } from '../../server/domain/visibility'
import { providerStaff } from '../shared/roles.now'
import { naasMenu } from '../shared/menu.now'

Form({
    table: 'x_daas_ham_staging_task',
    view: default_view,
    sections: [
        {
            caption: 'Staging',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'number', type: 'table_field' }, { field: 'asset', type: 'table_field' }, { field: 'order_line', type: 'table_field' }, { field: 'staging_source', type: 'table_field' }, { field: 'template', type: 'table_field' }],
                    rightElements: [{ field: 'state', type: 'table_field' }, { field: 'assigned_to', type: 'table_field' }, { field: 'firmware_version', type: 'table_field' }, { field: 'result', type: 'table_field' }],
                },
            ],
        },
        {
            caption: 'Notes',
            content: [
                {
                    layout: 'one-column',
                    elements: [{ field: 'short_description', type: 'table_field' }, { field: 'work_notes', type: 'table_field' }],
                },
            ],
        },
        {
            caption: 'Related',
            content: [
                {
                    layout: 'one-column',
                    elements: [{ type: 'formatter', formatterRef: 'Activities_Filtered' }, { type: 'list', listType: '12M', listRef: 'x_daas_ham_staging_step.staging_task' }],
                },
            ],
        },
    ],
})

Form({
    table: 'x_daas_ham_staging_step',
    view: default_view,
    sections: [
        {
            caption: 'Step',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'staging_task', type: 'table_field' }, { field: 'label', type: 'table_field' }, { field: 'order', type: 'table_field' }, { field: 'mandatory', type: 'table_field' }],
                    rightElements: [{ field: 'done', type: 'table_field' }, { field: 'done_by', type: 'table_field' }, { field: 'done_at', type: 'table_field' }],
                },
            ],
        },
        {
            caption: 'OEM cloud',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'automation', type: 'table_field' }, { field: 'automation_status', type: 'table_field' }],
                    rightElements: [{ field: 'automation_message', type: 'table_field' }, { field: 'attempts', type: 'table_field' }],
                },
            ],
        },
    ],
})

Form({
    table: 'x_daas_ham_staging_template',
    view: default_view,
    sections: [
        {
            caption: 'Template',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'name', type: 'table_field' }, { field: 'staging_source', type: 'table_field' }, { field: 'active', type: 'table_field' }],
                    rightElements: [{ field: 'customer', type: 'table_field' }, { field: 'manufacturer', type: 'table_field' }, { field: 'device_class', type: 'table_field' }],
                },
            ],
        },
        {
            caption: 'Related',
            content: [
                {
                    layout: 'one-column',
                    elements: [{ type: 'list', listType: '12M', listRef: 'x_daas_ham_staging_tmpl_item.template' }],
                },
            ],
        },
    ],
})

Form({
    table: 'x_daas_ham_staging_tmpl_item',
    view: default_view,
    sections: [
        {
            caption: 'Step',
            content: [
                {
                    layout: 'one-column',
                    elements: [{ field: 'template', type: 'table_field' }, { field: 'label', type: 'table_field' }, { field: 'order', type: 'table_field' }, { field: 'mandatory', type: 'table_field' }, { field: 'automation', type: 'table_field' }],
                },
            ],
        },
    ],
})

List({ table: 'x_daas_ham_staging_task', view: default_view, columns: ['number', 'asset', 'staging_source', 'template', 'assigned_to', 'state', 'result'] })

List({ table: 'x_daas_ham_staging_step', view: default_view, columns: ['order', 'label', 'mandatory', 'done', 'automation', 'automation_status', 'automation_message', 'done_by', 'done_at'] })

List({ table: 'x_daas_ham_staging_template', view: default_view, columns: ['name', 'staging_source', 'customer', 'manufacturer', 'device_class', 'active'] })

List({ table: 'x_daas_ham_staging_tmpl_item', view: default_view, columns: ['template', 'order', 'label', 'mandatory', 'automation'] })

Record({
    $id: Now.ID['module_staging'],
    table: 'sys_app_module',
    data: {
        title: 'Staging tasks',
        application: naasMenu,
        link_type: 'FILTER',
        name: 'x_daas_ham_staging_task',
        filter: 'active=true',
        roles: providerStaff,
        active: true,
        order: 240,
    },
})

Record({
    $id: Now.ID['module_staging_templates'],
    table: 'sys_app_module',
    data: {
        title: 'Staging checklist templates',
        application: naasMenu,
        link_type: 'LIST',
        name: 'x_daas_ham_staging_template',
        roles: [ROLE.assetManager],
        active: true,
        order: 550,
    },
})
