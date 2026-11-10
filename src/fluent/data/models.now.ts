import '@servicenow/sdk/global'
import {
    BooleanColumn,
    ChoiceColumn,
    DocumentIdColumn,
    IntegerColumn,
    ReferenceColumn,
    StringColumn,
    TableNameColumn,
    Table,
} from '@servicenow/sdk/core'
import { MATCH_TYPE_CHOICES, NORM_EXCEPTION_STATUS_CHOICES } from '../../server/domain/vocabulary'
import { NAAS_MODEL_CONDITION } from '../../server/domain/fleet'
import { DEFAULT_RULE_ORDER } from '../../server/domain/normalization'

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
            choices: NORM_EXCEPTION_STATUS_CHOICES,
            default: 'open',
            dropdown: 'dropdown_without_none',
        }),
        resolved_model: ReferenceColumn({ label: 'Resolved model', referenceTable: 'cmdb_model', referenceQual: NAAS_MODEL_CONDITION }),
    },
    index: [{ name: 'x_daas_ham_ne_raw', unique: false, element: ['raw_manufacturer', 'raw_model'] }],
})
