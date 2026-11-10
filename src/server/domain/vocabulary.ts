/**
 * The single source of every stored choice value in the app.
 *
 * Each list is one `as const` object: value -> { label, sequence }. Fluent metadata imports the object as a column's
 * `choices:` (labels, sequences); server code imports the type derived from its keys. A list is defined here and
 * nowhere else.
 *
 * Fluent evaluates this file statically, so it holds constants and types only: no imports, no function calls, no
 * spread, no array indexing, and no `satisfies` on a list (the build then refuses the column). A list that offers
 * part of another is built from that list's entries by property access.
 *
 * A list whose values are written into a text (an encoded query, a rule's or UI action's condition) also has its
 * values by name, e.g. `ORDER_STAGE.rejected`: Fluent reads a property of a constant, but not the keys of one. The
 * sets built from those values, and the queries that select them, are in the domain module that owns the concept.
 */

/** Every value of a choice list by its own name: complete, and no key names another value. */
type Named<Value extends string> = { readonly [V in Value]: V }

/* Tasks (task and the tables extending it) */

/**
 * The platform's task states (task.state) the app sets or tests, on its own task tables and on work orders. Each
 * module names the ones its tasks take from here, so a state's number is written once.
 */
export const TASK_STATE = {
    pending: -5,
    open: 1,
    workInProgress: 2,
    closedComplete: 3,
    closedIncomplete: 4,
    closedSkipped: 7,
} as const

/* Assets (alm_hardware) */

/** Platform install_status values (alm_asset.install_status). */
export const INSTALL_STATUS = {
    inUse: '1',
    onOrder: '2',
    inMaintenance: '3',
    inStock: '6',
    retired: '7',
    missing: '8',
    inTransit: '9',
} as const

/**
 * The install_status + substatus pair each Lifecycle stage is stored as (ADR 0002; domain/lifecycle reads it).
 *
 * A stage with a `choice` uses a substatus this app adds to alm_asset.substatus: data/substatus-choices.now.ts ships
 * one sys_choice per `choice`, taking its value, install status, label and sequence from here. The others use
 * out-of-box values: Brazil ships pending_evaluation under In stock and lease_return under Retired.
 */
export const STAGE_FIELDS = {
    on_order: { installStatus: INSTALL_STATUS.onOrder, substatus: '' },
    in_transit: { installStatus: INSTALL_STATUS.inTransit, substatus: '' },
    available: { installStatus: INSTALL_STATUS.inStock, substatus: 'available' },
    reserved: { installStatus: INSTALL_STATUS.inStock, substatus: 'reserved' },
    spare_pool: {
        installStatus: INSTALL_STATUS.inStock,
        substatus: 'reserved_spare_pool',
        choice: { label: 'Reserved - spare pool', sequence: 500 },
    },
    staging: { installStatus: INSTALL_STATUS.inStock, substatus: 'staging', choice: { label: 'Staging', sequence: 510 } },
    staged: { installStatus: INSTALL_STATUS.inStock, substatus: 'staged', choice: { label: 'Staged', sequence: 520 } },
    // Set by Inventory's transfer order logic, never by the app; also stored as In transit / Reserved (domain/lifecycle).
    in_transfer: { installStatus: INSTALL_STATUS.inStock, substatus: 'pending_transfer' },
    shipped: {
        installStatus: INSTALL_STATUS.inTransit,
        substatus: 'shipped_to_site',
        choice: { label: 'Shipped to site', sequence: 530 },
    },
    pending_in_service: {
        installStatus: INSTALL_STATUS.inUse,
        substatus: 'pending_in_service',
        choice: { label: 'Pending in service', sequence: 540 },
    },
    in_service: { installStatus: INSTALL_STATUS.inUse, substatus: '' },
    temporary_deployment: {
        installStatus: INSTALL_STATUS.inUse,
        substatus: 'temporary_deployment',
        choice: { label: 'Temporary deployment', sequence: 550 },
    },
    pending_return: {
        installStatus: INSTALL_STATUS.inUse,
        substatus: 'pending_return',
        choice: { label: 'Pending return', sequence: 560 },
    },
    pending_evaluation: { installStatus: INSTALL_STATUS.inStock, substatus: 'pending_evaluation' },
    pending_oem_rma: {
        installStatus: INSTALL_STATUS.inMaintenance,
        substatus: 'pending_oem_rma',
        choice: { label: 'Pending OEM RMA', sequence: 580 },
    },
    pending_wipe: { installStatus: INSTALL_STATUS.inStock, substatus: 'pending_wipe', choice: { label: 'Pending wipe', sequence: 590 } },
    pending_disposal: { installStatus: INSTALL_STATUS.inStock, substatus: 'pending_disposal' },
    missing: { installStatus: INSTALL_STATUS.missing, substatus: 'lost' },
    disposed: { installStatus: INSTALL_STATUS.retired, substatus: 'disposed' },
    sold: { installStatus: INSTALL_STATUS.retired, substatus: 'sold' },
    returned_to_oem: { installStatus: INSTALL_STATUS.retired, substatus: 'vendor_credit' },
    returned_to_customer: {
        installStatus: INSTALL_STATUS.retired,
        substatus: 'returned_to_customer',
        choice: { label: 'Returned to customer', sequence: 600 },
    },
    returned_to_lessor: { installStatus: INSTALL_STATUS.retired, substatus: 'lease_return' },
} as const

