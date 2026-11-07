import '@servicenow/sdk/global'
import { default_view, Form, List } from '@servicenow/sdk/core'

/* Default form and list layouts for the app's tables (classic UI and workspace record pages). */

export const order_form = Form({
    table: 'x_daas_ham_order',
    view: default_view,
    sections: [
        {
            caption: 'Order',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'number', type: 'table_field' }, { field: 'customer', type: 'table_field' }, { field: 'agreement', type: 'table_field' }, { field: 'site', type: 'table_field' }, { field: 'order_type', type: 'table_field' }, { field: 'site_template', type: 'table_field' }],
                    rightElements: [{ field: 'stage', type: 'table_field' }, { field: 'state', type: 'table_field' }, { field: 'approval', type: 'table_field' }, { field: 'install_mode', type: 'table_field' }, { field: 'requested_date', type: 'table_field' }, { field: 'end_date', type: 'table_field' }],
                },
            ],
        },
        {
            caption: 'Entitlement',
            content: [
                {
                    layout: 'one-column',
                    elements: [{ field: 'entitlement_verdict', type: 'table_field' }, { field: 'entitlement_findings', type: 'table_field' }],
                },
            ],
        },
        {
            caption: 'Delivery',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'carrier', type: 'table_field' }, { field: 'tracking_number', type: 'table_field' }],
                    rightElements: [{ field: 'change_request', type: 'table_field' }, { field: 'work_order', type: 'table_field' }, { field: 'case', type: 'table_field' }, { field: 'return_raised', type: 'table_field' }],
                },
            ],
        },
        {
            caption: 'Notes',
            content: [
                {
                    layout: 'one-column',
                    elements: [{ field: 'short_description', type: 'table_field' }, { field: 'description', type: 'table_field' }, { field: 'work_notes', type: 'table_field' }],
                },
            ],
        },
        {
            caption: 'Related',
            content: [
                {
                    layout: 'one-column',
                    elements: [{ type: 'formatter', formatterRef: 'Activities_Filtered' }, { type: 'list', listType: '12M', listRef: 'x_daas_ham_order_line.order' }, { type: 'list', listType: '12M', listRef: 'x_daas_ham_shipment.order' }],
                },
            ],
        },
    ],
})

export const order_line_form = Form({
    table: 'x_daas_ham_order_line',
    view: default_view,
    sections: [
        {
            caption: 'Line',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'number', type: 'table_field' }, { field: 'order', type: 'table_field' }, { field: 'model', type: 'table_field' }, { field: 'quantity', type: 'table_field' }, { field: 'replaces_asset', type: 'table_field' }, { field: 'from_site_template', type: 'table_field' }],
                    rightElements: [{ field: 'line_stage', type: 'table_field' }, { field: 'quantity_allocated', type: 'table_field' }, { field: 'quantity_to_purchase', type: 'table_field' }, { field: 'sourcing_summary', type: 'table_field' }, { field: 'transfer_orders', type: 'table_field' }, { field: 'purchase_order', type: 'table_field' }, { field: 'purchase_orders', type: 'table_field' }],
                },
            ],
        },
        {
            caption: 'Related',
            content: [
                {
                    layout: 'one-column',
                    elements: [{ type: 'list', listType: '12M', listRef: 'alm_hardware.x_daas_ham_order_line' }, { type: 'list', listType: '12M', listRef: 'x_daas_ham_staging_task.order_line' }],
                },
            ],
        },
    ],
})

