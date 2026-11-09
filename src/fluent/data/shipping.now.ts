import '@servicenow/sdk/global'
import { ChoiceColumn, DateColumn, DateTimeColumn, DecimalColumn, IntegerColumn, ReferenceColumn, StringColumn, Table, UrlColumn } from '@servicenow/sdk/core'
import { SHIPMENT_DIRECTION_CHOICES, SHIPMENT_STATUS_CHOICES } from '../../server/domain/vocabulary'

/* Shipments bought through the shipping aggregator and their tracking events (P3.26, D73). */

export const x_daas_ham_shipment = Table({
    name: 'x_daas_ham_shipment',
    label: 'Shipment',
    display: 'tracking_number',
    schema: {
        direction: ChoiceColumn({
            label: 'Direction',
            choices: SHIPMENT_DIRECTION_CHOICES,
            mandatory: true,
            dropdown: 'dropdown_without_none',
        }),
        customer: ReferenceColumn({ label: 'Customer', referenceTable: 'customer_account' }),
        order: ReferenceColumn({ label: 'Order', referenceTable: 'x_daas_ham_order' }),
        return_order: ReferenceColumn({ label: 'Return order', referenceTable: 'x_daas_ham_return_order' }),
        site: ReferenceColumn({ label: 'Site', referenceTable: 'cmn_location' }),
        // NaaS stockrooms only (ADR 0016): domain/fleet `naasStockroomCondition()`.
        stockroom: ReferenceColumn({
            label: 'Depot',
            referenceTable: 'alm_stockroom',
            referenceQual: 'x_daas_ham_stockroom_typeINcentral_depot,staging_centre,customer_site',
        }),
        carrier: StringColumn({ label: 'Carrier', maxLength: 60, readOnly: true }),
        service_code: StringColumn({ label: 'Service', maxLength: 60, readOnly: true }),
        packages: IntegerColumn({ label: 'Packages', readOnly: true }),
        tracking_number: StringColumn({ label: 'Tracking number', maxLength: 100, readOnly: true }),
        label_id: StringColumn({ label: 'Label ID', maxLength: 100, readOnly: true }),
        label_url: UrlColumn({ label: 'Label', readOnly: true }),
        cost: DecimalColumn({ label: 'Cost', readOnly: true }),
        currency: StringColumn({ label: 'Currency', maxLength: 3, readOnly: true }),
        status: ChoiceColumn({ label: 'Status', choices: SHIPMENT_STATUS_CHOICES, default: 'label_created', readOnly: true, dropdown: 'dropdown_without_none' }),
        status_detail: StringColumn({ label: 'Latest update', maxLength: 255, readOnly: true }),
        estimated_delivery: DateColumn({ label: 'Estimated delivery', readOnly: true }),
        delivered_at: DateTimeColumn({ label: 'Delivered at', readOnly: true }),
    },
    autoNumber: { prefix: 'NSHP', number: 1000, numberOfDigits: 7 },
    index: [
        { name: 'x_daas_ham_shp_tracking', unique: false, element: 'tracking_number' },
        { name: 'x_daas_ham_shp_order', unique: false, element: 'order' },
        { name: 'x_daas_ham_shp_return', unique: false, element: 'return_order' },
    ],
})

export const x_daas_ham_shipment_event = Table({
    name: 'x_daas_ham_shipment_event',
    label: 'Shipment event',
    schema: {
        shipment: ReferenceColumn({ label: 'Shipment', referenceTable: 'x_daas_ham_shipment', mandatory: true, cascadeRule: 'delete' }),
        occurred_at: StringColumn({ label: 'Occurred at (carrier time)', maxLength: 40 }),
        status: ChoiceColumn({ label: 'Status', choices: SHIPMENT_STATUS_CHOICES }),
        description: StringColumn({ label: 'Description', maxLength: 255 }),
        location: StringColumn({ label: 'Location', maxLength: 120 }),
    },
    index: [{ name: 'x_daas_ham_she_shipment', unique: false, element: 'shipment' }],
})
