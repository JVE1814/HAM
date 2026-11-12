import '@servicenow/sdk/global'
import { default_view, Form } from '@servicenow/sdk/core'

Form({
    table: 'x_daas_ham_billing_period',
    view: default_view,
    sections: [
        {
            caption: 'Billing period',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'period', type: 'table_field' }, { field: 'period_start', type: 'table_field' }, { field: 'period_end', type: 'table_field' }, { field: 'status', type: 'table_field' }],
                    rightElements: [{ field: 'line_count', type: 'table_field' }, { field: 'totals', type: 'table_field' }, { field: 'total_amount', type: 'table_field' }, { field: 'generated_at', type: 'table_field' }, { field: 'failed_lines', type: 'table_field' }, { field: 'last_error', type: 'table_field' }, { field: 'closed_at', type: 'table_field' }, { field: 'closed_by', type: 'table_field' }, { field: 'margin_failed', type: 'table_field' }, { field: 'margin_error', type: 'table_field' }],
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

Form({
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

Form({
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
