import '@servicenow/sdk/global'
import { ChoiceColumn, DecimalColumn, ReferenceColumn, StringColumn, Table } from '@servicenow/sdk/core'

/* Cost facts and Margin per Customer, Site and currency (P3.28, D72). */

/** A cost attributed to a Customer and Site, in one currency, for one Billing period. */
export const x_daas_ham_cost_fact = Table({
    name: 'x_daas_ham_cost_fact',
    label: 'Cost fact',
    schema: {
        billing_period: ReferenceColumn({ label: 'Billing period', referenceTable: 'x_daas_ham_billing_period', mandatory: true, cascadeRule: 'delete' }),
        customer: ReferenceColumn({ label: 'Customer', referenceTable: 'customer_account', mandatory: true }),
        site: ReferenceColumn({ label: 'Site', referenceTable: 'cmn_location' }),
        cost_type: ChoiceColumn({
            label: 'Cost type',
            choices: {
                purchase: { label: 'Purchase (written off)', sequence: 0 },
                lease: { label: 'Lease payment', sequence: 1 },
                oem_support: { label: 'OEM support', sequence: 2 },
                field_labour: { label: 'Field labour', sequence: 3 },
                shipping: { label: 'Shipping (carrier labels)', sequence: 4 },
            },
            mandatory: true,
            dropdown: 'dropdown_without_none',
        }),
        amount: DecimalColumn({ label: 'Amount', mandatory: true }),
        // Its Agreement's (a shipment's, its carrier's), set by the margin pass: never a default.
        currency: StringColumn({ label: 'Currency', maxLength: 3, mandatory: true }),
    },
    index: [
        { name: 'x_daas_ham_cf_period', unique: false, element: 'billing_period' },
        { name: 'x_daas_ham_cf_customer', unique: false, element: 'customer' },
    ],
})

/** Subscription and fee revenue minus Cost facts, per Customer, Site and currency, for one Billing period (two currencies are never added). */
export const x_daas_ham_margin = Table({
    name: 'x_daas_ham_margin',
    label: 'Margin',
    schema: {
        billing_period: ReferenceColumn({ label: 'Billing period', referenceTable: 'x_daas_ham_billing_period', mandatory: true, cascadeRule: 'delete' }),
        customer: ReferenceColumn({ label: 'Customer', referenceTable: 'customer_account', mandatory: true }),
        site: ReferenceColumn({ label: 'Site (blank = customer-level fees and costs)', referenceTable: 'cmn_location' }),
        // A Customer and Site with amounts in two currencies get a row for each.
        currency: StringColumn({ label: 'Currency', maxLength: 3, mandatory: true }),
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
