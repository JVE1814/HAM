import '@servicenow/sdk/global'
import {
    BooleanColumn,
    ChoiceColumn,
    DateColumn,
    DateTimeColumn,
    DecimalColumn,
    ReferenceColumn,
    StringColumn,
    Table,
} from '@servicenow/sdk/core'

/** Bringing Assets back from a Site (P2.4). */
export const x_daas_ham_return_order = Table({
    name: 'x_daas_ham_return_order',
    label: 'Return order',
    extends: 'task',
    schema: {
        trigger: ChoiceColumn({
            label: 'Trigger',
            choices: {
                site_decommission: { label: 'Site decommission', sequence: 0 },
                device_removal: { label: 'Device removal', sequence: 1 },
                refresh_swap_back: { label: 'Refresh swap-back', sequence: 2 },
                defective_return: { label: 'Defective return (break-fix)', sequence: 3 },
                agreement_end: { label: 'Agreement end', sequence: 4 },
                temporary_end: { label: 'Temporary deployment end', sequence: 5 },
            },
            mandatory: true,
            dropdown: 'dropdown_without_none',
        }),
        customer: ReferenceColumn({ label: 'Customer', referenceTable: 'customer_account', mandatory: true }),
        site: ReferenceColumn({ label: 'Site', referenceTable: 'cmn_location' }),
        agreement: ReferenceColumn({ label: 'Agreement', referenceTable: 'x_daas_ham_agreement' }),
        source_order: ReferenceColumn({ label: 'Raised by order', referenceTable: 'x_daas_ham_order' }),
        method: ChoiceColumn({
            label: 'Collection',
            choices: {
                fsm_deinstall: { label: 'Field engineer de-installs', sequence: 0 },
                ship_back: { label: 'Site contact ships back', sequence: 1 },
            },
            mandatory: true,
            default: 'ship_back',
            dropdown: 'dropdown_without_none',
        }),
        // Not due_date: Return orders extend task, whose due_date is a date-time; this is a date.
        due_back: DateColumn({ label: 'Due back by' }),
        carrier: StringColumn({ label: 'Carrier', maxLength: 60 }),
        tracking_number: StringColumn({ label: 'Tracking number', maxLength: 100 }),
        work_order: ReferenceColumn({ label: 'Work order', referenceTable: 'wm_order' }),
        change_request: ReferenceColumn({ label: 'Change request', referenceTable: 'change_request' }),
        escalated: BooleanColumn({ label: 'Overdue escalated', default: false, readOnly: true }),
    },
    autoNumber: { prefix: 'NRET', number: 1000, numberOfDigits: 7 },
    index: [
        { name: 'x_daas_ham_ret_customer', unique: false, element: 'customer' },
        { name: 'x_daas_ham_ret_due', unique: false, element: 'due_back' },
    ],
})

/** One Asset on a Return order, through receipt and depot evaluation. */
export const x_daas_ham_return_order_line = Table({
    name: 'x_daas_ham_return_order_line',
    label: 'Return line',
    schema: {
        return_order: ReferenceColumn({
            label: 'Return order',
            referenceTable: 'x_daas_ham_return_order',
            mandatory: true,
            cascadeRule: 'delete',
        }),
        // Fleet assets only (ADR 0016), here and on the Fee event: domain/fleet `fleetCondition()`.
        asset: ReferenceColumn({ label: 'Asset', referenceTable: 'alm_hardware', mandatory: true, referenceQual: 'x_daas_ham_fleet=true' }),
        status: ChoiceColumn({
            label: 'Status',
            choices: {
                awaiting: { label: 'Awaiting return', sequence: 0 },
                received: { label: 'Received', sequence: 1 },
                evaluated: { label: 'Evaluated', sequence: 2 },
                missing: { label: 'Declared missing', sequence: 3 },
            },
            default: 'awaiting',
            readOnly: true,
            dropdown: 'dropdown_without_none',
        }),
        received_at: DateTimeColumn({ label: 'Received at', readOnly: true }),
        condition: ChoiceColumn({
            label: 'Condition',
            choices: { good: { label: 'Good', sequence: 0 }, damaged: { label: 'Damaged', sequence: 1 } },
        }),
        evaluation: ChoiceColumn({
            label: 'Evaluation',
            choices: {
                refurbish: { label: 'Refurbish to stock', sequence: 0 },
                oem_rma: { label: 'Return to OEM (RMA)', sequence: 1 },
                scrap: { label: 'Scrap (wipe and dispose)', sequence: 2 },
                return_to_owner: { label: 'Return to owner (customer / lessor)', sequence: 3 },
            },
        }),
    },
    index: [
        { name: 'x_daas_ham_rl_order', unique: false, element: 'return_order' },
        { name: 'x_daas_ham_rl_asset', unique: false, element: 'asset' },
    ],
})

/** A one-off charge to a Customer for a lost, damaged or late Asset. */
export const x_daas_ham_fee_event = Table({
    name: 'x_daas_ham_fee_event',
    label: 'Fee event',
    schema: {
        fee_type: ChoiceColumn({
            label: 'Fee type',
            choices: {
                lost: { label: 'Lost asset', sequence: 0 },
                damaged: { label: 'Damaged asset', sequence: 1 },
                late_return: { label: 'Late return', sequence: 2 },
            },
            mandatory: true,
            dropdown: 'dropdown_without_none',
        }),
        customer: ReferenceColumn({ label: 'Customer', referenceTable: 'customer_account', mandatory: true }),
        agreement: ReferenceColumn({ label: 'Agreement', referenceTable: 'x_daas_ham_agreement' }),
        asset: ReferenceColumn({ label: 'Asset', referenceTable: 'alm_hardware', referenceQual: 'x_daas_ham_fleet=true' }),
        return_order: ReferenceColumn({ label: 'Return order', referenceTable: 'x_daas_ham_return_order' }),
        amount: DecimalColumn({ label: 'Amount', mandatory: true }),
        currency: StringColumn({ label: 'Currency', maxLength: 3, default: 'EUR' }),
        occurred_on: DateColumn({ label: 'Occurred on', mandatory: true }),
        status: ChoiceColumn({
            label: 'Status',
            choices: {
                open: { label: 'Open', sequence: 0 },
                billed: { label: 'Billed', sequence: 1 },
                waived: { label: 'Waived', sequence: 2 },
            },
            default: 'open',
            dropdown: 'dropdown_without_none',
        }),
        billing_period: ReferenceColumn({ label: 'Billed in', referenceTable: 'x_daas_ham_billing_period', readOnly: true }),
    },
    index: [
        { name: 'x_daas_ham_fee_customer', unique: false, element: 'customer' },
        { name: 'x_daas_ham_fee_occurred', unique: false, element: 'occurred_on' },
        { name: 'x_daas_ham_fee_period', unique: false, element: 'billing_period' },
    ],
})
