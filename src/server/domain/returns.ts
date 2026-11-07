import { addDays } from './calendar'
import type { NamedRecord } from './entitlement'
import { DEPLOYED_STAGES, stagesQuery, type LegalOwner, type Stage } from './lifecycle'
import type { VisibilityScope } from './visibility'

/** Returns, depot evaluation, Fee events and break-fix shortfalls (P2.3–P2.4). */

/** The Customer a requested Return is for and the Site it names, with the Customer that Site belongs to. */
export interface RequestedReturn {
    customerId: string
    site?: NamedRecord & { isSite: boolean }
}

/** The person requesting a Return: whether the Return create rule lets them, how far they see (ADR 0005) and their own Customer. */
export interface ReturnRequester {
    mayRequest: boolean
    scope: VisibilityScope
    customerId: string
}

/**
 * Why a requested Return cannot be raised; empty when it can. As for an Order (domain/entitlement `ownershipFindings`):
 * only those the Return create rule lets in ask for returns, and site contacts never do; provider staff and the service
 * desk ask for any Customer, a customer admin only for their own; and the Site must be one of the Customer's sites.
 */
export function returnRequestFindings(request: RequestedReturn, requester: ReturnRequester): string[] {
    if (!requester.mayRequest || requester.scope === 'own_sites') return ['You may not request returns']
    if (requester.scope === 'own_customer' && request.customerId !== requester.customerId) return ['You can only request returns for your own customer']
    if (!request.customerId) return ['Choose the customer']
    if (!request.site) return ["Choose one of the customer's sites"]
    if (!request.site.isSite || request.site.customerId !== request.customerId) return ["The site is not one of the customer's sites"]
    return []
}

export function returnDueDate(raisedOn: string, allowanceDays: number): string {
    return addDays(raisedOn, allowanceDays)
}

export type OverdueStep = 'none' | 'escalate' | 'declare_missing'

/** What to do about an unreturned Asset today: escalate once after the due date, declare it missing after the grace period. */
export function overdueStep(input: { dueDate: string; today: string; graceDays: number; received: boolean; escalated: boolean }): OverdueStep {
    if (input.received || input.today <= input.dueDate) return 'none'
    if (input.today > addDays(input.dueDate, input.graceDays)) return 'declare_missing'
    return input.escalated ? 'none' : 'escalate'
}

/**
 * The Assets that keep a site package open, as an encoded alm_hardware query: those at its Site under its Agreement
 * on their way there, serving there or on their way back. A unit received at the depot or declared missing no longer
 * counts. A swap's new units do, before monitoring first sees them and attaches them to the package, so a swap-back
 * that reaches the depot first does not end it (D60).
 */
export function sitePackageHoldersQuery(line: { siteId: string; agreementId: string }): string {
    return stagesQuery(DEPLOYED_STAGES, `x_daas_ham_site=${line.siteId}^x_daas_ham_agreement=${line.agreementId}`)
}

export type EvaluationOutcome = 'refurbish' | 'oem_rma' | 'scrap' | 'return_to_owner'

/** Where a returned Asset goes after depot evaluation. Customer-owned units never join provider stock. */
export function evaluationTarget(outcome: EvaluationOutcome, legalOwner: LegalOwner): Stage {
    switch (outcome) {
        case 'refurbish':
            return legalOwner === 'customer' ? 'pending_wipe' : 'available'
        case 'oem_rma':
            return 'pending_oem_rma'
        case 'scrap':
        case 'return_to_owner':
            return 'pending_wipe'
    }
}

export type FeeType = 'lost' | 'damaged' | 'late_return'

export function feeAmount(type: FeeType, agreementFees: Record<FeeType, number>): number {
    return agreementFees[type]
}

export type ShortfallRoute = 'none' | 'purchase' | 'oem_advance_replacement'

/** A covered unit that fails with no stock left is replaced by the OEM in advance; anything else is purchased. */
export function shortfallRoute(input: { missing: number; purpose: 'new' | 'replace'; coveredToday: boolean }): ShortfallRoute {
    if (input.missing <= 0) return 'none'
    return input.purpose === 'replace' && input.coveredToday ? 'oem_advance_replacement' : 'purchase'
}
