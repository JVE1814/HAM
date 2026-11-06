/**
 * Entitlement: is an Order within the Customer's Agreement?
 *
 * - Every Model must be a Catalog entry, or come from a catalogued Site template.
 * - Usage (deployed + in-flight) plus the request must not exceed a Contracted quantity.
 *   A model-specific quantity caps that model; a device-class quantity caps the class.
 *   Classes without a quantity are not capped.
 * Off-catalog needs the Customer admin; over quota also needs the account manager.
 */

export type Approver = 'customer_admin' | 'account_manager'
export type EntitlementVerdict = 'within_agreement' | 'off_catalog' | 'over_quota'

export interface CatalogEntryView {
    kind: 'model' | 'site_template'
    modelId?: string
    siteTemplateId?: string
    active: boolean
    validFrom?: string
    validTo?: string
}

export interface ContractedQuantity {
    deviceClass: string
    modelId?: string
    contracted: number
}

export interface Usage {
    deviceClass: string
    modelId: string
    count: number
}

export interface EntitlementContext {
    catalog: readonly CatalogEntryView[]
    quantities: readonly ContractedQuantity[]
    usage: readonly Usage[]
    today: string
}

export interface RequestedLine {
    modelId: string
    deviceClass: string
    quantity: number
    fromSiteTemplate?: boolean
}

export interface OrderRequest {
    siteTemplateId?: string
    lines: readonly RequestedLine[]
}

export interface EntitlementAssessment {
    verdict: EntitlementVerdict
    approvers: Approver[]
    findings: string[]
}

function isCurrent(entry: CatalogEntryView, today: string): boolean {
    if (!entry.active) return false
    if (entry.validFrom && entry.validFrom > today) return false
    if (entry.validTo && entry.validTo < today) return false
    return true
}

export function assessOrder(request: OrderRequest, context: EntitlementContext): EntitlementAssessment {
    const current = context.catalog.filter((entry) => isCurrent(entry, context.today))
    const catalogued = (kind: CatalogEntryView['kind'], id: string) =>
        current.some((e) => e.kind === kind && (kind === 'model' ? e.modelId : e.siteTemplateId) === id)

    const offCatalog: string[] = []
    if (request.siteTemplateId && !catalogued('site_template', request.siteTemplateId)) {
        offCatalog.push(`Site template ${request.siteTemplateId} is not in the customer catalog`)
    }
    for (const line of request.lines) {
        const viaTemplate = line.fromSiteTemplate && request.siteTemplateId
        if (!viaTemplate && !catalogued('model', line.modelId)) {
            offCatalog.push(`Model ${line.modelId} is not in the customer catalog`)
        }
    }

    const overQuota = context.quantities.flatMap((quantity) => {
        const applies = (item: { deviceClass: string; modelId: string }) =>
            quantity.modelId ? item.modelId === quantity.modelId : item.deviceClass === quantity.deviceClass
        const inUse = sum(context.usage.filter(applies).map((u) => u.count))
        const requested = sum(request.lines.filter(applies).map((l) => l.quantity))
        if (requested === 0 || inUse + requested <= quantity.contracted) return []
        const scope = quantity.modelId ? `${quantity.deviceClass} ${quantity.modelId}` : quantity.deviceClass
        return [`${scope}: ${inUse} in use + ${requested} requested exceeds ${quantity.contracted} contracted`]
    })

    const findings = [...offCatalog, ...overQuota]
    if (overQuota.length > 0) return { verdict: 'over_quota', approvers: ['customer_admin', 'account_manager'], findings }
    if (offCatalog.length > 0) return { verdict: 'off_catalog', approvers: ['customer_admin'], findings }
    return { verdict: 'within_agreement', approvers: [], findings }
}

function sum(values: number[]): number {
    return values.reduce((a, b) => a + b, 0)
}
