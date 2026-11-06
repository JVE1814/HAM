import '@servicenow/sdk/global'
import {
    BooleanColumn,
    ChoiceColumn,
    DateColumn,
    DateTimeColumn,
    DocumentIdColumn,
    IntegerColumn,
    ReferenceColumn,
    StringColumn,
    TableNameColumn,
    Table,
} from '@servicenow/sdk/core'

/** A raw manufacturer string seen in discovery, connectors or ASNs, mapped to the canonical manufacturer. */
export const x_daas_ham_manufacturer_alias = Table({
    name: 'x_daas_ham_manufacturer_alias',
    label: 'Manufacturer alias',
    display: 'alias',
    schema: {
        alias: StringColumn({ label: 'Alias', maxLength: 100, mandatory: true }),
        manufacturer: ReferenceColumn({ label: 'Manufacturer', referenceTable: 'core_company', mandatory: true }),
    },
    index: [{ name: 'x_daas_ham_ma_alias', unique: true, element: 'alias' }],
})

/** An ordered rule mapping a raw model string to a canonical Model. */
export const x_daas_ham_model_match_rule = Table({
    name: 'x_daas_ham_model_match_rule',
    label: 'Model match rule',
    schema: {
        order: IntegerColumn({ label: 'Order', default: 100, mandatory: true }),
        manufacturer: ReferenceColumn({ label: 'Manufacturer', referenceTable: 'core_company', mandatory: true }),
        match_type: ChoiceColumn({
            label: 'Match type',
            choices: {
                exact: { label: 'Exact (case-insensitive)', sequence: 0 },
                prefix: { label: 'Starts with', sequence: 1 },
                regex: { label: 'Regular expression', sequence: 2 },
            },
            mandatory: true,
            default: 'exact',
            dropdown: 'dropdown_without_none',
        }),
        pattern: StringColumn({ label: 'Pattern', maxLength: 255, mandatory: true }),
        model: ReferenceColumn({ label: 'Model', referenceTable: 'cmdb_model', mandatory: true }),
        active: BooleanColumn({ label: 'Active', default: true }),
    },
    index: [{ name: 'x_daas_ham_mmr_mfr', unique: false, element: 'manufacturer' }],
})

/** A Model's manufacturer support milestones (one record per Model). */
export const x_daas_ham_model_lifecycle = Table({
    name: 'x_daas_ham_model_lifecycle',
    label: 'Model lifecycle',
    schema: {
        model: ReferenceColumn({ label: 'Model', referenceTable: 'cmdb_model', mandatory: true }),
        end_of_sale: DateColumn({ label: 'End of sale' }),
        end_of_support: DateColumn({ label: 'End of support' }),
        end_of_extended_support: DateColumn({ label: 'End of extended support' }),
        end_of_life: DateColumn({ label: 'End of life' }),
        source: ChoiceColumn({
            label: 'Source',
            choices: {
                manual: { label: 'Manual', sequence: 0 },
                csv: { label: 'CSV import', sequence: 1 },
                cisco: { label: 'Cisco EoX API', sequence: 2 },
                meraki: { label: 'Meraki Dashboard API', sequence: 3 },
                fortinet: { label: 'Fortinet Asset Management API', sequence: 4 },
                mist: { label: 'HPE Mist API', sequence: 5 },
            },
            default: 'manual',
            dropdown: 'dropdown_without_none',
        }),
        source_reference: StringColumn({ label: 'Source reference', maxLength: 255 }),
        last_refreshed: DateTimeColumn({ label: 'Last refreshed', readOnly: true }),
    },
    index: [{ name: 'x_daas_ham_ml_model', unique: true, element: 'model' }],
})

/** A raw manufacturer/model pair no Model match rule could map. */
export const x_daas_ham_norm_exception = Table({
    name: 'x_daas_ham_norm_exception',
    label: 'Normalization exception',
    schema: {
        raw_manufacturer: StringColumn({ label: 'Raw manufacturer', maxLength: 100 }),
        raw_model: StringColumn({ label: 'Raw model', maxLength: 255, mandatory: true }),
        reason: StringColumn({ label: 'Reason', maxLength: 255 }),
        source_table: TableNameColumn({ label: 'Source table' }),
        source_record: DocumentIdColumn({ label: 'Source record', dependent: 'source_table' }),
        occurrences: IntegerColumn({ label: 'Occurrences', default: 1, readOnly: true }),
        status: ChoiceColumn({
            label: 'Status',
            choices: { open: { label: 'Open', sequence: 0 }, resolved: { label: 'Resolved', sequence: 1 } },
            default: 'open',
            dropdown: 'dropdown_without_none',
        }),
        resolved_model: ReferenceColumn({ label: 'Resolved model', referenceTable: 'cmdb_model' }),
    },
    index: [{ name: 'x_daas_ham_ne_raw', unique: false, element: ['raw_manufacturer', 'raw_model'] }],
})
