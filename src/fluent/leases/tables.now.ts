import '@servicenow/sdk/global'
import {
    BooleanColumn,
    ChoiceColumn,
    DateColumn,
    DecimalColumn,
    IntegerColumn,
    OverrideColumn,
    ReferenceColumn,
    StringColumn,
    Table,
} from '@servicenow/sdk/core'
import { LEASE_END_ACTION, LEASE_END_ACTION_CHOICES } from '../../server/domain/vocabulary'

export const x_daas_ham_lease_schedule = Table({
    name: 'x_daas_ham_lease_schedule',
    label: 'Lease schedule',
    extends: 'ast_contract',
    schema: {
        // Inherited from ast_contract (ADR 0018), required here: the Lessor is the contract's Vendor (a company marked
        // as a vendor), and the number the Lessor gives the schedule its Contract number, which the platform shows a
        // reference to a contract by.
        vendor: OverrideColumn({ mandatory: true }),
        vendor_contract: OverrideColumn({ mandatory: true }),
        monthly_payment: DecimalColumn({ label: 'Monthly payment (all assets)' }),
        buyout_price: DecimalColumn({ label: 'Buyout price' }),
        buyout_share: DecimalColumn({ label: 'Buyout cost per asset', readOnly: true, scale: 6 }),
        buyout_extra_through: StringColumn({ label: 'Buyout: one cent more up to asset', maxLength: 32, readOnly: true }),
        buyout_assets: IntegerColumn({ label: 'Assets covered at buyout', readOnly: true }),
        decision_lead_days: IntegerColumn({ label: 'Decide this many days before the end', default: 120, min: 0 }),
        end_action: ChoiceColumn({
            label: 'End-of-lease action',
            choices: LEASE_END_ACTION_CHOICES,
            default: LEASE_END_ACTION.undecided,
            readOnly: true,
            dropdown: 'dropdown_without_none',
        }),
        mismatch: BooleanColumn({ label: 'Ends before the service it supports', default: false, readOnly: true }),
    },
    autoNumber: { prefix: 'NLS', number: 1000, numberOfDigits: 7 },
})

export const x_daas_ham_lease_decision = Table({
    name: 'x_daas_ham_lease_decision',
    label: 'End-of-lease decision',
    extends: 'task',
    schema: {
        lease: ReferenceColumn({ label: 'Lease schedule', referenceTable: 'x_daas_ham_lease_schedule', mandatory: true }),
        lease_end: DateColumn({ label: 'Lease ends', readOnly: true }),
        decision: ChoiceColumn({
            label: 'Decision',
            choices: {
                buyout: LEASE_END_ACTION_CHOICES.buyout,
                extend: LEASE_END_ACTION_CHOICES.extend,
                return: LEASE_END_ACTION_CHOICES.return,
            },
        }),
        new_end_date: DateColumn({ label: 'New end date (extension)' }),
        covered_assets: IntegerColumn({ label: 'Covered assets', readOnly: true }),
        deployed_assets: IntegerColumn({ label: 'Deployed at customer sites', readOnly: true }),
        mismatch: BooleanColumn({ label: 'Ends before the service it supports', default: false, readOnly: true }),
    },
    autoNumber: { prefix: 'NLD', number: 1000, numberOfDigits: 7 },
    index: [{ name: 'x_daas_ham_ld_lease', unique: false, element: 'lease' }],
})
