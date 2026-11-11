import '@servicenow/sdk/global'
import { default_view, Form, List, Record } from '@servicenow/sdk/core'
import { broadStaff } from '../shared/roles.now'
import { naasMenu } from '../shared/menu.now'

Form({
    table: 'x_daas_ham_agreement',
    view: default_view,
    sections: [
        {
            caption: 'Agreement',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'number', type: 'table_field' }, { field: 'customer', type: 'table_field' }, { field: 'account_manager', type: 'table_field' }, { field: 'short_description', type: 'table_field' }],
                    // Currency is mandatory with no default: on the form, so a new Agreement gets one and an old one is set.
                    rightElements: [{ field: 'state', type: 'table_field' }, { field: 'starts', type: 'table_field' }, { field: 'ends', type: 'table_field' }, { field: 'currency', type: 'table_field' }],
                },
            ],
        },
        {
            caption: 'Service terms',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'replacement_tier', type: 'table_field' }, { field: 'refresh_cycle_months', type: 'table_field' }, { field: 'refresh_basis', type: 'table_field' }, { field: 'spare_pool_ratio', type: 'table_field' }],
                    rightElements: [{ field: 'overdue_return_days', type: 'table_field' }, { field: 'attestation_interval_months', type: 'table_field' }],
                },
            ],
        },
        {
            caption: 'Fees',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'lost_asset_fee', type: 'table_field' }, { field: 'late_return_fee', type: 'table_field' }],
                    rightElements: [{ field: 'damage_fee', type: 'table_field' }],
                },
            ],
        },
        {
            caption: 'Renewal',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'renewal_lead_days', type: 'table_field' }, { field: 'renewal_term_months', type: 'table_field' }],
                    rightElements: [{ field: 'renewal_notified', type: 'table_field' }, { field: 'end_return_raised', type: 'table_field' }],
                },
            ],
        },
        {
            caption: 'Related',
            content: [
                {
                    layout: 'one-column',
                    elements: [{ type: 'list', listType: '12M', listRef: 'x_daas_ham_agreement_quantity.agreement' }, { type: 'list', listType: '12M', listRef: 'x_daas_ham_subscription_line.agreement' }],
                },
            ],
        },
    ],
})

Form({
    table: 'x_daas_ham_agreement_quantity',
    view: default_view,
    sections: [
        {
            caption: 'Contracted quantity',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'agreement', type: 'table_field' }, { field: 'device_class', type: 'table_field' }],
                    rightElements: [{ field: 'model', type: 'table_field' }, { field: 'contracted_quantity', type: 'table_field' }],
                },
            ],
        },
    ],
})

Form({
    table: 'x_daas_ham_subscription_line',
    view: default_view,
    sections: [
        {
            caption: 'Subscription line',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'description', type: 'table_field' }, { field: 'agreement', type: 'table_field' }, { field: 'customer', type: 'table_field' }, { field: 'line_type', type: 'table_field' }, { field: 'site', type: 'table_field' }, { field: 'device_class', type: 'table_field' }],
                    // No currency: the line bills in its Agreement's (its own Currency is unused). Not 'agreement.currency' either:
                    // a dot-walked field on a form is editable and saving the line would change the whole Agreement's currency.
                    rightElements: [{ field: 'monthly_rate', type: 'table_field' }, { field: 'status', type: 'table_field' }, { field: 'start_date', type: 'table_field' }, { field: 'end_date', type: 'table_field' }],
                },
            ],
        },
        {
            caption: 'Related',
            content: [
                {
                    layout: 'one-column',
                    elements: [{ type: 'list', listType: '12M', listRef: 'alm_hardware.x_daas_ham_subscription_line' }],
                },
            ],
        },
    ],
})

Form({
    table: 'x_daas_ham_catalog_entry',
    view: default_view,
    sections: [
        {
            caption: 'Catalog entry',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'customer', type: 'table_field' }, { field: 'entry_type', type: 'table_field' }, { field: 'model', type: 'table_field' }, { field: 'site_template', type: 'table_field' }],
                    rightElements: [{ field: 'monthly_rate', type: 'table_field' }, { field: 'active', type: 'table_field' }, { field: 'valid_from', type: 'table_field' }, { field: 'valid_to', type: 'table_field' }],
                },
            ],
        },
    ],
})

Form({
    table: 'x_daas_ham_site_template',
    view: default_view,
    sections: [
        {
            caption: 'Site template',
            content: [
                {
                    layout: 'one-column',
                    elements: [{ field: 'name', type: 'table_field' }, { field: 'customer', type: 'table_field' }, { field: 'active', type: 'table_field' }],
                },
            ],
        },
        {
            caption: 'Description',
            content: [
                {
                    layout: 'one-column',
                    elements: [{ field: 'description', type: 'table_field' }],
                },
            ],
        },
        {
            caption: 'Related',
            content: [
                {
                    layout: 'one-column',
                    elements: [{ type: 'list', listType: '12M', listRef: 'x_daas_ham_site_template_item.site_template' }],
                },
            ],
        },
    ],
})

Form({
    table: 'x_daas_ham_site_template_item',
    view: default_view,
    sections: [
        {
            caption: 'Item',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'site_template', type: 'table_field' }, { field: 'model', type: 'table_field' }],
                    rightElements: [{ field: 'quantity', type: 'table_field' }, { field: 'optional', type: 'table_field' }],
                },
            ],
        },
    ],
})

List({ table: 'x_daas_ham_agreement', view: default_view, columns: ['number', 'customer', 'account_manager', 'state', 'currency', 'starts', 'ends', 'replacement_tier', 'refresh_cycle_months'] })

List({ table: 'x_daas_ham_agreement_quantity', view: default_view, columns: ['agreement', 'device_class', 'model', 'contracted_quantity'] })

List({ table: 'x_daas_ham_subscription_line', view: default_view, columns: ['description', 'customer', 'line_type', 'site', 'device_class', 'monthly_rate', 'status', 'start_date'] })

List({ table: 'x_daas_ham_catalog_entry', view: default_view, columns: ['customer', 'entry_type', 'model', 'site_template', 'monthly_rate', 'active', 'valid_to'] })

List({ table: 'x_daas_ham_site_template', view: default_view, columns: ['name', 'customer', 'active'] })

List({ table: 'x_daas_ham_site_template_item', view: default_view, columns: ['site_template', 'model', 'quantity', 'optional'] })

Record({
    $id: Now.ID['module_agreements'],
    table: 'sys_app_module',
    data: {
        title: 'Agreements',
        application: naasMenu,
        link_type: 'LIST',
        name: 'x_daas_ham_agreement',
        roles: broadStaff,
        active: true,
        order: 410,
    },
})

Record({
    $id: Now.ID['module_subscription_lines'],
    table: 'sys_app_module',
    data: {
        title: 'Subscription lines',
        application: naasMenu,
        link_type: 'LIST',
        name: 'x_daas_ham_subscription_line',
        roles: broadStaff,
        active: true,
        order: 420,
    },
})

Record({
    $id: Now.ID['module_catalog_entries'],
    table: 'sys_app_module',
    data: {
        title: 'Catalog entries',
        application: naasMenu,
        link_type: 'LIST',
        name: 'x_daas_ham_catalog_entry',
        roles: broadStaff,
        active: true,
        order: 430,
    },
})

Record({
    $id: Now.ID['module_site_templates'],
    table: 'sys_app_module',
    data: {
        title: 'Site templates',
        application: naasMenu,
        link_type: 'LIST',
        name: 'x_daas_ham_site_template',
        roles: broadStaff,
        active: true,
        order: 440,
    },
})
