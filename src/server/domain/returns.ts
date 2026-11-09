import { addDays } from './calendar.ts'
import type { NamedRecord } from './entitlement.ts'
import { fleetStagesQuery } from './fleet.ts'
import { DEPLOYED_STAGES, SERVING_STAGES, type Stage } from './lifecycle.ts'
import type { VisibilityScope } from './visibility.ts'
import type {
    EvaluationOutcome,
    FeeStatus,
    FeeType,
    InstallMode,
    LeaseEndAction,
    LegalOwner,
    ReturnLineStatus,
    ReturnMethod,
    ReturnTrigger,
} from './vocabulary.ts'

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
 * Why this person may not request a Return for the Customer, or null when they may. As for an Order (domain/entitlement
 * `raiserRefusal`): only those the Return create rule lets in ask for returns, and site contacts never do; provider
 * staff and the service desk ask for any Customer, a customer admin only for their own.
 */
export function returnRequesterRefusal(customerId: string, requester: ReturnRequester): string | null {
    if (!requester.mayRequest || requester.scope === 'own_sites') return 'You may not request returns'
    if (requester.scope === 'own_customer' && customerId !== requester.customerId) {
        return 'You can only request returns for your own customer'
    }
    return null
}

/** Why a requested Return cannot be raised, and what it is about: who asks for it, or the Customer and Site it names. */
export interface ReturnRequestFinding {
    about: 'requester' | 'site'
    message: string
}

/**
 * Why a requested Return cannot be raised; empty when it can: the person must be allowed to request it for its Customer
 * (`returnRequesterRefusal`), and the Site must be one of the Customer's sites.
 */
export function returnRequestFindings(request: RequestedReturn, requester: ReturnRequester): ReturnRequestFinding[] {
    const refusal = returnRequesterRefusal(request.customerId, requester)
    if (refusal) return [{ about: 'requester', message: refusal }]
    const misplaced = siteFinding(request)
    return misplaced ? [{ about: 'site', message: misplaced }] : []
}

function siteFinding(request: RequestedReturn): string | null {
    if (!request.customerId) return 'Choose the customer'
    if (!request.site) return "Choose one of the customer's sites"
    if (!request.site.isSite || request.site.customerId !== request.customerId) return "The site is not one of the customer's sites"
    return null
}

/**
 * The platform's task states a Return order takes: Work in Progress while units are awaited or evaluated, Closed
 * Complete once every line is settled (or it has none).
 */
export const RETURN_TASK_STATE = { inProgress: 2, closed: 3 } as const

/** The status of a Return line whose unit is still expected back: not at the depot yet, nor declared missing. */
export const AWAITED: ReturnLineStatus = 'awaiting'

/** The lines an arriving unit settles: awaited, or declared missing and now turning up late. */
export const SETTLED_BY_RECEIPT: readonly ReturnLineStatus[] = ['awaiting', 'missing']

/** The lines that keep their Return order open: every other is evaluated or declared missing. */
export const KEEPS_RETURN_OPEN: readonly ReturnLineStatus[] = ['awaiting', 'received']

/** Returns whose unit the swap's own work order collects, so they open no de-install work of their own. */
const COLLECTED_BY_SWAP: readonly ReturnTrigger[] = ['refresh_swap_back', 'defective_return']

/** Whether a Return opens a de-install change and work order: a field de-install no swap work order already covers. */
export function opensDeinstallWork(trigger: ReturnTrigger, method: ReturnMethod): boolean {
    return method === 'fsm_deinstall' && !COLLECTED_BY_SWAP.includes(trigger)
}

/** How the units of an Order come back: the Site ships back what it installed itself, a field engineer collects the rest. */
export function collectionMethod(installMode: InstallMode | ''): ReturnMethod {
    return installMode === 'self_install' ? 'ship_back' : 'fsm_deinstall'
}

/** Whether a unit received `today` came back after its Return order's due date ('' = none set, never late). */
export function receivedLate(dueBack: string, today: string): boolean {
    return !!dueBack && today > dueBack
}

/** The days a Customer has to hand equipment back when its Agreement names no allowance. */
const DEFAULT_RETURN_ALLOWANCE_DAYS = 30

/** The day a Return raised on `raisedOn` is due back: after its Agreement's allowance (0 when it names none). */
export function returnDueDate(raisedOn: string, allowanceDays: number): string {
    return addDays(raisedOn, allowanceDays || DEFAULT_RETURN_ALLOWANCE_DAYS)
}

