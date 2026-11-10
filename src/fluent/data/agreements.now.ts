import '@servicenow/sdk/global'
import {
    BooleanColumn,
    ChoiceColumn,
    DateColumn,
    DecimalColumn,
    IntegerColumn,
    MultiLineTextColumn,
    OverrideColumn,
    ReferenceColumn,
    StringColumn,
    Table,
} from '@servicenow/sdk/core'
import {
    CATALOG_ENTRY_TYPE_CHOICES,
    DEVICE_CLASS_CHOICES,
    REFRESH_BASIS_CHOICES,
    REPLACEMENT_TIER_CHOICES,
    SUBSCRIPTION_LINE_STATUS_CHOICES,
    SUBSCRIPTION_LINE_TYPE_CHOICES,
} from '../../server/domain/vocabulary'
import { NAAS_MODEL_CONDITION } from '../../server/domain/fleet'

/** The commercial Agreement between the Provider and a Customer. */
export const x_daas_ham_agreement = Table({
    name: 'x_daas_ham_agreement',
    label: 'Agreement',
    extends: 'ast_contract',
    schema: {
        // Inherited from ast_contract, where it references core_company: required here and limited to Customer
        // accounts (customer_account extends core_company).
        customer: OverrideColumn({ mandatory: true, referenceQualifier: 'sys_class_name=customer_account' }),
        account_manager: ReferenceColumn({ label: 'Account manager', referenceTable: 'sys_user' }),
        // The one currency the Agreement bills in (ISO 4217, e.g. EUR): its Billing lines and Cost facts are kept in it,
        // and no amounts of two currencies are ever added. Mandatory, with no default (domain/billing `chooseCurrency`).
        currency: StringColumn({ label: 'Currency', maxLength: 3, mandatory: true }),
        refresh_cycle_months: IntegerColumn({ label: 'Refresh cycle (months)', default: 60, min: 0 }),
        refresh_basis: ChoiceColumn({
            label: 'Refresh basis',
            choices: REFRESH_BASIS_CHOICES,
            default: 'earliest',
            dropdown: 'dropdown_without_none',
        }),
        replacement_tier: ChoiceColumn({
            label: 'Replacement service level',
            choices: REPLACEMENT_TIER_CHOICES,
            default: 'nbd',
            dropdown: 'dropdown_without_none',
        }),
        spare_pool_ratio: DecimalColumn({ label: 'Spare-pool ratio', default: '0.05' }),
        overdue_return_days: IntegerColumn({ label: 'Return due within (days)', default: 30, min: 1 }),
        lost_asset_fee: DecimalColumn({ label: 'Lost asset fee' }),
        late_return_fee: DecimalColumn({ label: 'Late return fee' }),
        damage_fee: DecimalColumn({ label: 'Damage fee' }),
        attestation_interval_months: IntegerColumn({ label: 'Attestation every (months)', default: 12, min: 0 }),
        end_return_raised: BooleanColumn({ label: 'End-of-agreement return raised', default: false, readOnly: true }),
        renewal_lead_days: IntegerColumn({ label: 'Warn about renewal this many days ahead', default: 90, min: 0 }),
        renewal_term_months: IntegerColumn({ label: 'Renewal term (months)', default: 12, min: 1 }),
        renewal_notified: BooleanColumn({ label: 'Renewal warning sent', default: false, readOnly: true }),
    },
    autoNumber: { prefix: 'NAG', number: 1000, numberOfDigits: 7 },
    index: [{ name: 'x_daas_ham_agr_customer', unique: false, element: 'customer' }],
})

/** How many Assets of a Device class (or one Model) an Agreement allows. */
export const x_daas_ham_agreement_quantity = Table({
    name: 'x_daas_ham_agreement_quantity',
    label: 'Contracted quantity',
    schema: {
        agreement: ReferenceColumn({
            label: 'Agreement',
            referenceTable: 'x_daas_ham_agreement',
            mandatory: true,
            cascadeRule: 'delete',
        }),
        device_class: ChoiceColumn({ label: 'Device class', choices: DEVICE_CLASS_CHOICES, mandatory: true }),
        model: ReferenceColumn({ label: 'Model (optional)', referenceTable: 'cmdb_model', referenceQual: NAAS_MODEL_CONDITION }),
        contracted_quantity: IntegerColumn({ label: 'Contracted quantity', mandatory: true, min: 0 }),
    },
    index: [{ name: 'x_daas_ham_aq_agreement', unique: false, element: 'agreement' }],
})

