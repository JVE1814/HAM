import '@servicenow/sdk/global'
import { BooleanColumn, ChoiceColumn, DateColumn, DateTimeColumn, DecimalColumn, ReferenceColumn, StringColumn, Table } from '@servicenow/sdk/core'
import { CLAIM_ACTION_CHOICES, CLOUD_ACCOUNT_VENDOR_CHOICES, COVERAGE_SOURCE_CHOICES, OEM_VENDOR_CHOICES } from '../../server/domain/vocabulary'
import { FLEET_CONDITION } from '../../server/domain/fleet'

/** The manufacturer support contract covering one serial number. */
export const x_daas_ham_oem_coverage = Table({
    name: 'x_daas_ham_oem_coverage',
    label: 'OEM coverage',
    schema: {
        asset: ReferenceColumn({ label: 'Asset', referenceTable: 'alm_hardware', referenceQual: FLEET_CONDITION }),
        serial_number: StringColumn({ label: 'Serial number', maxLength: 100, mandatory: true }),
        vendor: ChoiceColumn({ label: 'Vendor', choices: OEM_VENDOR_CHOICES, mandatory: true }),
        contract_number: StringColumn({ label: 'Contract number', maxLength: 100 }),
        service_level: StringColumn({ label: 'Service level', maxLength: 160 }),
        covered: BooleanColumn({ label: 'Covered', default: true }),
        start_date: DateColumn({ label: 'Start date' }),
        end_date: DateColumn({ label: 'End date' }),
        source: ChoiceColumn({
            label: 'Source',
            choices: COVERAGE_SOURCE_CHOICES,
            default: 'manual',
        }),
        last_checked: DateTimeColumn({ label: 'Last checked', readOnly: true }),
        expiry_notified: BooleanColumn({ label: 'Expiry warning sent', default: false, readOnly: true }),
        annual_cost: DecimalColumn({ label: 'Annual cost to the Provider' }),
    },
    index: [
        { name: 'x_daas_ham_cov_serial', unique: false, element: 'serial_number' },
        { name: 'x_daas_ham_cov_asset', unique: false, element: 'asset' },
        { name: 'x_daas_ham_cov_end', unique: false, element: 'end_date' },
    ],
})

/** Coverage contracts for vendors without an API. */
export const x_daas_ham_coverage_import = Table({
    name: 'x_daas_ham_coverage_import',
    label: 'OEM coverage import',
    extends: 'sys_import_set_row',
    schema: {
        vendor: StringColumn({ label: 'Vendor (cisco, meraki, aruba, mist, fortinet, checkpoint)', maxLength: 20 }),
        serial_number: StringColumn({ label: 'Serial number', maxLength: 100 }),
        contract_number: StringColumn({ label: 'Contract number', maxLength: 100 }),
        service_level: StringColumn({ label: 'Service level', maxLength: 160 }),
        start_date: StringColumn({ label: 'Start date (YYYY-MM-DD)', maxLength: 20 }),
        end_date: StringColumn({ label: 'End date (YYYY-MM-DD)', maxLength: 20 }),
        annual_cost: StringColumn({ label: 'Annual cost (optional)', maxLength: 20 }),
    },
})

/** A Customer's account in a manufacturer cloud that claimed devices go to (plan §13 OEM claim adapters). */
export const x_daas_ham_cloud_account = Table({
    name: 'x_daas_ham_cloud_account',
    label: 'OEM cloud account',
    display: 'account_id',
    schema: {
        customer: ReferenceColumn({ label: 'Customer', referenceTable: 'customer_account', mandatory: true }),
        vendor: ChoiceColumn({
            label: 'Vendor',
            choices: CLOUD_ACCOUNT_VENDOR_CHOICES,
            mandatory: true,
            dropdown: 'dropdown_without_none',
        }),
        purpose: ChoiceColumn({ label: 'Used for', choices: CLAIM_ACTION_CHOICES, mandatory: true, dropdown: 'dropdown_without_none' }),
        account_id: StringColumn({ label: 'Account', maxLength: 100, mandatory: true }),
    },
    index: [{ name: 'x_daas_ham_ca_customer', unique: false, element: 'customer' }],
})
