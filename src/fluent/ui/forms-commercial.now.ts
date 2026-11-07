import '@servicenow/sdk/global'
import { default_view, Form } from '@servicenow/sdk/core'

/* Form layouts for the contracts and money tables (P3). */

export const lease_schedule_form = Form({
    table: 'x_daas_ham_lease_schedule',
    view: default_view,
    sections: [
        {
            caption: 'Lease schedule',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'number', type: 'table_field' }, { field: 'lessor', type: 'table_field' }, { field: 'schedule_number', type: 'table_field' }, { field: 'short_description', type: 'table_field' }],
                    rightElements: [{ field: 'state', type: 'table_field' }, { field: 'starts', type: 'table_field' }, { field: 'ends', type: 'table_field' }, { field: 'decision_lead_days', type: 'table_field' }],
                },
            ],
        },
        {
            caption: 'Money and end of lease',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'monthly_payment', type: 'table_field' }, { field: 'buyout_price', type: 'table_field' }],
                    rightElements: [{ field: 'end_action', type: 'table_field' }, { field: 'mismatch', type: 'table_field' }],
                },
            ],
        },
        {
            caption: 'Related',
            content: [
                {
                    layout: 'one-column',
                    elements: [{ type: 'list', listType: '12M', listRef: 'alm_hardware.x_daas_ham_lease' }, { type: 'list', listType: '12M', listRef: 'x_daas_ham_lease_decision.lease' }],
                },
            ],
        },
    ],
})

export const lease_decision_form = Form({
    table: 'x_daas_ham_lease_decision',
    view: default_view,
    sections: [
        {
            caption: 'End-of-lease decision',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'number', type: 'table_field' }, { field: 'lease', type: 'table_field' }, { field: 'lease_end', type: 'table_field' }, { field: 'decision', type: 'table_field' }, { field: 'new_end_date', type: 'table_field' }],
                    rightElements: [{ field: 'state', type: 'table_field' }, { field: 'assignment_group', type: 'table_field' }, { field: 'assigned_to', type: 'table_field' }, { field: 'covered_assets', type: 'table_field' }, { field: 'deployed_assets', type: 'table_field' }, { field: 'mismatch', type: 'table_field' }],
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
    ],
})

export const billing_period_form = Form({
    table: 'x_daas_ham_billing_period',
    view: default_view,
    sections: [
        {
            caption: 'Billing period',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'period', type: 'table_field' }, { field: 'period_start', type: 'table_field' }, { field: 'period_end', type: 'table_field' }, { field: 'status', type: 'table_field' }],
                    rightElements: [{ field: 'line_count', type: 'table_field' }, { field: 'total_amount', type: 'table_field' }, { field: 'generated_at', type: 'table_field' }, { field: 'closed_at', type: 'table_field' }, { field: 'closed_by', type: 'table_field' }],
                },
            ],
        },
        {
            caption: 'Lines',
            content: [
                {
                    layout: 'one-column',
                    elements: [{ type: 'list', listType: '12M', listRef: 'x_daas_ham_billing_line.billing_period' }],
                },
            ],
        },
    ],
})

export const billing_line_form = Form({
    table: 'x_daas_ham_billing_line',
    view: default_view,
    sections: [
        {
            caption: 'Billing line',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'billing_period', type: 'table_field' }, { field: 'kind', type: 'table_field' }, { field: 'customer', type: 'table_field' }, { field: 'agreement', type: 'table_field' }, { field: 'subscription_line', type: 'table_field' }, { field: 'site', type: 'table_field' }, { field: 'fee_event', type: 'table_field' }],
                    rightElements: [{ field: 'description', type: 'table_field' }, { field: 'units', type: 'table_field' }, { field: 'monthly_rate', type: 'table_field' }, { field: 'amount', type: 'table_field' }, { field: 'currency', type: 'table_field' }],
                },
            ],
        },
    ],
})

export const service_interval_form = Form({
    table: 'x_daas_ham_service_interval',
    view: default_view,
    sections: [
        {
            caption: 'Service interval',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'asset', type: 'table_field' }, { field: 'subscription_line', type: 'table_field' }, { field: 'customer', type: 'table_field' }],
                    rightElements: [{ field: 'site', type: 'table_field' }, { field: 'start_date', type: 'table_field' }, { field: 'end_date', type: 'table_field' }],
                },
            ],
        },
    ],
})