/** A billable service line of an Agreement that delivering Assets attach to. */
export const x_daas_ham_subscription_line = Table({
    name: 'x_daas_ham_subscription_line',
    label: 'Subscription line',
    display: 'description',
    schema: {
        agreement: ReferenceColumn({ label: 'Agreement', referenceTable: 'x_daas_ham_agreement', mandatory: true }),
        customer: ReferenceColumn({ label: 'Customer', referenceTable: 'customer_account', mandatory: true }),
        description: StringColumn({ label: 'Description', maxLength: 160, mandatory: true }),
        line_type: ChoiceColumn({
            label: 'Line type',
            choices: SUBSCRIPTION_LINE_TYPE_CHOICES,
            mandatory: true,
            dropdown: 'dropdown_without_none',
        }),
        site: ReferenceColumn({ label: 'Site', referenceTable: 'cmn_location' }),
        device_class: ChoiceColumn({ label: 'Device class', choices: DEVICE_CLASS_CHOICES }),
        monthly_rate: DecimalColumn({ label: 'Monthly rate', mandatory: true }),
        // Not billed: a line bills in its Agreement's currency. Kept (read-only, no default) for the values saved before.
        currency: StringColumn({ label: 'Currency (unused: billed in the Agreement currency)', maxLength: 3, readOnly: true }),
        start_date: DateColumn({ label: 'Start date', readOnly: true }),
        end_date: DateColumn({ label: 'End date' }),
        status: ChoiceColumn({
            label: 'Status',
            choices: SUBSCRIPTION_LINE_STATUS_CHOICES,
            default: 'pending',
            dropdown: 'dropdown_without_none',
        }),
    },
    index: [
        { name: 'x_daas_ham_sl_agreement', unique: false, element: 'agreement' },
        { name: 'x_daas_ham_sl_customer', unique: false, element: 'customer' },
    ],
})

/** A Model or Site template a Customer may order. */
export const x_daas_ham_catalog_entry = Table({
    name: 'x_daas_ham_catalog_entry',
    label: 'Catalog entry',
    schema: {
        customer: ReferenceColumn({ label: 'Customer', referenceTable: 'customer_account', mandatory: true }),
        entry_type: ChoiceColumn({
            label: 'Entry type',
            choices: CATALOG_ENTRY_TYPE_CHOICES,
            mandatory: true,
            default: 'model',
            dropdown: 'dropdown_without_none',
        }),
        model: ReferenceColumn({ label: 'Model', referenceTable: 'cmdb_model', referenceQual: NAAS_MODEL_CONDITION }),
        site_template: ReferenceColumn({ label: 'Site template', referenceTable: 'x_daas_ham_site_template' }),
        monthly_rate: DecimalColumn({ label: 'Monthly rate' }),
        active: BooleanColumn({ label: 'Active', default: true }),
        valid_from: DateColumn({ label: 'Valid from' }),
        valid_to: DateColumn({ label: 'Valid to' }),
    },
    index: [{ name: 'x_daas_ham_ce_customer', unique: false, element: 'customer' }],
})

/** A named bill of materials for a standard kind of Site. */
export const x_daas_ham_site_template = Table({
    name: 'x_daas_ham_site_template',
    label: 'Site template',
    display: 'name',
    schema: {
        name: StringColumn({ label: 'Name', maxLength: 100, mandatory: true }),
        customer: ReferenceColumn({ label: 'Customer (blank = all)', referenceTable: 'customer_account' }),
        description: MultiLineTextColumn({ label: 'Description', maxLength: 2000 }),
        active: BooleanColumn({ label: 'Active', default: true }),
    },
})

export const x_daas_ham_site_template_item = Table({
    name: 'x_daas_ham_site_template_item',
    label: 'Site template item',
    schema: {
        site_template: ReferenceColumn({
            label: 'Site template',
            referenceTable: 'x_daas_ham_site_template',
            mandatory: true,
            cascadeRule: 'delete',
        }),
        model: ReferenceColumn({ label: 'Model', referenceTable: 'cmdb_model', mandatory: true, referenceQual: NAAS_MODEL_CONDITION }),
        quantity: IntegerColumn({ label: 'Quantity', mandatory: true, default: 1, min: 1 }),
        optional: BooleanColumn({ label: 'Optional', default: false }),
    },
    index: [{ name: 'x_daas_ham_sti_template', unique: false, element: 'site_template' }],
})
