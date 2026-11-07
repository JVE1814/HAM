import '@servicenow/sdk/global'
import { BooleanColumn, ChoiceColumn, DateColumn, DecimalColumn, IntegerColumn, ReferenceColumn, StringColumn, Table } from '@servicenow/sdk/core'

/* Lease schedules and end-of-lease decisions (P3.23, D65). */

const endActionChoices = {
    undecided: { label: 'Undecided', sequence: 0 },
    buyout: { label: 'Buy out', sequence: 1 },
    extend: { label: 'Extend', sequence: 2 },
    return: { label: 'Return to lessor', sequence: 3 },
}

/** A financing contract with a Lessor covering a set of Assets until an end date. */
export const x_daas_ham_lease_schedule = Table({
    name: 'x_daas_ham_lease_schedule',
    label: 'Lease schedule',
    extends: 'ast_contract',
    schema: {
        lessor: ReferenceColumn({ label: 'Lessor', referenceTable: 'core_company', mandatory: true }),
        schedule_number: StringColumn({ label: 'Schedule number', maxLength: 60 }),
        monthly_payment: DecimalColumn({ label: 'Monthly payment (all assets)' }),
        buyout_price: DecimalColumn({ label: 'Buyout price' }),
        decision_lead_days: IntegerColumn({ label: 'Decide this many days before the end', default: 120, min: 0 }),
        end_action: ChoiceColumn({
            label: 'End-of-lease action',
            choices: endActionChoices,
            default: 'undecided',
            readOnly: true,
            dropdown: 'dropdown_without_none',
        }),
        mismatch: BooleanColumn({ label: 'Ends before the service it supports', default: false, readOnly: true }),
    },
    autoNumber: { prefix: 'NLS', number: 1000, numberOfDigits: 7 },
    index: [{ name: 'x_daas_ham_ls_lessor', unique: false, element: 'lessor' }],
})

/** The buy-out / extend / return decision raised ahead of a lease end. */
export const x_daas_ham_lease_decision = Table({
    name: 'x_daas_ham_lease_decision',
    label: 'End-of-lease decision',
    extends: 'task',
    schema: {
        lease: ReferenceColumn({ label: 'Lease schedule', referenceTable: 'x_daas_ham_lease_schedule', mandatory: true }),
        lease_end: DateColumn({ label: 'Lease ends', readOnly: true }),
        decision: ChoiceColumn({
            label: 'Decision',
            choices: { buyout: endActionChoices.buyout, extend: endActionChoices.extend, return: endActionChoices.return },
        }),
        new_end_date: DateColumn({ label: 'New end date (extension)' }),
        covered_assets: IntegerColumn({ label: 'Covered assets', readOnly: true }),
        deployed_assets: IntegerColumn({ label: 'Deployed at customer sites', readOnly: true }),
        mismatch: BooleanColumn({ label: 'Ends before the service it supports', default: false, readOnly: true }),
    },
    autoNumber: { prefix: 'NLD', number: 1000, numberOfDigits: 7 },
    index: [{ name: 'x_daas_ham_ld_lease', unique: false, element: 'lease' }],
})
