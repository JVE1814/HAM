import { addDays } from './calendar.ts'
import { actorRefusal, CHOOSE_CUSTOMER, siteFinding, type ActWording, type NamedSite } from './customer-parties.ts'
import { fleetStagesQuery } from './fleet.ts'
import { DEPLOYED_STAGES, INSTALLED_STAGES, SERVING_STAGES, type Stage } from './lifecycle.ts'
import type { VisibilityScope } from './visibility.ts'
import {
    type EvaluationOutcome,
    FEE_STATUS,
    type InstallMode,
    type LeaseEndAction,
    type LegalOwner,
    ORDER_STAGE,
    type OrderStage,
    type ReturnLineStatus,
    type ReturnMethod,
    RETURN_LINE_STATUS,
    RETURN_TRIGGER,
    type ReturnTrigger,
    TASK_STATE,
} from './vocabulary.ts'

/** Returns, depot evaluation and Fee events (P2.4). */

export interface RequestedReturn {
    customerId: string
    site?: NamedSite
}

/** The person requesting a Return: whether the Return create rule lets them, how far they see (ADR 0005) and their own Customer. */
export interface ReturnRequester {
    mayRequest: boolean
    scope: VisibilityScope
    customerId: string
}

const REQUESTING_RETURNS: ActWording = { act: 'request returns', actForOwn: 'request returns' }

/**
 * Why this person may not request a Return for the Customer, or null when they may (domain/customer-parties
 * `actorRefusal`, as for an Order): only those the Return create rule lets in ask for returns, a customer admin only
 * for their own Customer.
 */
export function returnRequesterRefusal(customerId: string, requester: ReturnRequester): string | null {
    return actorRefusal(customerId, { ...requester, permitted: requester.mayRequest }, REQUESTING_RETURNS)
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
    const misplaced = request.customerId ? siteFinding(request.customerId, request.site) : CHOOSE_CUSTOMER
    return misplaced ? [{ about: 'site', message: misplaced }] : []
}

/**
 * The platform's task states a Return order takes: Work in Progress while units are awaited or evaluated, Closed
 * Complete once every line is settled (or it has none).
 */
export const RETURN_TASK_STATE = { inProgress: TASK_STATE.workInProgress, closed: TASK_STATE.closedComplete } as const

/** The stages of a temporary deployment whose end date is watched: its equipment is being installed or is installed. */
export const TEMPORARY_RETURN_STAGES: readonly OrderStage[] = [ORDER_STAGE.installing, ORDER_STAGE.complete]

/** Encoded query on Fee events: the open ones, not yet billed nor waived, which the workspace lists. */
export const OPEN_FEES_QUERY = `status=${FEE_STATUS.open}`

/** The status of a Return line whose unit is still expected back: not at the depot yet, nor declared missing. */
export const AWAITED: ReturnLineStatus = RETURN_LINE_STATUS.awaiting

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
 * so a swap-back that reaches the depot first does not end it (Q60).
 */
export function sitePackageHoldersQuery(line: { siteId: string; agreementId: string }): string {
    return fleetStagesQuery(DEPLOYED_STAGES, `x_daas_ham_site=${line.siteId}^x_daas_ham_agreement=${line.agreementId}`)
}

/**
 * A whole-Site recovery: the Returns that bring back all of a Site, by their trigger. What makes a Return one, the
 * stages it takes units in and the lines that await them are all said here.
 */
const SITE_RECOVERY_TRIGGERS: readonly ReturnTrigger[] = [RETURN_TRIGGER.site_decommission, RETURN_TRIGGER.agreement_end]

export function isSiteRecovery(trigger: ReturnTrigger): boolean {
    return SITE_RECOVERY_TRIGGERS.includes(trigger)
}

/** The trigger of a Return its Customer requests: for the whole Site (a decommission), or for the devices it lists. */
export function requestedTrigger(decommission: boolean): ReturnTrigger {
    return decommission ? RETURN_TRIGGER.site_decommission : RETURN_TRIGGER.device_removal
}

/**
 * The Returns that end a deployment: a whole-Site recovery, and a temporary Order's end. Each takes back the units
 * still shipped too, which stay on their Order lines (domain/fulfilment `refillsLine`).
 */
const DEPLOYMENT_END_TRIGGERS: readonly ReturnTrigger[] = [...SITE_RECOVERY_TRIGGERS, RETURN_TRIGGER.temporary_end]

/** Encoded query on x_daas_ham_return_order_line: the Asset is awaited back on a Return that ends its deployment. */
export function deploymentEndLineQuery(assetId: string): string {
    return `asset=${assetId}^status=${AWAITED}^return_order.triggerIN${DEPLOYMENT_END_TRIGGERS.join(',')}`
}

/**
 * What a whole-Site recovery (agreement end, site decommission) takes back: every unit serving the Site, including
 * those still shipped there, which the lifecycle lets go straight to pending return. Left off, a shipped unit would
 * miss the agreement-end Return, raised only once, and hold the site package open for good (`sitePackageHoldersQuery`).
 */
export const SITE_RECOVERY_STAGES: readonly Stage[] = SERVING_STAGES

/**
 * The stages of the units a Return with this trigger takes back: one that ends their deployment those still shipped
 * too, any other the installed ones. A temporary Order's units still shipped once its end date has passed would
 * otherwise stay deployed, and billed, with no Return raised again.
 */
export function stagesTakenBack(trigger: ReturnTrigger): readonly Stage[] {
    return DEPLOYMENT_END_TRIGGERS.includes(trigger) ? SITE_RECOVERY_STAGES : INSTALLED_STAGES
}

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