/** alm_hardware.x_daas_ham_legal_owner. The column has no default: a blank owner counts as the Provider's. */
export const LEGAL_OWNER_CHOICES = {
    provider: { label: 'Provider', sequence: 0 },
    customer: { label: 'Customer', sequence: 1 },
    lessor: { label: 'Lessor', sequence: 2 },
} as const
export type LegalOwner = keyof typeof LEGAL_OWNER_CHOICES
export const LEGAL_OWNER = {
    provider: 'provider',
    customer: 'customer',
    lessor: 'lessor',
} as const satisfies Named<LegalOwner>

/** Where a unit is staged: on the Asset, its Staging task and the Staging checklist template. */
export const STAGING_SOURCE_CHOICES = {
    in_house: { label: 'In-house', sequence: 0 },
    distributor: { label: 'Distributor pre-staged (verify)', sequence: 1 },
} as const
export type StagingSource = keyof typeof STAGING_SOURCE_CHOICES

/** alm_hardware.x_daas_ham_seen_source: what last confirmed the Asset is there. */
export const SEEN_SOURCE_CHOICES = {
    discovery: { label: 'Discovery', sequence: 0 },
    connector: { label: 'Service Graph Connector', sequence: 1 },
    nms: { label: 'Provider NMS', sequence: 2 },
    manual: { label: 'Manual confirmation', sequence: 3 },
} as const
export type SeenSource = keyof typeof SEEN_SOURCE_CHOICES

export const RACK_FACE_CHOICES = {
    front: { label: 'Front', sequence: 0 },
    rear: { label: 'Rear', sequence: 1 },
} as const
export type RackFace = keyof typeof RACK_FACE_CHOICES

export const LIFECYCLE_PHASE_CHOICES = {
    available: { label: 'Available', sequence: 0 },
    end_of_sale: { label: 'End of sale', sequence: 1 },
    end_of_support: { label: 'End of support', sequence: 2 },
    end_of_extended_support: { label: 'End of extended support', sequence: 3 },
    end_of_life: { label: 'End of life', sequence: 4 },
} as const
export type LifecyclePhase = keyof typeof LIFECYCLE_PHASE_CHOICES
export const LIFECYCLE_PHASE = {
    available: 'available',
    end_of_sale: 'end_of_sale',
    end_of_support: 'end_of_support',
    end_of_extended_support: 'end_of_extended_support',
    end_of_life: 'end_of_life',
} as const satisfies Named<LifecyclePhase>

/* Monitoring (x_daas_ham_device_event) */

export const DEVICE_EVENT_KIND_CHOICES = {
    seen: { label: 'Seen', sequence: 0 },
    down: { label: 'Down', sequence: 1 },
    up: { label: 'Up', sequence: 2 },
} as const
export type DeviceEventKind = keyof typeof DEVICE_EVENT_KIND_CHOICES

