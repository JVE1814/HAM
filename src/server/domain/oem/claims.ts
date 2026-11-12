import { andEachClause } from '../encoded-query.ts'
import { fleetCondition, OEM_SOURCE_FIELD } from '../fleet.ts'
import type { HttpPort, HttpRequest, HttpResponse } from '../http.ts'
import type { OemMessageName } from '../rest-message-names.ts'
import { CLAIM_ACTION_CHOICES, type AutomationStatus, type ClaimAction, type OemVendor } from '../vocabulary.ts'

/**
 * The automated steps of a Staging checklist that the manufacturer's cloud can do for us (plan §13 OEM claim adapters,
 * Q70): what a step's automation status means, which step waits on which, and how runVendorClaims runs one vendor's
 * adapters (domain/oem/claim-adapters) within its call budget against a ClaimStore.
 */

/** The automated checklist actions, in the order a vendor's actions run: a device is claimed before it is licensed or provisioned. */
const CLAIM_ORDER: readonly ClaimAction[] = (Object.keys(CLAIM_ACTION_CHOICES) as ClaimAction[]).sort(
    (a, b) => CLAIM_ACTION_CHOICES[a].sequence - CLAIM_ACTION_CHOICES[b].sequence,
)

export interface ClaimTarget {
    stepId: string
    serial: string
    mac: string
    claimCode: string
    /** The Customer's cloud account the device goes to (org, subscription, FortiManager, Zero Touch "<account id>/<template id>"); '' where the call needs none. */
    account: string
}

export interface ClaimOutcome {
    stepId: string
    ok: boolean
    message: string
}

export interface ClaimRun {
    outcomes: ClaimOutcome[]
    calls: number
}

/** What a claim adapter's transport gives instead of an answer once the run has lost its job lock: the call was not sent. */
export const LOCK_LOST = 'lock lost'

/**
 * A claim adapter's transport. On LOCK_LOST the adapter stops and returns the outcomes it has: a step whose call was
 * not sent gets none, so it is left as it was for the run that holds the lock.
 */
export type ClaimPort = (request: HttpRequest) => HttpResponse | typeof LOCK_LOST

export type ClaimAdapter = (targets: readonly ClaimTarget[], http: ClaimPort, maxCalls: number) => ClaimRun

export type VendorClaimRoutes = Partial<Record<ClaimAction, ClaimRoute>>

export interface ClaimRoute {
    message: OemMessageName
    run: ClaimAdapter
    /**
     * Targets one API call can carry (below 1 where each target takes several calls); sizes how many
     * steps a run loads. It is an upper bound: steps settled without a call (no account, missing
     * identifier) and batches split per account leave some of the budget for the next run.
     */
    perCall: number
    /**
     * Whose cloud account the calls put the device in: the Customer's (ClaimTarget.account), so a step without one is
     * refused unsent, or the Provider's own (GreenLake workspace, FortiCloud registration).
     */
    account: 'customer' | 'provider'
}

/** Licensing and zero-touch need the device claimed first: on a staging task that also has a claim step, their step waits for it (initialAutomationStatus). */
export const CLAIM_PREREQUISITE: Partial<Record<ClaimAction, ClaimAction>> = { oem_licence: 'oem_claim', oem_ztp: 'oem_claim' }

export function dependentActions(action: string): ClaimAction[] {
    return CLAIM_ORDER.filter((dependent) => CLAIM_PREREQUISITE[dependent] === action)
}

/**
 * The automation status of a step (x_daas_ham_staging_step.automation_status) by what it means to the claim run. A
 * step starts pending, or waiting when its prerequisite step is on the task too (initialAutomationStatus); a waiting one
 * is released to pending when that step is ticked; a run settles a pending step done or failed; a failed one is due
 * again RETRY_AFTER_MINUTES later, until it has failed MAX_CLAIM_ATTEMPTS times (dueStepsQuery).
 */
export const STEP_STATUS = {
    /** To send at the next run. */
    pending: 'pending',
    /** Never due: its prerequisite step is not done yet. */
    waiting: 'waiting',
    done: 'done',
    failed: 'failed',
} as const satisfies Record<string, AutomationStatus>

/**
 * The automation status a new `action` step starts in when a template's steps are copied onto a staging
 * task: waiting when the task also gets the step's CLAIM_PREREQUISITE step, otherwise pending.
 * `taskActions` are the automations of all the task's steps ('' for a step done by hand).
 * A waiting step is never due, so no run loads or attempts it and it uses no attempts; it goes to pending
 * when its prerequisite step is ticked done, by hand or by a run.
 */
export function initialAutomationStatus(action: string, taskActions: readonly string[]): Extract<AutomationStatus, 'pending' | 'waiting'> {
    const prerequisite: string | undefined = CLAIM_PREREQUISITE[action as ClaimAction]
    return prerequisite && taskActions.includes(prerequisite) ? STEP_STATUS.waiting : STEP_STATUS.pending
}