export type OverdueStep = 'none' | 'escalate' | 'declare_missing'

/** What to do about an unreturned Asset today: escalate once after the due date, declare it missing after the grace period. */
export function overdueStep(input: { dueDate: string; today: string; graceDays: number; received: boolean; escalated: boolean }): OverdueStep {
    if (input.received || input.today <= input.dueDate) return 'none'
    if (input.today > addDays(input.dueDate, input.graceDays)) return 'declare_missing'
    return input.escalated ? 'none' : 'escalate'
}

/**
 * The Assets that keep a site package open, as an encoded alm_hardware query: the fleet assets (ADR 0016) at its Site
 * under its Agreement on their way there, serving there or on their way back. A unit received at the depot or declared
 * missing no longer counts. A swap's new units do, before monitoring first sees them and attaches them to the package,
 * so a swap-back that reaches the depot first does not end it (D60).
 */
export function sitePackageHoldersQuery(line: { siteId: string; agreementId: string }): string {
    return fleetStagesQuery(DEPLOYED_STAGES, `x_daas_ham_site=${line.siteId}^x_daas_ham_agreement=${line.agreementId}`)
}

/** Installed at a Site: in service, temporary or awaiting first sighting (temporary ends, audits, attestations). */
export const INSTALLED_STAGES: readonly Stage[] = ['in_service', 'temporary_deployment', 'pending_in_service']

/**
 * What a whole-Site recovery (agreement end, site decommission) takes back: every unit serving the Site, including
 * those still shipped there, which the lifecycle lets go straight to pending return. Left off, a shipped unit would
 * miss the agreement-end Return, raised only once, and hold the site package open for good (`sitePackageHoldersQuery`).
 */
export const SITE_RECOVERY_STAGES: readonly Stage[] = SERVING_STAGES

/** Who an evaluated Asset belongs to: its Legal owner and the end action of its lease ('' without one). */
export interface EvaluatedOwnership {
    legalOwner: LegalOwner | ''
    leaseEndAction: LeaseEndAction | ''
}

const OUTCOME_TARGET: Record<EvaluationOutcome, Stage> = {
    refurbish: 'available',
    oem_rma: 'pending_oem_rma',
    scrap: 'pending_wipe',
    return_to_owner: 'pending_wipe',
}

/**
 * Where a returned Asset goes after depot evaluation. A unit its owner takes back never joins provider stock: one the
 * Customer owns, or one the Lessor owns on a lease being returned to it (ADR 0011), goes to wiping instead of being
 * available again, on its way to a return-to-customer or return-to-lessor disposal.
 */
export function evaluationTarget(outcome: EvaluationOutcome, ownership: EvaluatedOwnership): Stage {
    const target = OUTCOME_TARGET[outcome]
    return target === 'available' && ownerTakesBack(ownership) ? 'pending_wipe' : target
}

function ownerTakesBack({ legalOwner, leaseEndAction }: EvaluatedOwnership): boolean {
    return legalOwner === 'customer' || (legalOwner === 'lessor' && leaseEndAction === 'return')
}

export function feeAmount(type: FeeType, agreementFees: Record<FeeType, number>): number {
    return agreementFees[type]
}

/** What makes two Fee events the same charge: one type, for one Asset on one Return order (that is, its line). */
export interface FeeIdentity {
    type: FeeType
    assetId: string
    returnOrderId: string
}

/**
 * A Fee event's statuses: open until a closed Billing period bills it, or waived (a missing unit turned up), which is
 * never billed.
 */
export const FEE_STATUS = { open: 'open', billed: 'billed', waived: 'waived' } as const satisfies { [S in FeeStatus]: S }

/** The x_daas_ham_fee_event query for the charges of `fee` that count, any not waived: it is charged at most once. */
export function chargedFeeQuery(fee: FeeIdentity): string {
    return `fee_type=${fee.type}^asset=${fee.assetId}^return_order=${fee.returnOrderId}^status!=${FEE_STATUS.waived}`
}

export type ShortfallRoute = 'none' | 'purchase' | 'oem_advance_replacement'

/** A covered unit that fails with no stock left is replaced by the OEM in advance; anything else is purchased. */
export function shortfallRoute(input: { missing: number; purpose: 'new' | 'replace'; coveredToday: boolean }): ShortfallRoute {
    if (input.missing <= 0) return 'none'
    return input.purpose === 'replace' && input.coveredToday ? 'oem_advance_replacement' : 'purchase'
}