/** The Seen sources a Device event comes from: monitoring only, never a person's confirmation. */
export const DEVICE_EVENT_SOURCE_CHOICES = {
    discovery: SEEN_SOURCE_CHOICES.discovery,
    connector: SEEN_SOURCE_CHOICES.connector,
    nms: SEEN_SOURCE_CHOICES.nms,
} as const
export type DeviceEventSource = keyof typeof DEVICE_EVENT_SOURCE_CHOICES

/* Models (cmdb_model) and their normalization */

/** Device class: on the Model, a Contracted quantity, a Subscription line and (in part) a Staging checklist template. */
export const DEVICE_CLASS_CHOICES = {
    switch: { label: 'Switch', sequence: 0 },
    ap: { label: 'Wireless access point', sequence: 1 },
    router: { label: 'Router', sequence: 2 },
    firewall: { label: 'Firewall', sequence: 3 },
    module: { label: 'Module', sequence: 4 },
    psu: { label: 'Power supply', sequence: 5 },
    optic: { label: 'Optic / cable', sequence: 6 },
    other: { label: 'Other', sequence: 7 },
} as const
export type DeviceClass = keyof typeof DEVICE_CLASS_CHOICES
export const DEVICE_CLASS = {
    switch: 'switch',
    ap: 'ap',
    router: 'router',
    firewall: 'firewall',
    module: 'module',
    psu: 'psu',
    optic: 'optic',
    other: 'other',
} as const satisfies Named<DeviceClass>

export const MATCH_TYPE_CHOICES = {
    exact: { label: 'Exact (case-insensitive)', sequence: 0 },
    prefix: { label: 'Starts with', sequence: 1 },
    regex: { label: 'Regular expression', sequence: 2 },
} as const
export type MatchType = keyof typeof MATCH_TYPE_CHOICES

export const NORM_EXCEPTION_STATUS_CHOICES = {
    open: { label: 'Open', sequence: 0 },
    resolved: { label: 'Resolved', sequence: 1 },
} as const
export type NormExceptionStatus = keyof typeof NORM_EXCEPTION_STATUS_CHOICES
export const NORM_EXCEPTION_STATUS = {
    open: 'open',
    resolved: 'resolved',
} as const satisfies Named<NormExceptionStatus>

/* OEM vendors, coverage and RMAs */

/** The OEM vendors the app integrates with (OEM coverage, OEM RMA). The two lists below label the same values. */
export const OEM_VENDOR_CHOICES = {
    cisco: { label: 'Cisco', sequence: 0 },
    meraki: { label: 'Cisco Meraki', sequence: 1 },
    aruba: { label: 'HPE Aruba', sequence: 2 },
    mist: { label: 'HPE Mist', sequence: 3 },
    fortinet: { label: 'Fortinet', sequence: 4 },
    checkpoint: { label: 'Check Point', sequence: 5 },
} as const
export type OemVendor = keyof typeof OEM_VENDOR_CHOICES

/** cmdb_model.x_daas_ham_oem_source: each vendor labelled by where its Models' data comes from. */
export const OEM_SOURCE_CHOICES = {
    cisco: { label: 'Cisco Support APIs', sequence: 0 },
    meraki: { label: 'Meraki Dashboard API', sequence: 1 },
    aruba: { label: 'HPE Aruba (CSV)', sequence: 2 },
    mist: { label: 'HPE Mist API', sequence: 3 },
    fortinet: { label: 'Fortinet Asset Management API', sequence: 4 },
    checkpoint: { label: 'Check Point (CSV)', sequence: 5 },
} as const

/** x_daas_ham_cloud_account.vendor: the vendors with a cloud to claim into, each labelled by the account id it takes. */
export const CLOUD_ACCOUNT_VENDOR_CHOICES = {
    meraki: { label: 'Cisco Meraki (organization id)', sequence: 0 },
    mist: { label: 'HPE Mist (org id)', sequence: 1 },
    aruba: { label: 'HPE GreenLake (subscription id)', sequence: 2 },
    fortinet: { label: 'FortiZTP (FortiManager OID)', sequence: 3 },
    checkpoint: { label: 'Check Point Zero Touch (User Center account id/template id)', sequence: 4 },
} as const
export type CloudAccountVendor = keyof typeof CLOUD_ACCOUNT_VENDOR_CHOICES

