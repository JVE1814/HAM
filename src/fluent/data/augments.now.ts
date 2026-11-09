import '@servicenow/sdk/global'
import {
    BooleanColumn,
    ChoiceColumn,
    DateColumn,
    DateTimeColumn,
    DecimalColumn,
    IntegerColumn,
    ListColumn,
    ReferenceColumn,
    StringColumn,
    Table,
} from '@servicenow/sdk/core'
import {
    DEVICE_CLASS_CHOICES,
    FIELD_PURPOSE_CHOICES,
    LEGAL_OWNER_CHOICES,
    LIFECYCLE_PHASE_CHOICES,
    OEM_SOURCE_CHOICES,
    RACK_FACE_CHOICES,
    REPLACEMENT_TIER_CHOICES,
    SEEN_SOURCE_CHOICES,
    SITE_TIER_CHOICES,
    STAGING_SOURCE_CHOICES,
    STOCKROOM_TYPE_CHOICES,
} from '../../server/domain/vocabulary'

/*
 * Columns this app adds to platform tables (ADR 0001). Every column carries the x_daas_ham_ prefix.
 */

export const alm_hardware = Table({
    augments: 'alm_hardware',
    schema: {
        // The Provider's IT shares this table: the app acts only on fleet assets (ADR 0016, domain/fleet). Set by the
        // app's intake paths and by "Add to fleet", never by a form; rows from before the column stay unflagged.
        x_daas_ham_fleet: BooleanColumn({
            label: 'Fleet',
            default: false,
            readOnly: true,
            hint: 'Part of the NaaS fleet: equipment the Provider runs as part of the network service, which NaaS asset management sources, stages, tracks and bills. Set when the app takes a unit in, or by Add to fleet.',
        }),
        x_daas_ham_legal_owner: ChoiceColumn({
            label: 'Legal owner',
            choices: LEGAL_OWNER_CHOICES,
            // No default: rows the Provider's IT creates are not stamped as NaaS-owned. The app's intake paths set the
            // owner (platform/assets newAsset, joinFleet), and a blank owner counts as the Provider's (domain/lifecycle).
            dropdown: 'dropdown_with_none',
        }),
        x_daas_ham_lease: ReferenceColumn({ label: 'Lease schedule', referenceTable: 'x_daas_ham_lease_schedule' }),
        x_daas_ham_agreement: ReferenceColumn({ label: 'Agreement', referenceTable: 'x_daas_ham_agreement' }),
        x_daas_ham_subscription_line: ReferenceColumn({
            label: 'Subscription line',
            referenceTable: 'x_daas_ham_subscription_line',
        }),
        x_daas_ham_site: ReferenceColumn({ label: 'Site', referenceTable: 'cmn_location' }),
        x_daas_ham_order_line: ReferenceColumn({ label: 'Order line', referenceTable: 'x_daas_ham_order_line' }),
        x_daas_ham_customer_tag: StringColumn({ label: 'Customer tag', maxLength: 80 }),
        x_daas_ham_mac_address: StringColumn({ label: 'MAC address', maxLength: 20 }),
        x_daas_ham_claim_code: StringColumn({ label: 'OEM claim code', maxLength: 40 }),
        x_daas_ham_staging_source: ChoiceColumn({
            label: 'Staging source',
            choices: STAGING_SOURCE_CHOICES,
        }),
        x_daas_ham_install_completed: DateTimeColumn({ label: 'Install completed' }),
        x_daas_ham_in_service_date: DateTimeColumn({ label: 'In-service date', readOnly: true }),
        x_daas_ham_last_seen: DateTimeColumn({ label: 'Last seen', readOnly: true }),
        x_daas_ham_seen_source: ChoiceColumn({
            label: 'Seen source',
            readOnly: true,
            choices: SEEN_SOURCE_CHOICES,
        }),
        x_daas_ham_rack: ReferenceColumn({ label: 'Rack', referenceTable: 'cmdb_ci_rack' }),
        x_daas_ham_ru_start: IntegerColumn({ label: 'Lowest rack unit', min: 1, max: 60 }),
        x_daas_ham_rack_face: ChoiceColumn({
            label: 'Rack face',
            choices: RACK_FACE_CHOICES,
        }),
        x_daas_ham_lifecycle_phase: ChoiceColumn({
            label: 'Lifecycle phase',
            readOnly: true,
            choices: LIFECYCLE_PHASE_CHOICES,
        }),
        x_daas_ham_refresh_due: DateColumn({ label: 'Refresh due', readOnly: true }),
        x_daas_ham_coverage_end: DateColumn({ label: 'OEM coverage end', readOnly: true }),
        x_daas_ham_coverage_level: StringColumn({ label: 'OEM service level', maxLength: 160, readOnly: true }),
        x_daas_ham_coverage_checked: DateTimeColumn({ label: 'OEM coverage checked', readOnly: true }),
        x_daas_ham_support_cost: DecimalColumn({ label: 'OEM support cost per year', readOnly: true }),
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
        { name: 'x_daas_ham_hw_fleet', unique: false, element: 'x_daas_ham_fleet' },
    ],
})