export const staging_task_form = Form({
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

export const staging_step_form = Form({
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

export const staging_template_form = Form({
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

export const staging_tmpl_item_form = Form({
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

export const agreement_form = Form({
    table: 'x_daas_ham_agreement',
    view: default_view,
    sections: [
        {
            caption: 'Agreement',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'number', type: 'table_field' }, { field: 'customer', type: 'table_field' }, { field: 'account_manager', type: 'table_field' }, { field: 'short_description', type: 'table_field' }],
                    rightElements: [{ field: 'state', type: 'table_field' }, { field: 'starts', type: 'table_field' }, { field: 'ends', type: 'table_field' }],
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

export const agreement_quantity_form = Form({
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

export const subscription_line_form = Form({
    table: 'x_daas_ham_subscription_line',
    view: default_view,
    sections: [
        {
            caption: 'Subscription line',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'description', type: 'table_field' }, { field: 'agreement', type: 'table_field' }, { field: 'customer', type: 'table_field' }, { field: 'line_type', type: 'table_field' }, { field: 'site', type: 'table_field' }, { field: 'device_class', type: 'table_field' }],
                    rightElements: [{ field: 'monthly_rate', type: 'table_field' }, { field: 'currency', type: 'table_field' }, { field: 'status', type: 'table_field' }, { field: 'start_date', type: 'table_field' }, { field: 'end_date', type: 'table_field' }],
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

export const catalog_entry_form = Form({
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

export const site_template_form = Form({
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

export const site_template_item_form = Form({
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

export const manufacturer_alias_form = Form({
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

export const model_match_rule_form = Form({
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

export const model_lifecycle_form = Form({
    table: 'x_daas_ham_model_lifecycle',
    view: default_view,
    sections: [
        {
            caption: 'Milestones',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'model', type: 'table_field' }, { field: 'end_of_sale', type: 'table_field' }, { field: 'end_of_support', type: 'table_field' }],
                    rightElements: [{ field: 'end_of_extended_support', type: 'table_field' }, { field: 'end_of_life', type: 'table_field' }],
                },
            ],
        },
        {
            caption: 'Source',
            content: [
                {
                    layout: 'one-column',
                    elements: [{ field: 'source', type: 'table_field' }, { field: 'source_reference', type: 'table_field' }, { field: 'last_refreshed', type: 'table_field' }],
                },
            ],
        },
    ],
})

export const norm_exception_form = Form({
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

export const stockroom_member_form = Form({
    table: 'x_daas_ham_stockroom_member',
    view: default_view,
    sections: [
        {
            caption: 'Member',
            content: [
                {
                    layout: 'one-column',
                    elements: [{ field: 'user', type: 'table_field' }, { field: 'stockroom', type: 'table_field' }],
                },
            ],
        },
    ],
})

export const device_event_form = Form({
    table: 'x_daas_ham_device_event',
    view: default_view,
    sections: [
        {
            caption: 'Event',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'asset', type: 'table_field' }, { field: 'identifier', type: 'table_field' }, { field: 'event', type: 'table_field' }],
                    rightElements: [{ field: 'source', type: 'table_field' }, { field: 'observed_at', type: 'table_field' }],
                },
            ],
        },
    ],
})

export const job_cursor_form = Form({
    table: 'x_daas_ham_job_cursor',
    view: default_view,
    sections: [
        {
            caption: 'Job',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'job', type: 'table_field' }, { field: 'cursor', type: 'table_field' }],
                    rightElements: [{ field: 'last_run', type: 'table_field' }, { field: 'last_status', type: 'table_field' }, { field: 'processed_total', type: 'table_field' }],
                },
            ],
        },
    ],
})

List({ table: 'x_daas_ham_order', view: default_view, columns: ['number', 'customer', 'site', 'order_type', 'stage', 'entitlement_verdict', 'install_mode', 'requested_date'] })

List({ table: 'x_daas_ham_order_line', view: default_view, columns: ['number', 'order', 'model', 'quantity', 'line_stage', 'quantity_allocated', 'quantity_to_purchase'] })

List({ table: 'x_daas_ham_staging_task', view: default_view, columns: ['number', 'asset', 'staging_source', 'template', 'assigned_to', 'state', 'result'] })

List({ table: 'x_daas_ham_staging_step', view: default_view, columns: ['order', 'label', 'mandatory', 'done', 'automation', 'automation_status', 'automation_message', 'done_by', 'done_at'] })

List({ table: 'x_daas_ham_staging_template', view: default_view, columns: ['name', 'staging_source', 'customer', 'manufacturer', 'device_class', 'active'] })

List({ table: 'x_daas_ham_staging_tmpl_item', view: default_view, columns: ['template', 'order', 'label', 'mandatory', 'automation'] })

List({ table: 'x_daas_ham_agreement', view: default_view, columns: ['number', 'customer', 'account_manager', 'state', 'starts', 'ends', 'replacement_tier', 'refresh_cycle_months'] })

List({ table: 'x_daas_ham_agreement_quantity', view: default_view, columns: ['agreement', 'device_class', 'model', 'contracted_quantity'] })

List({ table: 'x_daas_ham_subscription_line', view: default_view, columns: ['description', 'customer', 'line_type', 'site', 'device_class', 'monthly_rate', 'status', 'start_date'] })

List({ table: 'x_daas_ham_catalog_entry', view: default_view, columns: ['customer', 'entry_type', 'model', 'site_template', 'monthly_rate', 'active', 'valid_to'] })

List({ table: 'x_daas_ham_site_template', view: default_view, columns: ['name', 'customer', 'active'] })

List({ table: 'x_daas_ham_site_template_item', view: default_view, columns: ['site_template', 'model', 'quantity', 'optional'] })

List({ table: 'x_daas_ham_manufacturer_alias', view: default_view, columns: ['alias', 'manufacturer'] })

List({ table: 'x_daas_ham_model_match_rule', view: default_view, columns: ['order', 'manufacturer', 'match_type', 'pattern', 'model', 'active'] })

List({ table: 'x_daas_ham_model_lifecycle', view: default_view, columns: ['model', 'end_of_sale', 'end_of_support', 'end_of_extended_support', 'end_of_life', 'source'] })

List({ table: 'x_daas_ham_norm_exception', view: default_view, columns: ['raw_manufacturer', 'raw_model', 'reason', 'occurrences', 'status', 'resolved_model'] })

List({ table: 'x_daas_ham_stockroom_member', view: default_view, columns: ['user', 'stockroom'] })

List({ table: 'x_daas_ham_device_event', view: default_view, columns: ['observed_at', 'asset', 'identifier', 'event', 'source'] })

List({ table: 'x_daas_ham_job_cursor', view: default_view, columns: ['job', 'cursor', 'last_run', 'last_status', 'processed_total'] })

export const oem_coverage_form = Form({
    table: 'x_daas_ham_oem_coverage',
    view: default_view,
    sections: [
        {
            caption: 'Coverage',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'serial_number', type: 'table_field' }, { field: 'asset', type: 'table_field' }, { field: 'vendor', type: 'table_field' }, { field: 'contract_number', type: 'table_field' }, { field: 'service_level', type: 'table_field' }],
                    rightElements: [{ field: 'covered', type: 'table_field' }, { field: 'start_date', type: 'table_field' }, { field: 'end_date', type: 'table_field' }, { field: 'source', type: 'table_field' }, { field: 'last_checked', type: 'table_field' }],
                },
            ],
        },
    ],
})

export const oem_rma_form = Form({
    table: 'x_daas_ham_oem_rma',
    view: default_view,
    sections: [
        {
            caption: 'RMA',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'rma_number', type: 'table_field' }, { field: 'vendor', type: 'table_field' }, { field: 'state', type: 'table_field' }, { field: 'status', type: 'table_field' }, { field: 'advance_replacement', type: 'table_field' }],
                    rightElements: [{ field: 'defective_asset', type: 'table_field' }, { field: 'order_line', type: 'table_field' }, { field: 'case', type: 'table_field' }, { field: 'replacement_serial', type: 'table_field' }, { field: 'ship_back_due', type: 'table_field' }, { field: 'last_synced', type: 'table_field' }],
                },
            ],
        },
    ],
})

export const return_order_form = Form({
    table: 'x_daas_ham_return_order',
    view: default_view,
    sections: [
        {
            caption: 'Return',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'number', type: 'table_field' }, { field: 'trigger', type: 'table_field' }, { field: 'customer', type: 'table_field' }, { field: 'site', type: 'table_field' }, { field: 'agreement', type: 'table_field' }, { field: 'source_order', type: 'table_field' }],
                    rightElements: [{ field: 'state', type: 'table_field' }, { field: 'method', type: 'table_field' }, { field: 'due_date', type: 'table_field' }, { field: 'escalated', type: 'table_field' }],
                },
            ],
        },
        {
            caption: 'Collection',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'carrier', type: 'table_field' }, { field: 'tracking_number', type: 'table_field' }],
                    rightElements: [{ field: 'work_order', type: 'table_field' }, { field: 'change_request', type: 'table_field' }],
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
                    elements: [{ type: 'formatter', formatterRef: 'Activities_Filtered' }, { type: 'list', listType: '12M', listRef: 'x_daas_ham_return_order_line.return_order' }, { type: 'list', listType: '12M', listRef: 'x_daas_ham_fee_event.return_order' }, { type: 'list', listType: '12M', listRef: 'x_daas_ham_shipment.return_order' }],
                },
            ],
        },
    ],
})

