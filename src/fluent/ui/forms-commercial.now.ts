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
