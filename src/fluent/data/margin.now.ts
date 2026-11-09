import '@servicenow/sdk/global'
import { ChoiceColumn, DecimalColumn, ReferenceColumn, StringColumn, Table } from '@servicenow/sdk/core'
import { COST_TYPE_CHOICES } from '../../server/domain/vocabulary'

/* Cost facts and Margin per Customer and Site (P3.28, D72). */

/** A cost attributed to a Customer and Site for one Billing period. */
export const x_daas_ham_cost_fact = Table({
    name: 'x_daas_ham_cost_fact',
    label: 'Cost fact',
    schema: {
        billing_period: ReferenceColumn({ label: 'Billing period', referenceTable: 'x_daas_ham_billing_period', mandatory: true, cascadeRule: 'delete' }),
        customer: ReferenceColumn({ label: 'Customer', referenceTable: 'customer_account', mandatory: true }),
        site: ReferenceColumn({ label: 'Site', referenceTable: 'cmn_location' }),
        cost_type: ChoiceColumn({
            label: 'Cost type',
            choices: COST_TYPE_CHOICES,
            mandatory: true,
            dropdown: 'dropdown_without_none',
        }),
        amount: DecimalColumn({ label: 'Amount', mandatory: true }),
        currency: StringColumn({ label: 'Currency', maxLength: 3, default: 'EUR' }),
    },
    index: [
        { name: 'x_daas_ham_cf_period', unique: false, element: 'billing_period' },
        { name: 'x_daas_ham_cf_customer', unique: false, element: 'customer' },
    ],
})

/** Subscription and fee revenue minus Cost facts, per Customer and Site, for one Billing period. */
export const x_daas_ham_margin = Table({
    name: 'x_daas_ham_margin',
    label: 'Margin',
    schema: {
        billing_period: ReferenceColumn({ label: 'Billing period', referenceTable: 'x_daas_ham_billing_period', mandatory: true, cascadeRule: 'delete' }),
        customer: ReferenceColumn({ label: 'Customer', referenceTable: 'customer_account', mandatory: true }),
        site: ReferenceColumn({ label: 'Site (blank = customer-level fees and costs)', referenceTable: 'cmn_location' }),
        revenue: DecimalColumn({ label: 'Revenue' }),
        cost: DecimalColumn({ label: 'Cost' }),
        margin: DecimalColumn({ label: 'Margin' }),
        margin_pct: DecimalColumn({ label: 'Margin %' }),
    },
    index: [
        { name: 'x_daas_ham_mg_period', unique: false, element: 'billing_period' },
        { name: 'x_daas_ham_mg_customer', unique: false, element: 'customer' },
    ],
})
