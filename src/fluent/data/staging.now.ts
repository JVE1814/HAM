import '@servicenow/sdk/global'
import {
    BooleanColumn,
    ChoiceColumn,
    DateTimeColumn,
    IntegerColumn,
    ReferenceColumn,
    StringColumn,
    Table,
} from '@servicenow/sdk/core'
import {
    AUTOMATION_STATUS_CHOICES,
    CLAIM_ACTION_CHOICES,
    CLOUD_ACCOUNT_VENDOR_CHOICES,
    DEVICE_CLASS_CHOICES,
    STAGING_RESULT_CHOICES,
    STAGING_SOURCE_CHOICES,
} from '../../server/domain/vocabulary'

/** Preparing one Asset before shipment. */
export const x_daas_ham_staging_task = Table({
    name: 'x_daas_ham_staging_task',
    label: 'Staging task',
    extends: 'task',
    schema: {
        // Fleet assets only (ADR 0016): domain/fleet `fleetCondition()`.
        asset: ReferenceColumn({ label: 'Asset', referenceTable: 'alm_hardware', mandatory: true, referenceQual: 'x_daas_ham_fleet=true' }),
        order_line: ReferenceColumn({ label: 'Order line', referenceTable: 'x_daas_ham_order_line' }),
        staging_source: ChoiceColumn({
            label: 'Staging source',
            choices: STAGING_SOURCE_CHOICES,
            mandatory: true,
            default: 'in_house',
            dropdown: 'dropdown_without_none',
        }),
        template: ReferenceColumn({ label: 'Checklist template', referenceTable: 'x_daas_ham_staging_template' }),
        firmware_version: StringColumn({ label: 'Firmware version', maxLength: 60 }),
        result: ChoiceColumn({
            label: 'Result',
            choices: STAGING_RESULT_CHOICES,
        }),
    },
    autoNumber: { prefix: 'NSTG', number: 1000, numberOfDigits: 7 },
    index: [
        { name: 'x_daas_ham_stg_asset', unique: false, element: 'asset' },
        { name: 'x_daas_ham_stg_line', unique: false, element: 'order_line' },
    ],
})

/** One checklist step of a Staging task. */
export const x_daas_ham_staging_step = Table({
    name: 'x_daas_ham_staging_step',
    label: 'Staging step',
    display: 'label',
    schema: {
        staging_task: ReferenceColumn({
            label: 'Staging task',
            referenceTable: 'x_daas_ham_staging_task',
            mandatory: true,
            cascadeRule: 'delete',
        }),
        label: StringColumn({ label: 'Step', maxLength: 160, mandatory: true }),
        order: IntegerColumn({ label: 'Order', default: 100 }),
        mandatory: BooleanColumn({ label: 'Mandatory', default: true }),
        done: BooleanColumn({ label: 'Done', default: false }),
        done_by: ReferenceColumn({ label: 'Done by', referenceTable: 'sys_user', readOnly: true }),
        done_at: DateTimeColumn({ label: 'Done at', readOnly: true }),
        automation: ChoiceColumn({ label: 'Done by the OEM cloud', choices: CLAIM_ACTION_CHOICES, readOnly: true }),
        automation_status: ChoiceColumn({
            label: 'Automation status',
            choices: AUTOMATION_STATUS_CHOICES,
            readOnly: true,
        }),
        automation_message: StringColumn({ label: 'Automation result', maxLength: 255, readOnly: true }),
        attempts: IntegerColumn({ label: 'Attempts', default: 0, readOnly: true }),
    },
    index: [
        { name: 'x_daas_ham_ss_task', unique: false, element: 'staging_task' },
        { name: 'x_daas_ham_ss_automation', unique: false, element: 'automation_status' },
    ],
})

/** The checklist used to stage a kind of Asset, optionally specific to a Customer. */
export const x_daas_ham_staging_template = Table({
    name: 'x_daas_ham_staging_template',
    label: 'Staging checklist template',
    display: 'name',
    schema: {
        name: StringColumn({ label: 'Name', maxLength: 100, mandatory: true }),
        customer: ReferenceColumn({ label: 'Customer (blank = all)', referenceTable: 'customer_account' }),
        manufacturer: ReferenceColumn({ label: 'Manufacturer (blank = all)', referenceTable: 'core_company' }),
        device_class: ChoiceColumn({
            label: 'Device class (blank = all)',
            choices: {
                switch: DEVICE_CLASS_CHOICES.switch,
                ap: DEVICE_CLASS_CHOICES.ap,
                router: DEVICE_CLASS_CHOICES.router,
                firewall: DEVICE_CLASS_CHOICES.firewall,
            },
        }),
        staging_source: ChoiceColumn({
            label: 'Staging source',
            choices: STAGING_SOURCE_CHOICES,
            mandatory: true,
            default: 'in_house',
            dropdown: 'dropdown_without_none',
        }),
        active: BooleanColumn({ label: 'Active', default: true }),
    },
})

export const x_daas_ham_staging_tmpl_item = Table({
    name: 'x_daas_ham_staging_tmpl_item',
    label: 'Staging template step',
    display: 'label',
    schema: {
        template: ReferenceColumn({
            label: 'Template',
            referenceTable: 'x_daas_ham_staging_template',
            mandatory: true,
            cascadeRule: 'delete',
        }),
        label: StringColumn({ label: 'Step', maxLength: 160, mandatory: true }),
        order: IntegerColumn({ label: 'Order', default: 100 }),
        mandatory: BooleanColumn({ label: 'Mandatory', default: true }),
        automation: ChoiceColumn({ label: 'Done by the OEM cloud', choices: CLAIM_ACTION_CHOICES }),
    },
    index: [{ name: 'x_daas_ham_sti_tmpl', unique: false, element: 'template' }],
})

/** A Customer's account in a manufacturer cloud that claimed devices go to (P3.27). */
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