// Fluent cannot read a list written with `satisfies`, so that both lists label OEM vendors is checked here instead.
type Holds<T extends true> = T
type _EveryVendorHasASource = Holds<[OemVendor] extends [keyof typeof OEM_SOURCE_CHOICES] ? true : false>
type _EverySourceIsAVendor = Holds<[keyof typeof OEM_SOURCE_CHOICES] extends [OemVendor] ? true : false>
type _EveryCloudVendorIsAVendor = Holds<[CloudAccountVendor] extends [OemVendor] ? true : false>

export const COVERAGE_SOURCE_CHOICES = {
    api: { label: 'OEM API', sequence: 0 },
    csv: { label: 'CSV import', sequence: 1 },
    manual: { label: 'Manual', sequence: 2 },
} as const
export type CoverageSource = keyof typeof COVERAGE_SOURCE_CHOICES

/** x_daas_ham_oem_rma.state. */
export const RMA_STATE_CHOICES = {
    to_open: { label: 'To open with OEM', sequence: 0 },
    open: { label: 'Open', sequence: 1 },
    replacement_received: { label: 'Replacement received', sequence: 2 },
    defective_returned: { label: 'Defective returned to OEM', sequence: 3 },
    closed: { label: 'Closed', sequence: 4 },
} as const
export type RmaState = keyof typeof RMA_STATE_CHOICES
export const RMA_STATE = {
    to_open: 'to_open',
    open: 'open',
    replacement_received: 'replacement_received',
    defective_returned: 'defective_returned',
    closed: 'closed',
} as const satisfies Named<RmaState>

/* Stockrooms, Sites and on-site work */

/** alm_stockroom.x_daas_ham_stockroom_type. The column has no default: a stockroom with no type is not a NaaS one. */
export const STOCKROOM_TYPE_CHOICES = {
    central_depot: { label: 'Central depot', sequence: 0 },
    staging_centre: { label: 'Staging centre', sequence: 1 },
    customer_site: { label: 'Customer site', sequence: 2 },
} as const
export type StockroomType = keyof typeof STOCKROOM_TYPE_CHOICES
export const STOCKROOM_TYPE = {
    central_depot: 'central_depot',
    staging_centre: 'staging_centre',
    customer_site: 'customer_site',
} as const satisfies Named<StockroomType>

/** wm_order.x_daas_ham_purpose: what an FSM work order the app opened is for. */
export const FIELD_PURPOSE_CHOICES = {
    install: { label: 'Install', sequence: 0 },
    swap: { label: 'Swap', sequence: 1 },
    de_install: { label: 'De-install', sequence: 2 },
    site_audit: { label: 'Site audit', sequence: 3 },
} as const
export type FieldPurpose = keyof typeof FIELD_PURPOSE_CHOICES

/* Agreements, Subscription lines and Catalog entries */

export const REFRESH_BASIS_CHOICES = {
    cycle: { label: 'Refresh cycle only', sequence: 0 },
    end_of_support: { label: 'End of support only', sequence: 1 },
    earliest: { label: 'Whichever comes first', sequence: 2 },
} as const
export type RefreshBasis = keyof typeof REFRESH_BASIS_CHOICES

/** Replacement service level: on the Agreement, and copied to a break-fix case. */
export const REPLACEMENT_TIER_CHOICES = {
    nbd: { label: 'Next business day', sequence: 0 },
    same_day: { label: 'Same day (8x5x4)', sequence: 1 },
    four_hour: { label: '24x7x4', sequence: 2 },
} as const
export type ReplacementTier = keyof typeof REPLACEMENT_TIER_CHOICES
export const REPLACEMENT_TIER = {
    nbd: 'nbd',
    same_day: 'same_day',
    four_hour: 'four_hour',
} as const satisfies Named<ReplacementTier>

export const SUBSCRIPTION_LINE_TYPE_CHOICES = {
    site_package: { label: 'Site package', sequence: 0 },
    device_class: { label: 'Per device class', sequence: 1 },
} as const
export type SubscriptionLineType = keyof typeof SUBSCRIPTION_LINE_TYPE_CHOICES

