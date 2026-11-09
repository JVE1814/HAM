import '@servicenow/sdk/global'
import { ChoiceColumn, DecimalColumn, ReferenceColumn, StringColumn, Table } from '@servicenow/sdk/core'
import { DISPOSAL_LINE_STATUS_CHOICES, DISPOSAL_METHOD_CHOICES, DISPOSAL_STAGE_CHOICES } from '../../server/domain/vocabulary'

/* Disposal orders (P2.5, D61). */

/** Retiring Assets for good. */
export const x_daas_ham_disposal_order = Table({
    name: 'x_daas_ham_disposal_order',
    label: 'Disposal order',
    extends: 'task',
    schema: {
        method: ChoiceColumn({ label: 'Method', choices: DISPOSAL_METHOD_CHOICES, mandatory: true, dropdown: 'dropdown_without_none' }),
        customer: ReferenceColumn({ label: 'Customer (customer-owned assets)', referenceTable: 'customer_account' }),
        disposal_vendor: ReferenceColumn({ label: 'Broker / ITAD vendor / OEM', referenceTable: 'core_company' }),
        certificate_number: StringColumn({ label: 'Certificate number', maxLength: 100 }),
        stage: ChoiceColumn({
            label: 'Stage',
            choices: DISPOSAL_STAGE_CHOICES,
            default: 'draft',
            readOnly: true,
            dropdown: 'dropdown_without_none',
        }),
    },
    autoNumber: { prefix: 'NDSP', number: 1000, numberOfDigits: 7 },
})

export const x_daas_ham_disposal_line = Table({
    name: 'x_daas_ham_disposal_line',
    label: 'Disposal line',
    schema: {
        disposal_order: ReferenceColumn({
            label: 'Disposal order',
            referenceTable: 'x_daas_ham_disposal_order',
            mandatory: true,
            cascadeRule: 'delete',
        }),
        // Fleet assets only (ADR 0016): domain/fleet `fleetCondition()`.
        asset: ReferenceColumn({ label: 'Asset', referenceTable: 'alm_hardware', mandatory: true, referenceQual: 'x_daas_ham_fleet=true' }),
        method: ChoiceColumn({ label: 'Method (blank = order method)', choices: DISPOSAL_METHOD_CHOICES }),
        sale_amount: DecimalColumn({ label: 'Sale amount' }),
        credit_amount: DecimalColumn({ label: 'OEM credit' }),
        status: ChoiceColumn({
            label: 'Status',
            choices: DISPOSAL_LINE_STATUS_CHOICES,
            default: 'pending',
            readOnly: true,
            dropdown: 'dropdown_without_none',
        }),
        // A string column (see Order entitlement_findings): the form draws it inside its field container.
        blockers: StringColumn({ label: 'Blocked by', maxLength: 1000, readOnly: true }),
    },
    index: [{ name: 'x_daas_ham_dl_order', unique: false, element: 'disposal_order' }],
})
