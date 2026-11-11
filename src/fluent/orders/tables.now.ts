import '@servicenow/sdk/global'
import { BooleanColumn, ChoiceColumn, DateColumn, IntegerColumn, ListColumn, ReferenceColumn, StringColumn, Table } from '@servicenow/sdk/core'
import {
    ENTITLEMENT_VERDICT_CHOICES,
    INSTALL_MODE_CHOICES,
    LINE_STAGE_CHOICES,
    ORDER_STAGE_CHOICES,
    ORDER_TYPE_CHOICES,
} from '../../server/domain/vocabulary'
import { FLEET_CONDITION, NAAS_MODEL_CONDITION } from '../../server/domain/fleet'

/** A request to deliver equipment to a Site. */
export const x_daas_ham_order = Table({
    name: 'x_daas_ham_order',
    label: 'Order',
    extends: 'task',
    schema: {
        order_type: ChoiceColumn({
            label: 'Order type',
            choices: ORDER_TYPE_CHOICES,
            mandatory: true,
            default: 'device_add',
            dropdown: 'dropdown_without_none',
        }),
        customer: ReferenceColumn({ label: 'Customer', referenceTable: 'customer_account', mandatory: true }),
        site: ReferenceColumn({ label: 'Site', referenceTable: 'cmn_location', mandatory: true }),
        agreement: ReferenceColumn({ label: 'Agreement', referenceTable: 'x_daas_ham_agreement', mandatory: true }),
        site_template: ReferenceColumn({ label: 'Site template', referenceTable: 'x_daas_ham_site_template' }),
        install_mode: ChoiceColumn({
            label: 'Install mode',
            choices: INSTALL_MODE_CHOICES,
            mandatory: true,
            default: 'fsm_engineer',
            dropdown: 'dropdown_without_none',
        }),
        requested_date: DateColumn({ label: 'Requested install date' }),
        end_date: DateColumn({ label: 'Deployment end date' }),
        stage: ChoiceColumn({
            label: 'Stage',
            choices: ORDER_STAGE_CHOICES,
            default: 'draft',
            readOnly: true,
            dropdown: 'dropdown_without_none',
        }),
        entitlement_verdict: ChoiceColumn({
            label: 'Entitlement',
            readOnly: true,
            choices: ENTITLEMENT_VERDICT_CHOICES,
        }),
        // A string column, not a multi-line one: the classic form draws a multi_two_lines column this long with no field
        // container, and the live form update after Submit then throws on it.
        entitlement_findings: StringColumn({ label: 'Entitlement findings', maxLength: 4000, readOnly: true }),
        change_request: ReferenceColumn({ label: 'Change request', referenceTable: 'change_request' }),
        work_order: ReferenceColumn({ label: 'Work order', referenceTable: 'wm_order' }),
        tracking_number: StringColumn({ label: 'Tracking number', maxLength: 100 }),
        carrier: StringColumn({ label: 'Carrier', maxLength: 60 }),
        case: ReferenceColumn({ label: 'Case', referenceTable: 'sn_customerservice_case' }),
        return_raised: BooleanColumn({ label: 'Return raised', default: false, readOnly: true }),
        /** Who decides for the Customer admins, as it was when the Order was put to approval (platform/approvals). */
        approval_customer_admins: ListColumn({ label: 'Customer admins asked', referenceTable: 'sys_user', readOnly: true }),
    },
    autoNumber: { prefix: 'NORD', number: 1000, numberOfDigits: 7 },
    index: [
        { name: 'x_daas_ham_ord_customer', unique: false, element: 'customer' },
        { name: 'x_daas_ham_ord_site', unique: false, element: 'site' },
        { name: 'x_daas_ham_ord_stage', unique: false, element: 'stage' },
    ],
})

/** One Model and quantity within an Order. */
export const x_daas_ham_order_line = Table({
    name: 'x_daas_ham_order_line',
    label: 'Order line',
    display: 'number',
    schema: {
        number: StringColumn({ label: 'Number', default: 'javascript:global.getNextObjNumberPadded();', readOnly: true }),
        order: ReferenceColumn({
            label: 'Order',
            referenceTable: 'x_daas_ham_order',
            mandatory: true,
            cascadeRule: 'delete',
        }),
        model: ReferenceColumn({ label: 'Model', referenceTable: 'cmdb_model', mandatory: true, referenceQual: NAAS_MODEL_CONDITION }),
        quantity: IntegerColumn({ label: 'Quantity', mandatory: true, default: 1, min: 1 }),
        replaces_asset: ReferenceColumn({ label: 'Replaces asset', referenceTable: 'alm_hardware', referenceQual: FLEET_CONDITION }),
        from_site_template: BooleanColumn({ label: 'From site template', default: false, readOnly: true }),
        line_stage: ChoiceColumn({
            label: 'Line stage',
            choices: LINE_STAGE_CHOICES,
            default: 'new',
            readOnly: true,
            dropdown: 'dropdown_without_none',
        }),
        quantity_allocated: IntegerColumn({ label: 'Allocated from stock', readOnly: true, default: 0 }),
        /** Units bought for the line and not yet received: each one received on its purchase orders comes off. */
        quantity_to_purchase: IntegerColumn({ label: 'On order', readOnly: true, default: 0 }),
        sourcing_summary: StringColumn({ label: 'Sourcing', maxLength: 255, readOnly: true }),
        transfer_orders: ListColumn({ label: 'Transfer orders', referenceTable: 'alm_transfer_order' }),
        purchase_order: ReferenceColumn({ label: 'Latest purchase order', referenceTable: 'proc_po' }),
        /** Every purchase order the line raised: a receipt on any of them is allocated to the line. */
        purchase_orders: ListColumn({ label: 'Purchase orders', referenceTable: 'proc_po', readOnly: true }),
    },
    autoNumber: { prefix: 'NOL', number: 1000, numberOfDigits: 7 },
    index: [
        { name: 'x_daas_ham_ol_order', unique: false, element: 'order' },
        { name: 'x_daas_ham_ol_stage', unique: false, element: 'line_stage' },
    ],
})