export const return_order_line_form = Form({
    table: 'x_daas_ham_return_order_line',
    view: default_view,
    sections: [
        {
            caption: 'Line',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'return_order', type: 'table_field' }, { field: 'asset', type: 'table_field' }, { field: 'status', type: 'table_field' }, { field: 'received_at', type: 'table_field' }],
                    rightElements: [{ field: 'condition', type: 'table_field' }, { field: 'evaluation', type: 'table_field' }],
                },
            ],
        },
    ],
})

export const fee_event_form = Form({
    table: 'x_daas_ham_fee_event',
    view: default_view,
    sections: [
        {
            caption: 'Fee',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'fee_type', type: 'table_field' }, { field: 'customer', type: 'table_field' }, { field: 'agreement', type: 'table_field' }, { field: 'asset', type: 'table_field' }, { field: 'return_order', type: 'table_field' }],
                    rightElements: [{ field: 'amount', type: 'table_field' }, { field: 'currency', type: 'table_field' }, { field: 'occurred_on', type: 'table_field' }, { field: 'status', type: 'table_field' }],
                },
            ],
        },
    ],
})

export const disposal_order_form = Form({
    table: 'x_daas_ham_disposal_order',
    view: default_view,
    sections: [
        {
            caption: 'Disposal',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'number', type: 'table_field' }, { field: 'method', type: 'table_field' }, { field: 'disposal_vendor', type: 'table_field' }, { field: 'customer', type: 'table_field' }, { field: 'certificate_number', type: 'table_field' }],
                    rightElements: [{ field: 'stage', type: 'table_field' }, { field: 'state', type: 'table_field' }, { field: 'approval', type: 'table_field' }],
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
                    elements: [{ type: 'formatter', formatterRef: 'Activities_Filtered' }, { type: 'list', listType: '12M', listRef: 'x_daas_ham_disposal_line.disposal_order' }],
                },
            ],
        },
    ],
})