export const SUBSCRIPTION_LINE_STATUS_CHOICES = {
    pending: { label: 'Pending', sequence: 0 },
    active: { label: 'Active', sequence: 1 },
    ended: { label: 'Ended', sequence: 2 },
} as const
export type SubscriptionLineStatus = keyof typeof SUBSCRIPTION_LINE_STATUS_CHOICES
export const SUBSCRIPTION_LINE_STATUS = {
    pending: 'pending',
    active: 'active',
    ended: 'ended',
} as const satisfies Named<SubscriptionLineStatus>

export const CATALOG_ENTRY_TYPE_CHOICES = {
    model: { label: 'Model', sequence: 0 },
    site_template: { label: 'Site template', sequence: 1 },
} as const
export type CatalogEntryType = keyof typeof CATALOG_ENTRY_TYPE_CHOICES

/* Orders and Order lines */

export const ORDER_TYPE_CHOICES = {
    site_rollout: { label: 'Site rollout', sequence: 0 },
    device_add: { label: 'Device add', sequence: 1 },
    device_replace: { label: 'Device replace', sequence: 2 },
    temporary: { label: 'Temporary deployment', sequence: 3 },
    refresh: { label: 'Refresh', sequence: 4 },
} as const
export type OrderType = keyof typeof ORDER_TYPE_CHOICES
export const ORDER_TYPE = {
    site_rollout: 'site_rollout',
    device_add: 'device_add',
    device_replace: 'device_replace',
    temporary: 'temporary',
    refresh: 'refresh',
} as const satisfies Named<OrderType>

export const INSTALL_MODE_CHOICES = {
    fsm_engineer: { label: 'Provider field engineer', sequence: 0 },
    self_install: { label: 'Customer self-install (ZTP)', sequence: 1 },
    subcontractor: { label: 'Subcontractor', sequence: 2 },
    remote_hands: { label: 'Data-centre remote hands', sequence: 3 },
} as const
export type InstallMode = keyof typeof INSTALL_MODE_CHOICES
export const INSTALL_MODE = {
    fsm_engineer: 'fsm_engineer',
    self_install: 'self_install',
    subcontractor: 'subcontractor',
    remote_hands: 'remote_hands',
} as const satisfies Named<InstallMode>

export const ORDER_STAGE_CHOICES = {
    draft: { label: 'Draft', sequence: 0 },
    awaiting_approval: { label: 'Awaiting approval', sequence: 1 },
    sourcing: { label: 'Sourcing', sequence: 2 },
    preparing: { label: 'Preparing', sequence: 3 },
    delivering: { label: 'Delivering', sequence: 4 },
    installing: { label: 'Installing', sequence: 5 },
    complete: { label: 'Complete', sequence: 6 },
    rejected: { label: 'Rejected', sequence: 7 },
    cancelled: { label: 'Cancelled', sequence: 8 },
} as const
export type OrderStage = keyof typeof ORDER_STAGE_CHOICES
export const ORDER_STAGE = {
    draft: 'draft',
    awaiting_approval: 'awaiting_approval',
    sourcing: 'sourcing',
    preparing: 'preparing',
    delivering: 'delivering',
    installing: 'installing',
    complete: 'complete',
    rejected: 'rejected',
    cancelled: 'cancelled',
} as const satisfies Named<OrderStage>

export const ENTITLEMENT_VERDICT_CHOICES = {
    within_agreement: { label: 'Within agreement', sequence: 0 },
    off_catalog: { label: 'Off catalog', sequence: 1 },
    over_quota: { label: 'Over contracted quantity', sequence: 2 },
} as const
export type EntitlementVerdict = keyof typeof ENTITLEMENT_VERDICT_CHOICES

export const LINE_STAGE_CHOICES = {
    new: { label: 'New', sequence: 0 },
    awaiting_stock: { label: 'Awaiting stock', sequence: 1 },
    sourced: { label: 'Sourced', sequence: 2 },
    staging: { label: 'Staging', sequence: 3 },
    ready_to_ship: { label: 'Ready to ship', sequence: 4 },
    shipped: { label: 'Shipped', sequence: 5 },
    installed: { label: 'Installed', sequence: 6 },
    in_service: { label: 'In service', sequence: 7 },
    cancelled: { label: 'Cancelled', sequence: 8 },
} as const
export type LineStage = keyof typeof LINE_STAGE_CHOICES
export const LINE_STAGE = {
    new: 'new',
    awaiting_stock: 'awaiting_stock',
    sourced: 'sourced',
    staging: 'staging',
    ready_to_ship: 'ready_to_ship',
    shipped: 'shipped',
    installed: 'installed',
    in_service: 'in_service',
    cancelled: 'cancelled',
} as const satisfies Named<LineStage>

