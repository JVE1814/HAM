import '@servicenow/sdk/global'
import { StringColumn, Table } from '@servicenow/sdk/core'

/*
 * Import-set staging tables. Load a CSV into them with System Import Sets > Load Data; rows are
 * processed by the rules in logic/model-rules.now.ts (no transform map), which set the row's import
 * state and comment.
 */

/** Advance shipment notice lines from a distributor. */
export const x_daas_ham_asn_import = Table({
    name: 'x_daas_ham_asn_import',
    label: 'ASN import',
    extends: 'sys_import_set_row',
    schema: {
        distributor: StringColumn({ label: 'Distributor', maxLength: 100 }),
        po_number: StringColumn({ label: 'PO number', maxLength: 40 }),
        manufacturer: StringColumn({ label: 'Manufacturer', maxLength: 100 }),
        pid: StringColumn({ label: 'PID', maxLength: 100 }),
        serial: StringColumn({ label: 'Serial number', maxLength: 100 }),
        mac_address: StringColumn({ label: 'MAC address', maxLength: 40 }),
        claim_code: StringColumn({ label: 'OEM claim code', maxLength: 40 }),
        customer_tag: StringColumn({ label: 'Customer tag', maxLength: 80 }),
        staging_source: StringColumn({ label: 'Staging source (in_house/distributor)', maxLength: 20 }),
        ship_date: StringColumn({ label: 'Ship date', maxLength: 20 }),
        carrier: StringColumn({ label: 'Carrier', maxLength: 60 }),
        tracking_number: StringColumn({ label: 'Tracking number', maxLength: 100 }),
    },
})

/** Manufacturer support milestones per PID (vendors without an API). */
export const x_daas_ham_eox_import = Table({
    name: 'x_daas_ham_eox_import',
    label: 'Lifecycle (EoX) import',
    extends: 'sys_import_set_row',
    schema: {
        manufacturer: StringColumn({ label: 'Manufacturer', maxLength: 100 }),
        pid: StringColumn({ label: 'PID', maxLength: 100 }),
        end_of_sale: StringColumn({ label: 'End of sale (YYYY-MM-DD)', maxLength: 20 }),
        end_of_support: StringColumn({ label: 'End of support (YYYY-MM-DD)', maxLength: 20 }),
        end_of_extended_support: StringColumn({ label: 'End of extended support (YYYY-MM-DD)', maxLength: 20 }),
        end_of_life: StringColumn({ label: 'End of life (YYYY-MM-DD)', maxLength: 20 }),
        source_reference: StringColumn({ label: 'Source reference (bulletin URL or id)', maxLength: 255 }),
    },
})
