import '@servicenow/sdk/global'
import { ChoiceColumn, DecimalColumn, MultiLineTextColumn, ReferenceColumn, StringColumn, Table } from '@servicenow/sdk/core'

/* Disposal orders (P2.5, D61). */

const methodChoices = {
    broker_resale: { label: 'Broker resale', sequence: 0 },
    oem_takeback: { label: 'OEM takeback / trade-in', sequence: 1 },
    itad_recycle: { label: 'ITAD recycling', sequence: 2 },
    return_to_customer: { label: 'Return to customer', sequence: 3 },
    return_to_lessor: { label: 'Return to lessor', sequence: 4 },
}

/** Retiring Assets for good. */
export const x_daas_ham_disposal_order = Table({
    name: 'x_daas_ham_disposal_order',
    label: 'Disposal order',
    extends: 'task',
    schema: {
        method: ChoiceColumn({ label: 'Method', choices: methodChoices, mandatory: true, dropdown: 'dropdown_without_none' }),
        customer: ReferenceColumn({ label: 'Customer (customer-owned assets)', referenceTable: 'customer_account' }),
        disposal_vendor: ReferenceColumn({ label: 'Broker / ITAD vendor / OEM', referenceTable: 'core_company' }),
        certificate_number: StringColumn({ label: 'Certificate number', maxLength: 100 }),
        stage: ChoiceColumn({
            label: 'Stage',
            choices: {
                draft: { label: 'Draft', sequence: 0 },
                awaiting_approval: { label: 'Awaiting approval', sequence: 1 },
                approved: { label: 'Approved', sequence: 2 },
                completed: { label: 'Completed', sequence: 3 },
                rejected: { label: 'Rejected', sequence: 4 },
            },
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
        asset: ReferenceColumn({ label: 'Asset', referenceTable: 'alm_hardware', mandatory: true }),
        method: ChoiceColumn({ label: 'Method (blank = order method)', choices: methodChoices }),
        sale_amount: DecimalColumn({ label: 'Sale amount' }),
        credit_amount: DecimalColumn({ label: 'OEM credit' }),
        status: ChoiceColumn({
            label: 'Status',
            choices: {
                pending: { label: 'Pending', sequence: 0 },
                done: { label: 'Done', sequence: 1 },
                blocked: { label: 'Blocked', sequence: 2 },
            },
            default: 'pending',
            readOnly: true,
            dropdown: 'dropdown_without_none',
        }),
        blockers: MultiLineTextColumn({ label: 'Blocked by', maxLength: 1000, readOnly: true }),
    },
    index: [{ name: 'x_daas_ham_dl_order', unique: false, element: 'disposal_order' }],
})