/* Staging and OEM claims */

/** Checklist steps the manufacturer's cloud can do (P3.27): a step's `automation` (blank = by hand), an OEM cloud account's `purpose`. */
export const CLAIM_ACTION_CHOICES = {
    oem_claim: { label: 'Claim / register in the OEM cloud', sequence: 0 },
    oem_licence: { label: 'Assign the OEM subscription', sequence: 1 },
    oem_ztp: { label: 'Zero-touch provisioning', sequence: 2 },
} as const
export type ClaimAction = keyof typeof CLAIM_ACTION_CHOICES

export const AUTOMATION_STATUS_CHOICES = {
    pending: { label: 'Pending', sequence: 0 },
    done: { label: 'Done', sequence: 1 },
    failed: { label: 'Failed (do it by hand)', sequence: 2 },
    waiting: { label: 'Waiting for the OEM claim step', sequence: 3 },
} as const
export type AutomationStatus = keyof typeof AUTOMATION_STATUS_CHOICES

export const STAGING_RESULT_CHOICES = {
    passed: { label: 'Passed', sequence: 0 },
    failed: { label: 'Failed', sequence: 1 },
} as const
export type StagingResult = keyof typeof STAGING_RESULT_CHOICES

/* Shipments */

export const SHIPMENT_STATUS_CHOICES = {
    label_created: { label: 'Label created', sequence: 0 },
    in_transit: { label: 'In transit', sequence: 1 },
    out_for_delivery: { label: 'Out for delivery', sequence: 2 },
    delivered: { label: 'Delivered', sequence: 3 },
    exception: { label: 'Exception', sequence: 4 },
    returned: { label: 'Returned to sender', sequence: 5 },
    unknown: { label: 'Unknown', sequence: 6 },
    // Set by Mark label voided, never by tracking: a final status, like delivered and returned.
    voided: { label: 'Voided', sequence: 7 },
} as const
export type ShipmentStatus = keyof typeof SHIPMENT_STATUS_CHOICES
export const SHIPMENT_STATUS = {
    label_created: 'label_created',
    in_transit: 'in_transit',
    out_for_delivery: 'out_for_delivery',
    delivered: 'delivered',
    exception: 'exception',
    returned: 'returned',
    unknown: 'unknown',
    voided: 'voided',
} as const satisfies Named<ShipmentStatus>

export const SHIPMENT_DIRECTION_CHOICES = {
    to_site: { label: 'To a Site', sequence: 0 },
    return: { label: 'Return to the depot', sequence: 1 },
} as const
export type ShipmentDirection = keyof typeof SHIPMENT_DIRECTION_CHOICES
export const SHIPMENT_DIRECTION = {
    to_site: 'to_site',
    return: 'return',
} as const satisfies Named<ShipmentDirection>

/* Return orders and Fee events */

export const RETURN_TRIGGER_CHOICES = {
    site_decommission: { label: 'Site decommission', sequence: 0 },
    device_removal: { label: 'Device removal', sequence: 1 },
    refresh_swap_back: { label: 'Refresh swap-back', sequence: 2 },
    defective_return: { label: 'Defective return (break-fix)', sequence: 3 },
    agreement_end: { label: 'Agreement end', sequence: 4 },
    temporary_end: { label: 'Temporary deployment end', sequence: 5 },
} as const
export type ReturnTrigger = keyof typeof RETURN_TRIGGER_CHOICES
export const RETURN_TRIGGER = {
    site_decommission: 'site_decommission',
    device_removal: 'device_removal',
    refresh_swap_back: 'refresh_swap_back',
    defective_return: 'defective_return',
    agreement_end: 'agreement_end',
    temporary_end: 'temporary_end',
} as const satisfies Named<ReturnTrigger>

