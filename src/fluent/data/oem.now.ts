import '@servicenow/sdk/global'
import { BooleanColumn, ChoiceColumn, DateColumn, DateTimeColumn, DecimalColumn, ReferenceColumn, StringColumn, Table } from '@servicenow/sdk/core'

/* OEM coverage contracts and RMAs (P2.1, P2.3). */

const vendorChoices = {
    cisco: { label: 'Cisco', sequence: 0 },
    meraki: { label: 'Cisco Meraki', sequence: 1 },
    aruba: { label: 'HPE Aruba', sequence: 2 },
    mist: { label: 'HPE Mist', sequence: 3 },
    fortinet: { label: 'Fortinet', sequence: 4 },
    checkpoint: { label: 'Check Point', sequence: 5 },
}

/** The manufacturer support contract covering one serial number. */
export const x_daas_ham_oem_coverage = Table({
    name: 'x_daas_ham_oem_coverage',
    label: 'OEM coverage',
    schema: {
        asset: ReferenceColumn({ label: 'Asset', referenceTable: 'alm_hardware' }),
        serial_number: StringColumn({ label: 'Serial number', maxLength: 100, mandatory: true }),
        vendor: ChoiceColumn({ label: 'Vendor', choices: vendorChoices, mandatory: true }),
        contract_number: StringColumn({ label: 'Contract number', maxLength: 100 }),
        service_level: StringColumn({ label: 'Service level', maxLength: 160 }),
        covered: BooleanColumn({ label: 'Covered', default: true }),
        start_date: DateColumn({ label: 'Start date' }),
        end_date: DateColumn({ label: 'End date' }),
        source: ChoiceColumn({
            label: 'Source',
            choices: { api: { label: 'OEM API', sequence: 0 }, csv: { label: 'CSV import', sequence: 1 }, manual: { label: 'Manual', sequence: 2 } },
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

/** A return authorisation opened with the manufacturer for a defective Asset. */
export const x_daas_ham_oem_rma = Table({
    name: 'x_daas_ham_oem_rma',
    label: 'OEM RMA',
    display: 'rma_number',
    schema: {
        vendor: ChoiceColumn({ label: 'Vendor', choices: vendorChoices, mandatory: true }),
        rma_number: StringColumn({ label: 'RMA number', maxLength: 60 }),
        defective_asset: ReferenceColumn({ label: 'Defective asset', referenceTable: 'alm_hardware', mandatory: true }),
        order_line: ReferenceColumn({ label: 'Replacement order line', referenceTable: 'x_daas_ham_order_line' }),
        case: ReferenceColumn({ label: 'Case', referenceTable: 'sn_customerservice_case' }),
        advance_replacement: BooleanColumn({ label: 'OEM advance replacement', default: true }),
        replacement_serial: StringColumn({ label: 'Replacement serial', maxLength: 100 }),
        status: StringColumn({ label: 'OEM status', maxLength: 100 }),
        state: ChoiceColumn({
            label: 'State',
            choices: {
                to_open: { label: 'To open with OEM', sequence: 0 },
                open: { label: 'Open', sequence: 1 },
                replacement_received: { label: 'Replacement received', sequence: 2 },
                defective_returned: { label: 'Defective returned to OEM', sequence: 3 },
                closed: { label: 'Closed', sequence: 4 },
            },
            default: 'to_open',
            dropdown: 'dropdown_without_none',
        }),
        ship_back_due: DateColumn({ label: 'Return defective by' }),
        last_synced: DateTimeColumn({ label: 'Last synced', readOnly: true }),
    },
    index: [{ name: 'x_daas_ham_rma_number', unique: false, element: 'rma_number' }],
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