export const cmdb_model = Table({
    augments: 'cmdb_model',
    schema: {
        x_daas_ham_device_class: ChoiceColumn({
            label: 'Device class',
            choices: DEVICE_CLASS_CHOICES,
        }),
        // A NaaS Model is one with an OEM PID (domain/fleet); the Provider IT's Models have none.
        x_daas_ham_oem_pid: StringColumn({ label: 'OEM PID', maxLength: 100 }),
        x_daas_ham_oem_source: ChoiceColumn({
            label: 'OEM data source',
            choices: OEM_SOURCE_CHOICES,
        }),
        // A raw model is normalized to a NaaS Model (ADR 0016): domain/fleet `naasModelCondition()`.
        x_daas_ham_normalized_to: ReferenceColumn({
            label: 'Normalized to',
            referenceTable: 'cmdb_model',
            readOnly: true,
            referenceQual: 'x_daas_ham_oem_pidISNOTEMPTY',
        }),
    },
    index: [{ name: 'x_daas_ham_model_pid', unique: false, element: 'x_daas_ham_oem_pid' }],
})

export const alm_stockroom = Table({
    augments: 'alm_stockroom',
    schema: {
        x_daas_ham_stockroom_type: ChoiceColumn({
            label: 'Stockroom type',
            choices: STOCKROOM_TYPE_CHOICES,
            // No default: a stockroom with no type is the Provider IT's, not a NaaS stockroom (domain/fleet). Dropping the
            // default clears no value: where an earlier version was installed, the Provider IT's stockrooms keep the
            // 'central_depot' it stamped, and count as NaaS until an administrator clears their type.
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
            choices: SITE_TIER_CHOICES,
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
    // The app record a work order belongs to (an Order, a Return order or an Audit) is the platform's Initiated from
    // (sm_order.initiated_from); its change request names it as its Parent (ADR 0018).
    schema: {
        x_daas_ham_purpose: ChoiceColumn({
            label: 'NaaS purpose',
            choices: FIELD_PURPOSE_CHOICES,
        }),
        x_daas_ham_labour_cost: DecimalColumn({ label: 'NaaS field labour cost (blank = standard visit cost)' }),
    },
})

export const sn_customerservice_case = Table({
    augments: 'sn_customerservice_case',
    schema: {
        // Only fleet assets are replaced (ADR 0016): the query is domain/fleet `fleetCondition()`.
        x_daas_ham_failed_asset: ReferenceColumn({
            label: 'Failed asset',
            referenceTable: 'alm_hardware',
            referenceQual: 'x_daas_ham_fleet=true',
        }),
        x_daas_ham_replacement_order: ReferenceColumn({
            label: 'Replacement order',
            referenceTable: 'x_daas_ham_order',
            readOnly: true,
        }),
        x_daas_ham_replacement_tier: ChoiceColumn({
            label: 'Replacement service level',
            readOnly: true,
            choices: REPLACEMENT_TIER_CHOICES,
        }),
        x_daas_ham_proactive: BooleanColumn({ label: 'Raised by NOC', default: false }),
    },
    index: [{ name: 'x_daas_ham_case_failed_asset', unique: false, element: 'x_daas_ham_failed_asset' }],
})

export const cmdb_ci_rack = Table({
    augments: 'cmdb_ci_rack',
    schema: {
        x_daas_ham_power_capacity_w: IntegerColumn({ label: 'Power capacity (W)', min: 0 }),
    },
})
