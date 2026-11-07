import '@servicenow/sdk/global'
import {
    BooleanColumn,
    ChoiceColumn,
    DateColumn,
    DateTimeColumn,
    IntegerColumn,
    ListColumn,
    ReferenceColumn,
    StringColumn,
    Table,
} from '@servicenow/sdk/core'

/*
 * Columns this app adds to platform tables (ADR 0001). Every column carries the x_daas_ham_ prefix.
 */

export const alm_hardware = Table({
    augments: 'alm_hardware',
    schema: {
        x_daas_ham_legal_owner: ChoiceColumn({
            label: 'Legal owner',
            choices: {
                provider: { label: 'Provider', sequence: 0 },
                customer: { label: 'Customer', sequence: 1 },
                lessor: { label: 'Lessor', sequence: 2 },
            },
            default: 'provider',
            dropdown: 'dropdown_without_none',
        }),
        x_daas_ham_lessor: ReferenceColumn({ label: 'Lessor', referenceTable: 'core_company' }),
        x_daas_ham_lease: ReferenceColumn({ label: 'Lease schedule', referenceTable: 'x_daas_ham_lease_schedule' }),
        x_daas_ham_agreement: ReferenceColumn({ label: 'Agreement', referenceTable: 'x_daas_ham_agreement' }),
        x_daas_ham_subscription_line: ReferenceColumn({
            label: 'Subscription line',
            referenceTable: 'x_daas_ham_subscription_line',
        }),
        x_daas_ham_site: ReferenceColumn({ label: 'Site', referenceTable: 'cmn_location' }),
        x_daas_ham_order_line: ReferenceColumn({ label: 'Order line', referenceTable: 'x_daas_ham_order_line' }),
        x_daas_ham_customer_tag: StringColumn({ label: 'Customer tag', maxLength: 80 }),
        x_daas_ham_staging_source: ChoiceColumn({
            label: 'Staging source',
            choices: {
                in_house: { label: 'In-house', sequence: 0 },
                distributor: { label: 'Distributor pre-staged', sequence: 1 },
            },
        }),
        x_daas_ham_install_completed: DateTimeColumn({ label: 'Install completed' }),
        x_daas_ham_in_service_date: DateTimeColumn({ label: 'In-service date', readOnly: true }),
        x_daas_ham_last_seen: DateTimeColumn({ label: 'Last seen', readOnly: true }),
        x_daas_ham_seen_source: ChoiceColumn({
            label: 'Seen source',
            readOnly: true,
            choices: {
                discovery: { label: 'Discovery', sequence: 0 },
                connector: { label: 'Service Graph Connector', sequence: 1 },
                nms: { label: 'Provider NMS', sequence: 2 },
                manual: { label: 'Manual confirmation', sequence: 3 },
            },
        }),
        x_daas_ham_rack: ReferenceColumn({ label: 'Rack', referenceTable: 'cmdb_ci_rack' }),
        x_daas_ham_ru_start: IntegerColumn({ label: 'Lowest rack unit', min: 1, max: 60 }),
        x_daas_ham_rack_face: ChoiceColumn({
            label: 'Rack face',
            choices: { front: { label: 'Front', sequence: 0 }, rear: { label: 'Rear', sequence: 1 } },
        }),
        x_daas_ham_lifecycle_phase: ChoiceColumn({
            label: 'Lifecycle phase',
            readOnly: true,
            choices: {
                available: { label: 'Available', sequence: 0 },
                end_of_sale: { label: 'End of sale', sequence: 1 },
                end_of_support: { label: 'End of support', sequence: 2 },
                end_of_extended_support: { label: 'End of extended support', sequence: 3 },
                end_of_life: { label: 'End of life', sequence: 4 },
            },
        }),
        x_daas_ham_refresh_due: DateColumn({ label: 'Refresh due', readOnly: true }),
        x_daas_ham_coverage_end: DateColumn({ label: 'OEM coverage end', readOnly: true }),
        x_daas_ham_coverage_level: StringColumn({ label: 'OEM service level', maxLength: 160, readOnly: true }),
        x_daas_ham_coverage_checked: DateTimeColumn({ label: 'OEM coverage checked', readOnly: true }),
        x_daas_ham_wiped_on: DateColumn({ label: 'Wiped on' }),
        x_daas_ham_wipe_certificate: StringColumn({ label: 'Wipe certificate', maxLength: 100 }),
    },
    index: [
        { name: 'x_daas_ham_hw_agreement', unique: false, element: 'x_daas_ham_agreement' },
        { name: 'x_daas_ham_hw_sub_line', unique: false, element: 'x_daas_ham_subscription_line' },
        { name: 'x_daas_ham_hw_site', unique: false, element: 'x_daas_ham_site' },
        { name: 'x_daas_ham_hw_order_line', unique: false, element: 'x_daas_ham_order_line' },
        { name: 'x_daas_ham_hw_customer_tag', unique: false, element: 'x_daas_ham_customer_tag' },
        { name: 'x_daas_ham_hw_last_seen', unique: false, element: 'x_daas_ham_last_seen' },
        { name: 'x_daas_ham_hw_refresh_due', unique: false, element: 'x_daas_ham_refresh_due' },
        { name: 'x_daas_ham_hw_rack', unique: false, element: 'x_daas_ham_rack' },
        { name: 'x_daas_ham_hw_cov_checked', unique: false, element: 'x_daas_ham_coverage_checked' },
        { name: 'x_daas_ham_hw_lease', unique: false, element: 'x_daas_ham_lease' },
    ],
})