export const disposal_line_form = Form({
    table: 'x_daas_ham_disposal_line',
    view: default_view,
    sections: [
        {
            caption: 'Line',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'disposal_order', type: 'table_field' }, { field: 'asset', type: 'table_field' }, { field: 'method', type: 'table_field' }],
                    rightElements: [{ field: 'sale_amount', type: 'table_field' }, { field: 'credit_amount', type: 'table_field' }, { field: 'status', type: 'table_field' }, { field: 'blockers', type: 'table_field' }],
                },
            ],
        },
    ],
})

export const audit_form = Form({
    table: 'x_daas_ham_audit',
    view: default_view,
    sections: [
        {
            caption: 'Audit',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'number', type: 'table_field' }, { field: 'audit_type', type: 'table_field' }, { field: 'stockroom', type: 'table_field' }, { field: 'site', type: 'table_field' }, { field: 'customer', type: 'table_field' }, { field: 'work_order', type: 'table_field' }],
                    rightElements: [{ field: 'state', type: 'table_field' }, { field: 'expected_count', type: 'table_field' }, { field: 'matched_count', type: 'table_field' }, { field: 'missing_count', type: 'table_field' }, { field: 'unexpected_count', type: 'table_field' }],
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
                    elements: [{ type: 'formatter', formatterRef: 'Activities_Filtered' }, { type: 'list', listType: '12M', listRef: 'x_daas_ham_audit_line.audit' }],
                },
            ],
        },
    ],
})