export const RETURN_METHOD_CHOICES = {
    fsm_deinstall: { label: 'Field engineer de-installs', sequence: 0 },
    ship_back: { label: 'Site contact ships back', sequence: 1 },
} as const
export type ReturnMethod = keyof typeof RETURN_METHOD_CHOICES
export const RETURN_METHOD = {
    fsm_deinstall: 'fsm_deinstall',
    ship_back: 'ship_back',
} as const satisfies Named<ReturnMethod>

export const RETURN_LINE_STATUS_CHOICES = {
    awaiting: { label: 'Awaiting return', sequence: 0 },
    received: { label: 'Received', sequence: 1 },
    evaluated: { label: 'Evaluated', sequence: 2 },
    missing: { label: 'Declared missing', sequence: 3 },
} as const
export type ReturnLineStatus = keyof typeof RETURN_LINE_STATUS_CHOICES
export const RETURN_LINE_STATUS = {
    awaiting: 'awaiting',
    received: 'received',
    evaluated: 'evaluated',
    missing: 'missing',
} as const satisfies Named<ReturnLineStatus>

export const RETURN_CONDITION_CHOICES = {
    good: { label: 'Good', sequence: 0 },
    damaged: { label: 'Damaged', sequence: 1 },
} as const
export type ReturnCondition = keyof typeof RETURN_CONDITION_CHOICES

export const EVALUATION_OUTCOME_CHOICES = {
    refurbish: { label: 'Refurbish to stock', sequence: 0 },
    oem_rma: { label: 'Return to OEM (RMA)', sequence: 1 },
    scrap: { label: 'Scrap (wipe and dispose)', sequence: 2 },
    return_to_owner: { label: 'Return to owner (customer / lessor)', sequence: 3 },
} as const
export type EvaluationOutcome = keyof typeof EVALUATION_OUTCOME_CHOICES

export const FEE_TYPE_CHOICES = {
    lost: { label: 'Lost asset', sequence: 0 },
    damaged: { label: 'Damaged asset', sequence: 1 },
    late_return: { label: 'Late return', sequence: 2 },
} as const
export type FeeType = keyof typeof FEE_TYPE_CHOICES

export const FEE_STATUS_CHOICES = {
    open: { label: 'Open', sequence: 0 },
    billed: { label: 'Billed', sequence: 1 },
    waived: { label: 'Waived', sequence: 2 },
} as const
export type FeeStatus = keyof typeof FEE_STATUS_CHOICES
/** Open until a closed Billing period bills it, or waived (a missing unit turned up), which is never billed. */
export const FEE_STATUS = {
    open: 'open',
    billed: 'billed',
    waived: 'waived',
} as const satisfies Named<FeeStatus>

/* Disposal orders */

/** Disposal method: on the Disposal order, and on a line that differs from its order. */
export const DISPOSAL_METHOD_CHOICES = {
    broker_resale: { label: 'Broker resale', sequence: 0 },
    oem_takeback: { label: 'OEM takeback / trade-in', sequence: 1 },
    itad_recycle: { label: 'ITAD recycling', sequence: 2 },
    return_to_customer: { label: 'Return to customer', sequence: 3 },
    return_to_lessor: { label: 'Return to lessor', sequence: 4 },
} as const
export type DisposalMethod = keyof typeof DISPOSAL_METHOD_CHOICES

export const DISPOSAL_STAGE_CHOICES = {
    draft: { label: 'Draft', sequence: 0 },
    awaiting_approval: { label: 'Awaiting approval', sequence: 1 },
    approved: { label: 'Approved', sequence: 2 },
    completed: { label: 'Completed', sequence: 3 },
    rejected: { label: 'Rejected', sequence: 4 },
} as const
export type DisposalStage = keyof typeof DISPOSAL_STAGE_CHOICES
export const DISPOSAL_STAGE = {
    draft: 'draft',
    awaiting_approval: 'awaiting_approval',
    approved: 'approved',
    completed: 'completed',
    rejected: 'rejected',
} as const satisfies Named<DisposalStage>

export const DISPOSAL_LINE_STATUS_CHOICES = {
    pending: { label: 'Pending', sequence: 0 },
    done: { label: 'Done', sequence: 1 },
    blocked: { label: 'Blocked', sequence: 2 },
} as const
export type DisposalLineStatus = keyof typeof DISPOSAL_LINE_STATUS_CHOICES

/* Lease schedules */

