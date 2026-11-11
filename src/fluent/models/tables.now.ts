import '@servicenow/sdk/global'
import {
    BooleanColumn,
    ChoiceColumn,
    DocumentIdColumn,
    IntegerColumn,
    ReferenceColumn,
    StringColumn,
    Table,
    TableNameColumn,
} from '@servicenow/sdk/core'
import { MATCH_TYPE_CHOICES, NORM_EXCEPTION_STATUS_CHOICES } from '../../server/domain/vocabulary'
import { NAAS_MODEL_CONDITION } from '../../server/domain/fleet'
import { DEFAULT_RULE_ORDER } from '../../server/domain/normalization'

/*
 * An import-set staging table. Load a CSV into it with System Import Sets > Load Data; rows are processed by the
 * after-insert rule in logic.now.ts (no transform map), which sets the row's import state and comment.
 */

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

export const x_daas_ham_model_match_rule = Table({
    name: 'x_daas_ham_model_match_rule',
    label: 'Model match rule',
    schema: {
        order: IntegerColumn({ label: 'Order', default: DEFAULT_RULE_ORDER, mandatory: true }),
        manufacturer: ReferenceColumn({ label: 'Manufacturer', referenceTable: 'core_company', mandatory: true }),
        match_type: ChoiceColumn({
            label: 'Match type',
            choices: MATCH_TYPE_CHOICES,
            mandatory: true,
            default: 'exact',
            dropdown: 'dropdown_without_none',
        }),
        pattern: StringColumn({ label: 'Pattern', maxLength: 255, mandatory: true }),
        model: ReferenceColumn({ label: 'Model', referenceTable: 'cmdb_model', mandatory: true, referenceQual: NAAS_MODEL_CONDITION }),
        active: BooleanColumn({ label: 'Active', default: true }),
    },
    index: [{ name: 'x_daas_ham_mmr_mfr', unique: false, element: 'manufacturer' }],
})

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
            choices: NORM_EXCEPTION_STATUS_CHOICES,
            default: 'open',
            dropdown: 'dropdown_without_none',
        }),
        resolved_model: ReferenceColumn({ label: 'Resolved model', referenceTable: 'cmdb_model', referenceQual: NAAS_MODEL_CONDITION }),
    },
    index: [{ name: 'x_daas_ham_ne_raw', unique: false, element: ['raw_manufacturer', 'raw_model'] }],
})