export const cmdb_model = Table({
    augments: 'cmdb_model',
    schema: {
        x_daas_ham_device_class: ChoiceColumn({
            label: 'Device class',
            choices: {
                switch: { label: 'Switch', sequence: 0 },
                ap: { label: 'Wireless access point', sequence: 1 },
                router: { label: 'Router', sequence: 2 },
                firewall: { label: 'Firewall', sequence: 3 },
                module: { label: 'Module', sequence: 4 },
                psu: { label: 'Power supply', sequence: 5 },
                optic: { label: 'Optic / cable', sequence: 6 },
                other: { label: 'Other', sequence: 7 },
            },
        }),
        x_daas_ham_oem_pid: StringColumn({ label: 'OEM PID', maxLength: 100 }),
        x_daas_ham_track_as_asset: BooleanColumn({ label: 'Track as asset', default: true }),
        x_daas_ham_typical_power_w: IntegerColumn({ label: 'Typical power (W)', min: 0 }),
        x_daas_ham_oem_source: ChoiceColumn({
            label: 'OEM data source',
            choices: {
                cisco: { label: 'Cisco Support APIs', sequence: 0 },
                meraki: { label: 'Meraki Dashboard API', sequence: 1 },
                aruba: { label: 'HPE Aruba (CSV)', sequence: 2 },
                mist: { label: 'HPE Mist API', sequence: 3 },
                fortinet: { label: 'Fortinet Asset Management API', sequence: 4 },
                checkpoint: { label: 'Check Point (CSV)', sequence: 5 },
            },
        }),
        x_daas_ham_normalized_to: ReferenceColumn({
            label: 'Normalized to',
            referenceTable: 'cmdb_model',
            readOnly: true,
        }),
    },
    index: [{ name: 'x_daas_ham_model_pid', unique: false, element: 'x_daas_ham_oem_pid' }],
})

export const alm_stockroom = Table({
    augments: 'alm_stockroom',
    schema: {
        x_daas_ham_stockroom_type: ChoiceColumn({
            label: 'Stockroom type',
            choices: {
                central_depot: { label: 'Central depot', sequence: 0 },
                staging_centre: { label: 'Staging centre', sequence: 1 },
                customer_site: { label: 'Customer site', sequence: 2 },
            },
            default: 'central_depot',
        }),
        x_daas_ham_customer: ReferenceColumn({ label: 'Customer', referenceTable: 'customer_account' }),
    },
    index: [{ name: 'x_daas_ham_sr_customer', unique: false, element: 'x_daas_ham_customer' }],
})

export const cmn_location = Table({
    augments: 'cmn_location',
    schema: {
        x_daas_ham_is_site: BooleanColumn({ label: 'Customer site', default: false }),
        x_daas_ham_site_tier: ChoiceColumn({
            label: 'Site tier',
            choices: {
                standard: { label: 'Standard', sequence: 0 },
                critical: { label: 'Critical', sequence: 1 },
            },
            default: 'standard',
        }),
        x_daas_ham_maintenance_schedule: ReferenceColumn({
            label: 'Maintenance window',
            referenceTable: 'cmn_schedule',
        }),
        x_daas_ham_site_contacts: ListColumn({ label: 'Site contacts', referenceTable: 'customer_contact' }),
    },
})

export const wm_order = Table({
    augments: 'wm_order',
    schema: {
        x_daas_ham_order: ReferenceColumn({ label: 'NaaS order', referenceTable: 'x_daas_ham_order' }),
        x_daas_ham_return_order: ReferenceColumn({ label: 'NaaS return order', referenceTable: 'x_daas_ham_return_order' }),
        x_daas_ham_audit: ReferenceColumn({ label: 'NaaS audit', referenceTable: 'x_daas_ham_audit' }),
        x_daas_ham_purpose: ChoiceColumn({
            label: 'NaaS purpose',
            choices: {
                install: { label: 'Install', sequence: 0 },
                swap: { label: 'Swap', sequence: 1 },
                de_install: { label: 'De-install', sequence: 2 },
                site_audit: { label: 'Site audit', sequence: 3 },
            },
        }),
    },
    index: [{ name: 'x_daas_ham_wm_order', unique: false, element: 'x_daas_ham_order' }],
})

export const sn_customerservice_case = Table({
    augments: 'sn_customerservice_case',
    schema: {
        x_daas_ham_failed_asset: ReferenceColumn({ label: 'Failed asset', referenceTable: 'alm_hardware' }),
        x_daas_ham_replacement_order: ReferenceColumn({
            label: 'Replacement order',
            referenceTable: 'x_daas_ham_order',
            readOnly: true,
        }),
        x_daas_ham_replacement_tier: ChoiceColumn({
            label: 'Replacement service level',
            readOnly: true,
            choices: {
                nbd: { label: 'Next business day', sequence: 0 },
                same_day: { label: 'Same day (8x5x4)', sequence: 1 },
                four_hour: { label: '24x7x4', sequence: 2 },
            },
        }),
        x_daas_ham_proactive: BooleanColumn({ label: 'Raised by NOC', default: false }),
    },
    index: [{ name: 'x_daas_ham_case_failed_asset', unique: false, element: 'x_daas_ham_failed_asset' }],
})

export const change_request = Table({
    augments: 'change_request',
    schema: {
        x_daas_ham_order: ReferenceColumn({ label: 'NaaS order', referenceTable: 'x_daas_ham_order' }),
        x_daas_ham_return_order: ReferenceColumn({ label: 'NaaS return order', referenceTable: 'x_daas_ham_return_order' }),
        x_daas_ham_audit: ReferenceColumn({ label: 'NaaS audit', referenceTable: 'x_daas_ham_audit' }),
    },
    index: [{ name: 'x_daas_ham_chg_order', unique: false, element: 'x_daas_ham_order' }],
})