export const audit_line_form = Form({
    table: 'x_daas_ham_audit_line',
    view: default_view,
    sections: [
        {
            caption: 'Line',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'audit', type: 'table_field' }, { field: 'asset', type: 'table_field' }, { field: 'scanned_code', type: 'table_field' }],
                    rightElements: [{ field: 'result', type: 'table_field' }, { field: 'scanned_at', type: 'table_field' }],
                },
            ],
        },
    ],
})

export const attestation_form = Form({
    table: 'x_daas_ham_attestation',
    view: default_view,
    sections: [
        {
            caption: 'Attestation',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'number', type: 'table_field' }, { field: 'customer', type: 'table_field' }, { field: 'site', type: 'table_field' }, { field: 'agreement', type: 'table_field' }],
                    rightElements: [{ field: 'state', type: 'table_field' }, { field: 'assigned_to', type: 'table_field' }, { field: 'attested_by', type: 'table_field' }, { field: 'attested_at', type: 'table_field' }],
                },
            ],
        },
        {
            caption: 'Related',
            content: [
                {
                    layout: 'one-column',
                    elements: [{ type: 'list', listType: '12M', listRef: 'x_daas_ham_attestation_item.attestation' }],
                },
            ],
        },
    ],
})

export const attestation_item_form = Form({
    table: 'x_daas_ham_attestation_item',
    view: default_view,
    sections: [
        {
            caption: 'Item',
            content: [
                {
                    layout: 'one-column',
                    elements: [{ field: 'attestation', type: 'table_field' }, { field: 'asset', type: 'table_field' }, { field: 'response', type: 'table_field' }],
                },
            ],
        },
    ],
})

export const recon_exception_form = Form({
    table: 'x_daas_ham_recon_exception',
    view: default_view,
    sections: [
        {
            caption: 'Exception',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'exception_type', type: 'table_field' }, { field: 'asset', type: 'table_field' }, { field: 'ci', type: 'table_field' }, { field: 'customer', type: 'table_field' }],
                    rightElements: [{ field: 'status', type: 'table_field' }, { field: 'detected_at', type: 'table_field' }, { field: 'detail', type: 'table_field' }],
                },
            ],
        },
    ],
})

List({ table: 'x_daas_ham_oem_coverage', view: default_view, columns: ['serial_number', 'asset', 'vendor', 'service_level', 'end_date', 'covered', 'source'] })

List({ table: 'x_daas_ham_oem_rma', view: default_view, columns: ['rma_number', 'vendor', 'state', 'status', 'defective_asset', 'replacement_serial', 'ship_back_due'] })

List({ table: 'x_daas_ham_return_order', view: default_view, columns: ['number', 'trigger', 'customer', 'site', 'method', 'due_date', 'state', 'escalated'] })

List({ table: 'x_daas_ham_return_order_line', view: default_view, columns: ['return_order', 'asset', 'status', 'received_at', 'condition', 'evaluation'] })

List({ table: 'x_daas_ham_fee_event', view: default_view, columns: ['occurred_on', 'fee_type', 'customer', 'asset', 'amount', 'currency', 'status'] })

List({ table: 'x_daas_ham_disposal_order', view: default_view, columns: ['number', 'method', 'disposal_vendor', 'customer', 'stage', 'approval'] })

List({ table: 'x_daas_ham_disposal_line', view: default_view, columns: ['disposal_order', 'asset', 'method', 'status', 'sale_amount', 'credit_amount', 'blockers'] })

List({ table: 'x_daas_ham_audit', view: default_view, columns: ['number', 'audit_type', 'stockroom', 'site', 'state', 'expected_count', 'matched_count', 'missing_count', 'unexpected_count'] })

List({ table: 'x_daas_ham_audit_line', view: default_view, columns: ['audit', 'asset', 'scanned_code', 'result', 'scanned_at'] })

List({ table: 'x_daas_ham_attestation', view: default_view, columns: ['number', 'customer', 'site', 'state', 'assigned_to', 'attested_at'] })

List({ table: 'x_daas_ham_attestation_item', view: default_view, columns: ['attestation', 'asset', 'response'] })

List({ table: 'x_daas_ham_recon_exception', view: default_view, columns: ['detected_at', 'exception_type', 'asset', 'ci', 'customer', 'status', 'detail'] })
