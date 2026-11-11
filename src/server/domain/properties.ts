/** A system property the app declares: its name, and the value it ships with, which a reader also falls back to. */
export interface PropertyOf<Value extends string | number | boolean> {
    readonly name: string
    readonly default: Value
}

/**
 * Every system property of the app, each with the value it ships with: the one list of them. The Fluent metadata
 * declares each from its entry here (name and value), and the server code reads it through the same entry, so a name
 * is spelled once and a reader's fallback is the declared value. A property per OEM vendor is an entry of a table keyed
 * by vendor, never a name put together at run time.
 */
export const PROPERTY = {
    jobBatchSize: { name: 'x_daas_ham.job.batch_size', default: 500 },
    jobBudgetSeconds: { name: 'x_daas_ham.job.budget_seconds', default: 120 },
    providerCompany: { name: 'x_daas_ham.provider_company', default: '' },
    tagPrefix: { name: 'x_daas_ham.tag.prefix', default: 'NAAS' },
    tagDigits: { name: 'x_daas_ham.tag.digits', default: 7 },
    /**
     * The staging centre's stockroom, which is also the Provider's one depot: purchases and spare-pool buys ship to it,
     * sourcing stages and transfers stock there, and Shipment labels name it as the sender (platform/staging-tasks
     * `stagingStockroom`).
     */
    stagingStockroom: { name: 'x_daas_ham.staging.default_stockroom', default: '' },
    eventsMaxBatch: { name: 'x_daas_ham.events.max_batch', default: 500 },
    eventsRetentionDays: { name: 'x_daas_ham.events.retention_days', default: 90 },
    autoPurchaseSpares: { name: 'x_daas_ham.spare_pool.auto_purchase', default: false },
    unseenDays: { name: 'x_daas_ham.reconciliation.unseen_days', default: 7 },
    returnGraceDays: { name: 'x_daas_ham.returns.grace_days', default: 14 },
    temporaryReturnLeadDays: { name: 'x_daas_ham.returns.temporary_lead_days', default: 7 },
    refreshHorizonDays: { name: 'x_daas_ham.refresh.horizon_days', default: 90 },
    leaseDecisionGroup: { name: 'x_daas_ham.leases.decision_group', default: '' },
    amortisationMonths: { name: 'x_daas_ham.margin.amortisation_months', default: 60 },
    visitCost: { name: 'x_daas_ham.margin.visit_cost', default: 250 },

    shippingEnabled: { name: 'x_daas_ham.shipping.enabled', default: false },
    shippingApiKey: { name: 'x_daas_ham.shipping.api_key', default: '' },
    shippingWebhookToken: { name: 'x_daas_ham.shipping.webhook_token', default: '' },
    shippingCarrierId: { name: 'x_daas_ham.shipping.carrier_id', default: '' },
    shippingServiceCode: { name: 'x_daas_ham.shipping.service_code', default: 'ups_standard' },
    shippingPackageKg: { name: 'x_daas_ham.shipping.package_kg', default: 5 },
    shippingSenderName: { name: 'x_daas_ham.shipping.sender_name', default: '' },
    shippingSenderPhone: { name: 'x_daas_ham.shipping.sender_phone', default: '' },

    /** Whether a vendor's lifecycle and coverage data is read from its API, for the vendors that have one. */
    oemEnabled: {
        cisco: { name: 'x_daas_ham.oem.cisco.enabled', default: false },
        meraki: { name: 'x_daas_ham.oem.meraki.enabled', default: false },
        fortinet: { name: 'x_daas_ham.oem.fortinet.enabled', default: false },
        mist: { name: 'x_daas_ham.oem.mist.enabled', default: false },
    },
    /** The organizations read at a vendor whose API is per organization (comma-separated ids). */
    oemOrgIds: {
        meraki: { name: 'x_daas_ham.meraki.org_ids', default: '' },
        mist: { name: 'x_daas_ham.mist.org_ids', default: '' },
    },
    coverageRefreshDays: { name: 'x_daas_ham.oem.coverage_refresh_days', default: 7 },
    coverageWarningDays: { name: 'x_daas_ham.oem.coverage_warning_days', default: 60 },
    merakiApiHost: { name: 'x_daas_ham.meraki.api_host', default: 'api.meraki.com' },
    merakiApiKey: { name: 'x_daas_ham.meraki.api_key', default: '' },
    mistApiHost: { name: 'x_daas_ham.mist.api_host', default: 'api.mist.com' },
    mistApiToken: { name: 'x_daas_ham.mist.api_token', default: '' },
    checkpointApiClientId: { name: 'x_daas_ham.checkpoint.api_client_id', default: '' },
    checkpointApiKey: { name: 'x_daas_ham.checkpoint.api_key', default: '' },

    claimMaxCalls: { name: 'x_daas_ham.oem.claim.max_calls', default: 8 },
    /** Whether a vendor's cloud claims devices during staging, for the vendors with a cloud to claim into. */
    claimEnabled: {
        meraki: { name: 'x_daas_ham.oem.claim.meraki.enabled', default: false },
        mist: { name: 'x_daas_ham.oem.claim.mist.enabled', default: false },
        aruba: { name: 'x_daas_ham.oem.claim.aruba.enabled', default: false },
        fortinet: { name: 'x_daas_ham.oem.claim.fortinet.enabled', default: false },
        checkpoint: { name: 'x_daas_ham.oem.claim.checkpoint.enabled', default: false },
    },
} as const