/** A Lease schedule's end action. An End-of-lease decision offers all but `undecided`. */
export const LEASE_END_ACTION_CHOICES = {
    undecided: { label: 'Undecided', sequence: 0 },
    buyout: { label: 'Buy out', sequence: 1 },
    extend: { label: 'Extend', sequence: 2 },
    return: { label: 'Return to lessor', sequence: 3 },
} as const
export type LeaseEndAction = keyof typeof LEASE_END_ACTION_CHOICES
export const LEASE_END_ACTION = {
    undecided: 'undecided',
    buyout: 'buyout',
    extend: 'extend',
    return: 'return',
} as const satisfies Named<LeaseEndAction>

/* Audits, Attestations and Reconciliation exceptions */

export const AUDIT_TYPE_CHOICES = {
    stockroom: { label: 'Stockroom blind count', sequence: 0 },
    site: { label: 'Site audit', sequence: 1 },
} as const
export type AuditType = keyof typeof AUDIT_TYPE_CHOICES

export const AUDIT_LINE_RESULT_CHOICES = {
    expected: { label: 'Expected, not yet scanned', sequence: 0 },
    found: { label: 'Found', sequence: 1 },
    missing: { label: 'Missing', sequence: 2 },
    unexpected: { label: 'Unexpected', sequence: 3 },
} as const
export type AuditLineResult = keyof typeof AUDIT_LINE_RESULT_CHOICES

export const ATTESTATION_RESPONSE_CHOICES = {
    confirmed: { label: 'Present', sequence: 0 },
    missing: { label: 'Not present', sequence: 1 },
    unknown: { label: "Don't know", sequence: 2 },
} as const
export type AttestationResponse = keyof typeof ATTESTATION_RESPONSE_CHOICES

export const EXCEPTION_TYPE_CHOICES = {
    unseen: { label: 'Installed but not seen', sequence: 0 },
    serial_mismatch: { label: 'Serial differs from CI', sequence: 1 },
    location_mismatch: { label: 'Site differs from CI', sequence: 2 },
    seen_without_asset: { label: 'Seen device without asset', sequence: 3 },
    audit_missing: { label: 'Missing in audit', sequence: 4 },
    attested_missing: { label: 'Customer reports missing', sequence: 5 },
    rack_overlap: { label: 'Devices overlap in rack', sequence: 6 },
    rack_over_power: { label: 'Rack over power budget', sequence: 7 },
} as const
export type ExceptionType = keyof typeof EXCEPTION_TYPE_CHOICES

export const EXCEPTION_STATUS_CHOICES = {
    open: { label: 'Open', sequence: 0 },
    resolved: { label: 'Resolved', sequence: 1 },
    accepted: { label: 'Accepted (no action)', sequence: 2 },
} as const
export type ExceptionStatus = keyof typeof EXCEPTION_STATUS_CHOICES
export const EXCEPTION_STATUS = {
    open: 'open',
    resolved: 'resolved',
    accepted: 'accepted',
} as const satisfies Named<ExceptionStatus>

/* Billing and Margin */

export const BILLING_PERIOD_STATUS_CHOICES = {
    generating: { label: 'Generating', sequence: 0 },
    ready: { label: 'Ready for review', sequence: 1 },
    closed: { label: 'Closed (locked)', sequence: 2 },
} as const
export type BillingPeriodStatus = keyof typeof BILLING_PERIOD_STATUS_CHOICES
export const BILLING_PERIOD_STATUS = {
    generating: 'generating',
    ready: 'ready',
    closed: 'closed',
} as const satisfies Named<BillingPeriodStatus>

export const BILLING_LINE_KIND_CHOICES = {
    subscription: { label: 'Subscription', sequence: 0 },
    fee: { label: 'Fee', sequence: 1 },
} as const
export type BillingLineKind = keyof typeof BILLING_LINE_KIND_CHOICES

export const COST_TYPE_CHOICES = {
    purchase: { label: 'Purchase (written off)', sequence: 0 },
    lease: { label: 'Lease payment', sequence: 1 },
    oem_support: { label: 'OEM support', sequence: 2 },
    field_labour: { label: 'Field labour', sequence: 3 },
} as const
export type CostType = keyof typeof COST_TYPE_CHOICES
