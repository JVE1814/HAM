import '@servicenow/sdk/global'
import { BooleanColumn, ChoiceColumn, DateColumn, DateTimeColumn, DecimalColumn, ReferenceColumn, StringColumn, Table } from '@servicenow/sdk/core'
import {
    EVALUATION_OUTCOME_CHOICES,
    FEE_STATUS,
    FEE_STATUS_CHOICES,
    FEE_TYPE_CHOICES,
    RETURN_CONDITION_CHOICES,
    RETURN_LINE_STATUS,
    RETURN_LINE_STATUS_CHOICES,
    RETURN_METHOD,
    RETURN_METHOD_CHOICES,
    RETURN_TRIGGER_CHOICES,
} from '../../server/domain/vocabulary'
import { FLEET_CONDITION } from '../../server/domain/fleet'

/** Bringing Assets back from a Site (P2.4). */
export const x_daas_ham_return_order = Table({
    name: 'x_daas_ham_return_order',
    label: 'Return order',
    extends: 'task',
    schema: {
        trigger: ChoiceColumn({
            label: 'Trigger',
            choices: RETURN_TRIGGER_CHOICES,
            mandatory: true,
            dropdown: 'dropdown_without_none',
        }),
        customer: ReferenceColumn({ label: 'Customer', referenceTable: 'customer_account', mandatory: true }),
        site: ReferenceColumn({ label: 'Site', referenceTable: 'cmn_location' }),
        agreement: ReferenceColumn({ label: 'Agreement', referenceTable: 'x_daas_ham_agreement' }),
        source_order: ReferenceColumn({ label: 'Raised by order', referenceTable: 'x_daas_ham_order' }),
        method: ChoiceColumn({
            label: 'Collection',
            choices: RETURN_METHOD_CHOICES,
            mandatory: true,
            default: RETURN_METHOD.ship_back,
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
        asset: ReferenceColumn({ label: 'Asset', referenceTable: 'alm_hardware', mandatory: true, referenceQual: FLEET_CONDITION }),
        status: ChoiceColumn({
            label: 'Status',
            choices: RETURN_LINE_STATUS_CHOICES,
            default: RETURN_LINE_STATUS.awaiting,
            readOnly: true,
            dropdown: 'dropdown_without_none',
        }),
        received_at: DateTimeColumn({ label: 'Received at', readOnly: true }),
        condition: ChoiceColumn({
            label: 'Condition',
            choices: RETURN_CONDITION_CHOICES,
        }),
        evaluation: ChoiceColumn({
            label: 'Evaluation',
            choices: EVALUATION_OUTCOME_CHOICES,
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
            choices: FEE_TYPE_CHOICES,
            mandatory: true,
            dropdown: 'dropdown_without_none',
        }),
        customer: ReferenceColumn({ label: 'Customer', referenceTable: 'customer_account', mandatory: true }),
        agreement: ReferenceColumn({ label: 'Agreement', referenceTable: 'x_daas_ham_agreement' }),
        asset: ReferenceColumn({ label: 'Asset', referenceTable: 'alm_hardware', referenceQual: FLEET_CONDITION }),
        return_order: ReferenceColumn({ label: 'Return order', referenceTable: 'x_daas_ham_return_order' }),
        amount: DecimalColumn({ label: 'Amount', mandatory: true }),
        // Not billed: a fee bills in its Agreement's currency (else the one its Customer's Agreements share), so a copy
        // here could only disagree with it. Kept (read-only, no default) for the values saved before, as on Subscription lines.
        currency: StringColumn({ label: 'Currency (unused: billed in the Agreement currency)', maxLength: 3, readOnly: true }),
        occurred_on: DateColumn({ label: 'Occurred on', mandatory: true }),
        status: ChoiceColumn({
            label: 'Status',
            choices: FEE_STATUS_CHOICES,
            default: FEE_STATUS.open,
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