/** Steps loaded per action and run at most. */
const MAX_STEPS_PER_LOAD = 200

/** Attempts after which a failing step is left for a person. */
const MAX_CLAIM_ATTEMPTS = 5

/** How long a failed step waits before a run sends it again, counted from its last save: any save of it restarts the wait. */
const RETRY_AFTER_MINUTES = 30

/** Length of a staging step's `automation_message`. */
export const AUTOMATION_MESSAGE_LENGTH = 255

/** Where a run reads its due steps and records their outcomes (the Glide store is in platform/claim-steps.ts). */
export interface ClaimStore {
    /**
     * Up to `limit` of `vendor`'s steps due for `action` (dueStepsQuery: pending, or failed and due a retry),
     * fewest attempts first, then oldest; each carries the Customer's OEM cloud account for `action`
     * ('' when none).
     */
    due(vendor: OemVendor, action: ClaimAction, limit: number): ClaimTarget[]
    /**
     * Record the outcomes of one action's run (each step at most once): ok ticks the step done; otherwise it has failed
     * one more attempt. Messages are at most AUTOMATION_MESSAGE_LENGTH long.
     */
    settle(outcomes: readonly ClaimOutcome[]): void
}

const NO_ACCOUNT = 'no cloud account configured for this customer'

function stepsFor(route: ClaimRoute, remaining: number): number {
    return Math.min(MAX_STEPS_PER_LOAD, Math.max(1, Math.ceil(remaining * route.perCall)))
}

/**
 * One vendor's 5-minute run of its `routes`. Its actions run in the fixed order oem_claim, oem_licence, oem_ztp and share maxCalls.
 * An action is loaded only while calls remain.
 * The outcomes the adapter returns (attempted or refused steps) are settled together, once per action; loaded
 * steps the budget did not reach are not settled and wait for the next run. Returns the calls made (<= maxCalls).
 * `held` is asked before every load and every call: once it says no (the run's job lock went to another run), nothing
 * more is loaded or sent, the outcomes of calls already made are still settled, and `lockLost` says so.
 */
export function runVendorClaims(
    vendor: OemVendor,
    routes: VendorClaimRoutes,
    store: ClaimStore,
    transport: (message: OemMessageName) => HttpPort,
    maxCalls: number,
    held: () => boolean,
): { calls: number; lockLost: boolean } {
    let calls = 0
    let lockLost = false
    const stillHeld = (): boolean => {
        if (!lockLost && !held()) lockLost = true
        return !lockLost
    }
    const whileHeld = (port: HttpPort): ClaimPort => (request) => (stillHeld() ? port(request) : LOCK_LOST)
    for (const action of CLAIM_ORDER) {
        const route = routes[action]
        if (!route) continue
        const remaining = maxCalls - calls
        if (remaining <= 0 || !stillHeld()) break
        const targets = store.due(vendor, action, stepsFor(route, remaining))
        if (targets.length === 0) continue
        const noAccount = route.account === 'customer' ? targets.filter((target) => !target.account) : []
        const run = route.run(noAccount.length > 0 ? targets.filter((target) => target.account) : targets, whileHeld(transport(route.message)), remaining)
        calls += run.calls
        const outcomes = [...noAccount.map((target) => ({ stepId: target.stepId, ok: false, message: NO_ACCOUNT })), ...run.outcomes]
        store.settle(outcomes.map((outcome) => ({ ...outcome, message: outcome.message.slice(0, AUTOMATION_MESSAGE_LENGTH) })))
    }
    return { calls, lockLost }
}

export const OPEN_STEP = 'done=false^staging_task.active=true'

/**
 * Encoded query on x_daas_ham_staging_step: open automated `action` steps on `vendor` fleet assets (ADR 0016) whose
 * staging task is active. Only a fleet asset's serial is sent to an OEM cloud.
 */
function openStepsQuery(vendor: OemVendor, action: ClaimAction): string {
    const asset = 'staging_task.asset.'
    return `automation=${action}^${OPEN_STEP}^${asset}model.${OEM_SOURCE_FIELD}=${vendor}^${fleetCondition(asset)}`
}

/**
 * Encoded query on x_daas_ham_staging_step: open `action` steps (openStepsQuery) that are pending, or failed over
 * RETRY_AFTER_MINUTES ago with fewer than MAX_CLAIM_ATTEMPTS attempts (so never waiting ones); those conditions are in
 * every OR group (andEachClause).
 */
export function dueStepsQuery(vendor: OemVendor, action: ClaimAction): string {
    const retry = `attempts<${MAX_CLAIM_ATTEMPTS}^sys_updated_on<javascript:gs.minutesAgoStart(${RETRY_AFTER_MINUTES})`
    return andEachClause(
        `automation_status=${STEP_STATUS.pending}^NQautomation_status=${STEP_STATUS.failed}^${retry}`,
        openStepsQuery(vendor, action),
    )
}
