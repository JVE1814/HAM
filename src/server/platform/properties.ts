import { gs } from '@servicenow/glide'

/** Names of the system properties the app reads (declared in src/fluent/logic/properties.now.ts). */
export const PROPERTY = {
    jobBatchSize: 'x_daas_ham.job.batch_size',
    jobBudgetSeconds: 'x_daas_ham.job.budget_seconds',
    providerCompany: 'x_daas_ham.provider_company',
    tagPrefix: 'x_daas_ham.tag.prefix',
    tagDigits: 'x_daas_ham.tag.digits',
    stagingStockroom: 'x_daas_ham.staging.default_stockroom',
    eventsMaxBatch: 'x_daas_ham.events.max_batch',
    eventsRetentionDays: 'x_daas_ham.events.retention_days',
    autoPurchaseSpares: 'x_daas_ham.spare_pool.auto_purchase',
    unseenDays: 'x_daas_ham.reconciliation.unseen_days',
    returnGraceDays: 'x_daas_ham.returns.grace_days',
    temporaryReturnLeadDays: 'x_daas_ham.returns.temporary_lead_days',
    refreshHorizonDays: 'x_daas_ham.refresh.horizon_days',
    coverageWarningDays: 'x_daas_ham.oem.coverage_warning_days',
    leaseDecisionGroup: 'x_daas_ham.leases.decision_group',
    amortisationMonths: 'x_daas_ham.margin.amortisation_months',
    visitCost: 'x_daas_ham.margin.visit_cost',
    shippingEnabled: 'x_daas_ham.shipping.enabled',
    shippingWebhookToken: 'x_daas_ham.shipping.webhook_token',
    shippingCarrierId: 'x_daas_ham.shipping.carrier_id',
    shippingServiceCode: 'x_daas_ham.shipping.service_code',
    shippingPackageKg: 'x_daas_ham.shipping.package_kg',
    shippingSenderName: 'x_daas_ham.shipping.sender_name',
    shippingSenderPhone: 'x_daas_ham.shipping.sender_phone',
    claimMaxCalls: 'x_daas_ham.oem.claim.max_calls',
} as const

export function intProperty(name: string, fallback: number): number {
    const value = parseInt(gs.getProperty(name, String(fallback)), 10)
    return Number.isFinite(value) ? value : fallback
}

/** A string property, trimmed; `fallback` when it is unset, empty or only whitespace. */
export function stringProperty(name: string, fallback = ''): string {
    return (gs.getProperty(name, fallback) || '').trim() || fallback
}

export function boolProperty(name: string, fallback: boolean): boolean {
    return gs.getProperty(name, String(fallback)) === 'true'
}
