import '@servicenow/sdk/global'
import { default_view, Form } from '@servicenow/sdk/core'

/* Form layouts for shipping (plan §13 Shipping aggregator). */

export const shipment_form = Form({
    table: 'x_daas_ham_shipment',
    view: default_view,
    sections: [
        {
            caption: 'Shipment',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'number', type: 'table_field' }, { field: 'direction', type: 'table_field' }, { field: 'customer', type: 'table_field' }, { field: 'order', type: 'table_field' }, { field: 'return_order', type: 'table_field' }, { field: 'site', type: 'table_field' }, { field: 'stockroom', type: 'table_field' }],
                    rightElements: [{ field: 'status', type: 'table_field' }, { field: 'status_detail', type: 'table_field' }, { field: 'estimated_delivery', type: 'table_field' }, { field: 'delivered_at', type: 'table_field' }, { field: 'carrier', type: 'table_field' }, { field: 'tracking_number', type: 'table_field' }, { field: 'label_url', type: 'table_field' }],
                },
            ],
        },
        {
            caption: 'Label',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'service_code', type: 'table_field' }, { field: 'packages', type: 'table_field' }, { field: 'label_id', type: 'table_field' }],
                    rightElements: [{ field: 'cost', type: 'table_field' }, { field: 'currency', type: 'table_field' }],
                },
            ],
        },
        {
            caption: 'Tracking',
            content: [
                {
                    layout: 'one-column',
                    elements: [{ type: 'list', listType: '12M', listRef: 'x_daas_ham_shipment_event.shipment' }],
                },
            ],
        },
    ],
})

export const cloud_account_form = Form({
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
