import '@servicenow/sdk/global'
import { ChoiceColumn, DateColumn, DateTimeColumn, DecimalColumn, IntegerColumn, ReferenceColumn, StringColumn, Table } from '@servicenow/sdk/core'
import { BILLING_LINE_KIND_CHOICES, BILLING_PERIOD_STATUS_CHOICES } from '../../server/domain/vocabulary'
import { FLEET_CONDITION } from '../../server/domain/fleet'

/* Service intervals, billing periods and their lines (P3.25, D52, D66). */

/** The days one Asset delivered a Subscription line: from in service to the day it goes on a Return order. */
export const x_daas_ham_service_interval = Table({
    name: 'x_daas_ham_service_interval',
    label: 'Service interval',
    schema: {
        asset: ReferenceColumn({ label: 'Asset', referenceTable: 'alm_hardware', mandatory: true, referenceQual: FLEET_CONDITION }),
        subscription_line: ReferenceColumn({ label: 'Subscription line', referenceTable: 'x_daas_ham_subscription_line', mandatory: true }),
        customer: ReferenceColumn({ label: 'Customer', referenceTable: 'customer_account' }),
        site: ReferenceColumn({ label: 'Site', referenceTable: 'cmn_location' }),
        start_date: DateColumn({ label: 'First day', mandatory: true }),
        end_date: DateColumn({ label: 'Last day' }),
    },
    index: [
        { name: 'x_daas_ham_si_line', unique: false, element: 'subscription_line' },
        { name: 'x_daas_ham_si_asset', unique: false, element: 'asset' },
    ],
})

/** A calendar month of prorated Subscription line charges and Fee events, locked once closed. */
export const x_daas_ham_billing_period = Table({
    name: 'x_daas_ham_billing_period',
    label: 'Billing period',
    display: 'period',
    schema: {
        period: StringColumn({ label: 'Month (YYYY-MM)', maxLength: 7, mandatory: true }),
        period_start: DateColumn({ label: 'First day', readOnly: true }),
        period_end: DateColumn({ label: 'Last day', readOnly: true }),
        status: ChoiceColumn({
            label: 'Status',
            choices: BILLING_PERIOD_STATUS_CHOICES,
            default: 'generating',
            readOnly: true,
            dropdown: 'dropdown_without_none',
        }),
        generated_at: DateTimeColumn({ label: 'Generated at', readOnly: true }),
        failed_lines: IntegerColumn({ label: 'Lines that failed to bill', default: 0, readOnly: true }),
        last_error: StringColumn({ label: 'Last generation error', maxLength: 255, readOnly: true }),
        /** Service intervals the latest margin computation failed to cost (its Cost facts and Margin miss them), with the last error; both cleared as one starts. */
        margin_failed: IntegerColumn({ label: 'Service intervals that failed to cost', default: 0, readOnly: true }),
        margin_error: StringColumn({ label: 'Last margin error', maxLength: 255, readOnly: true }),
        line_count: IntegerColumn({ label: 'Lines', readOnly: true }),
        total_amount: DecimalColumn({ label: 'Total', readOnly: true }),
        closed_at: DateTimeColumn({ label: 'Closed at', readOnly: true }),
        closed_by: ReferenceColumn({ label: 'Closed by', referenceTable: 'sys_user', readOnly: true }),
    },
    index: [{ name: 'x_daas_ham_bp_period', unique: true, element: 'period' }],
})

/** One charge of a Billing period: a Subscription line at a Site, or a Fee event. */
export const x_daas_ham_billing_line = Table({
    name: 'x_daas_ham_billing_line',
    label: 'Billing line',
    schema: {
        billing_period: ReferenceColumn({ label: 'Billing period', referenceTable: 'x_daas_ham_billing_period', mandatory: true, cascadeRule: 'delete' }),
        kind: ChoiceColumn({
            label: 'Kind',
            choices: BILLING_LINE_KIND_CHOICES,
            mandatory: true,
            dropdown: 'dropdown_without_none',
        }),
        customer: ReferenceColumn({ label: 'Customer', referenceTable: 'customer_account', mandatory: true }),
        agreement: ReferenceColumn({ label: 'Agreement', referenceTable: 'x_daas_ham_agreement' }),
        subscription_line: ReferenceColumn({ label: 'Subscription line', referenceTable: 'x_daas_ham_subscription_line' }),
        site: ReferenceColumn({ label: 'Site', referenceTable: 'cmn_location' }),
        fee_event: ReferenceColumn({ label: 'Fee event', referenceTable: 'x_daas_ham_fee_event' }),
        description: StringColumn({ label: 'Description', maxLength: 200 }),
        units: DecimalColumn({ label: 'Units (days or device-days)' }),
        monthly_rate: DecimalColumn({ label: 'Monthly rate' }),
        amount: DecimalColumn({ label: 'Amount', mandatory: true }),
        currency: StringColumn({ label: 'Currency', maxLength: 3, default: 'EUR' }),
    },
    index: [
        { name: 'x_daas_ham_bl_period', unique: false, element: 'billing_period' },
        { name: 'x_daas_ham_bl_customer', unique: false, element: 'customer' },
        { name: 'x_daas_ham_bl_period_customer', unique: false, element: ['billing_period', 'customer'] },
    ],
})
