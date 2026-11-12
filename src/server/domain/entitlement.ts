import { APPROVER, type Approver } from './approvals.ts'
import {
    actorRefusal,
    agreementFinding,
    CHOOSE_CUSTOMER,
    siteFinding,
    type ActWording,
    type NamedRecord,
    type NamedSite,
} from './customer-parties.ts'
import { fleetStagesQuery } from './fleet.ts'
import { OPEN_LINE_STAGES, UNFULFILLED_ORDER_STAGES } from './fulfilment.ts'
import { DEPLOYED_STAGES } from './lifecycle.ts'
import type { VisibilityScope } from './visibility.ts'
import { ORDER_STAGE, type CatalogEntryType, type EntitlementVerdict, type OrderStage } from './vocabulary.ts'

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

export interface CatalogEntryView {
    kind: CatalogEntryType
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

export function isCurrent(entry: CatalogEntryView, today: string): boolean {
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

/** The Customer an Order is for and the records it names; a record the Order does not name is left out. */
export interface OrderParties {
    customerId: string
    agreement?: NamedRecord
    site?: NamedSite
    siteTemplate?: NamedRecord
}

/** The person raising an Order: whether they are an Order raiser at all, how far they see (ADR 0005) and their own Customer. */
export interface Orderer {
    mayRaise: boolean
    scope: VisibilityScope
    customerId: string
}

const RAISING_ORDERS: ActWording = { act: 'raise orders', actForOwn: 'order' }

/**
 * Why this person may not raise an Order for the Customer, or null when they may: only Order raisers raise Orders, a
 * customer admin only for their own Customer.
 */
export function raiserRefusal(customerId: string, orderer: Orderer): string | null {
    return actorRefusal(customerId, { ...orderer, permitted: orderer.mayRaise }, RAISING_ORDERS)
}

export function siteTemplateOffered(order: OrderParties): boolean {
    const offeredTo = order.siteTemplate?.customerId
    return !order.siteTemplate || offeredTo === '' || offeredTo === order.customerId
}

/** Why an Order cannot go ahead as raised; empty when it can. */
export function ownershipFindings(order: OrderParties, orderer: Orderer): string[] {
    const refusal = raiserRefusal(order.customerId, orderer)
    if (refusal) return [refusal]
    if (!order.customerId) return [CHOOSE_CUSTOMER]
    const findings = [agreementFinding(order.customerId, order.agreement), siteFinding(order.customerId, order.site)].filter(
        (finding): finding is string => finding !== null,
    )
    if (!siteTemplateOffered(order)) findings.push('The site template is not offered to the customer')
    return findings
}

export function approversFor(verdict: EntitlementVerdict | ''): Approver[] {
    switch (verdict) {
        case 'over_quota':
            return [APPROVER.customerAdmin, APPROVER.provider]
        case 'off_catalog':
            return [APPROVER.customerAdmin]
        default:
            return []
    }
}

/**
 * Encoded query on alm_hardware: the Agreement's fleet assets (ADR 0016) counted as deployed usage. One still on an
 * open Order line is left out, as that line's quantity counts it in flight: a unit a partial Ship sent counts once.
 */
export function deployedUsageQuery(agreementId: string): string {
    const notInFlight = `x_daas_ham_order_lineISEMPTY^ORx_daas_ham_order_line.line_stageNOT IN${OPEN_LINE_STAGES.join(',')}`
    return fleetStagesQuery(DEPLOYED_STAGES, `x_daas_ham_agreement=${agreementId}^${notInFlight}`)
}

/**
 * Whether assessing these lines reads the Agreement's usage: only lines that add a unit do (`assessOrder` exempts those
 * replacing an Asset). An Order with none gets the same verdict whatever is in flight, and its lines going into flight
 * beside a submission that reads usage read as if it had come first or last, so its submission need not take turns
 * (domain/lock-names `agreementUsage`).
 */
export function readsUsage(lines: readonly RequestedLine[]): boolean {
    return lines.some((line) => !line.replacesAsset)
}

/** Order stages whose lines use nothing of an Agreement: a draft is not asked for yet, and one that ended unfulfilled never will be. */
const NOT_YET_LIVE_OR_UNFULFILLED: readonly OrderStage[] = [ORDER_STAGE.draft, ...UNFULFILLED_ORDER_STAGES]

export function inFlightLinesQuery(agreementId: string, excludeOrderId: string): string {
    return `order.agreement=${agreementId}^order!=${excludeOrderId}^order.stageNOT IN${NOT_YET_LIVE_OR_UNFULFILLED.join(',')}^line_stageIN${OPEN_LINE_STAGES.join(',')}`
}

function sum(values: number[]): number {
    return values.reduce((a, b) => a + b, 0)
}
