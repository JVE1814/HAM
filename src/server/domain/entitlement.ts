import { fleetStagesQuery } from './fleet.ts'
import type { LineStage } from './fulfilment.ts'
import { DEPLOYED_STAGES } from './lifecycle.ts'
import type { VisibilityScope } from './visibility.ts'

/**
 * Entitlement: is an Order within the Customer's Agreement?
 *
 * - Only an Order raiser raises an Order, a customer admin only for their own Customer, and it must name its
 *   Customer's own Agreement and Site, and a Site template offered to it (`ownershipFindings`).
 * - Every Model must be a Catalog entry, or come from a catalogued Site template.
 * - Usage (deployed + in-flight) plus the request must not exceed a Contracted quantity.
 *   A model-specific quantity caps that model; a device-class quantity caps the class.
 *   Classes without a quantity are not capped.
 * Off-catalog needs the Customer admin; over quota also needs the account manager.
 * Lines replacing a deployed Asset (break-fix, refresh) are exempt from both checks.
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
    /** A like-for-like replacement of a deployed Asset: neither a new model choice nor extra usage. */
    replacesAsset?: boolean
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
    const additions = request.lines.filter((line) => !line.replacesAsset)
    for (const line of additions) {
        const viaTemplate = line.fromSiteTemplate && request.siteTemplateId
        if (!viaTemplate && !catalogued('model', line.modelId)) {
            offCatalog.push(`Model ${line.modelId} is not in the customer catalog`)
        }
    }

    const overQuota = context.quantities.flatMap((quantity) => {
        const applies = (item: { deviceClass: string; modelId: string }) =>
            quantity.modelId ? item.modelId === quantity.modelId : item.deviceClass === quantity.deviceClass
        const inUse = sum(context.usage.filter(applies).map((u) => u.count))
        const requested = sum(additions.filter(applies).map((l) => l.quantity))
        if (requested === 0 || inUse + requested <= quantity.contracted) return []
        const scope = quantity.modelId ? `${quantity.deviceClass} ${quantity.modelId}` : quantity.deviceClass
        return [`${scope}: ${inUse} in use + ${requested} requested exceeds ${quantity.contracted} contracted`]
    })

    const findings = [...offCatalog, ...overQuota]
    const verdict: EntitlementVerdict =
        overQuota.length > 0 ? 'over_quota' : offCatalog.length > 0 ? 'off_catalog' : 'within_agreement'
    return { verdict, approvers: approversFor(verdict), findings }
}

/**
 * A record an Order names, with the Customer it belongs to: '' for none (a Site template offered to every
 * Customer), null when it cannot be read.
 */
export interface NamedRecord {
    id: string
    customerId: string | null
}

/** The Customer an Order is for and the records it names; a record the Order does not name is left out. */
export interface OrderParties {
    customerId: string
    agreement?: NamedRecord
    site?: NamedRecord & { isSite: boolean }
    siteTemplate?: NamedRecord
}

/** The person raising an Order: whether they are an Order raiser at all, how far they see (ADR 0005) and their own Customer. */
export interface Orderer {
    mayRaise: boolean
    scope: VisibilityScope
    customerId: string
}

/**
 * Why this person may not raise an Order for the Customer, or null when they may. Only Order raisers raise Orders, and
 * site contacts never do; provider staff and the service desk raise them for any Customer, a customer admin only for
 * their own.
 */
export function raiserRefusal(customerId: string, orderer: Orderer): string | null {
    if (!orderer.mayRaise || orderer.scope === 'own_sites') return 'You may not raise orders'
    if (orderer.scope === 'own_customer' && customerId !== orderer.customerId) return 'You can only order for your own customer'
    return null
}

/** Whether the Order names no Site template, or one offered to its Customer or to every Customer. */
export function siteTemplateOffered(order: OrderParties): boolean {
    const offeredTo = order.siteTemplate?.customerId
    return !order.siteTemplate || offeredTo === '' || offeredTo === order.customerId
}

/**
 * Why an Order cannot go ahead as raised; empty when it can. The person must be allowed to raise it for its Customer
 * (`raiserRefusal`), its Agreement and Site must be the Customer's own, and its Site template one offered to it.
 */
export function ownershipFindings(order: OrderParties, orderer: Orderer): string[] {
    const refusal = raiserRefusal(order.customerId, orderer)
    if (refusal) return [refusal]
    if (!order.customerId) return ['Choose the customer']
    const findings: string[] = []
    if (!order.agreement) findings.push("Choose one of the customer's agreements")
    else if (order.agreement.customerId !== order.customerId) findings.push("The agreement is not one of the customer's agreements")
    if (!order.site) findings.push("Choose one of the customer's sites")
    else if (!order.site.isSite || order.site.customerId !== order.customerId) findings.push("The site is not one of the customer's sites")
    if (!siteTemplateOffered(order)) findings.push('The site template is not offered to the customer')
    return findings
}

/** Who must approve an Order with this verdict. */
export function approversFor(verdict: EntitlementVerdict | ''): Approver[] {
    switch (verdict) {
        case 'over_quota':
            return ['customer_admin', 'account_manager']
        case 'off_catalog':
            return ['customer_admin']
        default:
            return []
    }
}

/**
 * Order line stages before the line has shipped: such a line's whole quantity counts as in-flight usage, and it is
 * what cancelling or rejecting its Order cancels.
 */
export const OPEN_LINE_STAGES: readonly LineStage[] = ['new', 'awaiting_stock', 'sourced', 'staging', 'ready_to_ship']

/**
 * Encoded query on alm_hardware: the Agreement's fleet assets (ADR 0016) counted as deployed usage. One still on an
 * open Order line is left out, as that line's quantity counts it in flight: a unit a partial Ship sent counts once.
 */
export function deployedUsageQuery(agreementId: string): string {
    const notInFlight = `x_daas_ham_order_lineISEMPTY^ORx_daas_ham_order_line.line_stageNOT IN${OPEN_LINE_STAGES.join(',')}`
    return fleetStagesQuery(DEPLOYED_STAGES, `x_daas_ham_agreement=${agreementId}^${notInFlight}`)
}

/** Encoded query on x_daas_ham_order_line: the Agreement's open lines on live Orders other than `excludeOrderId`. */
export function inFlightLinesQuery(agreementId: string, excludeOrderId: string): string {
    return `order.agreement=${agreementId}^order!=${excludeOrderId}^order.stageNOT INdraft,rejected,cancelled^line_stageIN${OPEN_LINE_STAGES.join(',')}`
}

function sum(values: number[]): number {
    return values.reduce((a, b) => a + b, 0)
}
