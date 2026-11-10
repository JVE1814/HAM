import { normalizeSerial } from '../serials.ts'
import { chunks } from '../collections.ts'
import { andEachClause } from '../encoded-query.ts'
import { fleetCondition } from '../fleet.ts'
import { errorText, isSuccess, type HttpPort, type HttpRequest, type HttpResponse } from '../http.ts'
import { asArray, field, parseJson, text } from '../json.ts'
import type { AutomationStatus, ClaimAction, OemVendor } from '../vocabulary.ts'
import { fortiCloudError } from './forticloud.ts'
import { REST_MESSAGE } from '../rest-message-names.ts'

/**
 * OEM claim and provisioning (P3.27, D70): staging checklist steps that the manufacturer's cloud can
 * do for us. Each adapter takes a batch of steps, makes at most `maxCalls` calls and reports an
 * outcome for every step it attempted; steps left out wait for the next run (rate limits).
 * runVendorClaims runs one vendor's adapters within its call budget against a ClaimStore.
 */

/** The automated checklist actions, in the order a vendor's actions run: a device is claimed before it is licensed or provisioned. */
const CLAIM_ORDER: readonly ClaimAction[] = ['oem_claim', 'oem_licence', 'oem_ztp']

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

export type ClaimAdapter = (targets: readonly ClaimTarget[], http: HttpPort, maxCalls: number) => ClaimRun

interface ClaimRoute {
    /** Name of the REST message that serves the calls. */
    message: string
    run: ClaimAdapter
    /**
     * Targets one API call can carry (below 1 where each target takes several calls); sizes how many
     * steps a run loads. It is an upper bound: steps settled without a call (no account, missing
     * identifier) and batches split per account leave some of the budget for the next run.
     */
    perCall: number
}

/** Serials per Meraki claim call. */
const MERAKI_CLAIM_BATCH = 50
/** Claim codes per Mist claim call. */
const MIST_CLAIM_BATCH = 100
/** Devices per GreenLake add call (at most five, counting network, compute and storage devices together). */
const GREENLAKE_ADD_BATCH = 5
/** GreenLake subscription assignment: find the device, then PATCH it. */
const GREENLAKE_SUBSCRIBE_CALLS = 2
/** Registration units per FortiCloud register call. */
const FORTICLOUD_REGISTER_BATCH = 10
/** Check Point Zero Touch: the login and logout calls around a session's claim-gateway calls. */
const ZERO_TOUCH_SESSION_CALLS = 2

/** Group targets by account, then cut each group into chunks of `size`. */
function batches(targets: readonly ClaimTarget[], size: number): ClaimTarget[][] {
    const byAccount = new Map<string, ClaimTarget[]>()
    for (const target of targets) {
        const group = byAccount.get(target.account)
        if (group) group.push(target)
        else byAccount.set(target.account, [target])
    }
    return [...byAccount.values()].flatMap((group) => chunks(group, size))
}

function fail(targets: readonly ClaimTarget[], message: string): ClaimOutcome[] {
    return targets.map((t) => ({ stepId: t.stepId, ok: false, message }))
}

/** Done with `okMessage` on a 2xx response, otherwise failed with the API's error. */
function outcome(target: ClaimTarget, response: HttpResponse, okMessage: string): ClaimOutcome {
    return isSuccess(response.status)
        ? { stepId: target.stepId, ok: true, message: okMessage }
        : { stepId: target.stepId, ok: false, message: errorText(response.status, response.body) }
}

/** Targets that cannot be sent at all (missing identifier, or missing account where the call needs one). */
function unusable(
    targets: readonly ClaimTarget[],
    needs: 'serial' | 'claimCode' | 'mac',
    needsAccount = true,
): { usable: ClaimTarget[]; outcomes: ClaimOutcome[] } {
    const outcomes: ClaimOutcome[] = []
    const usable: ClaimTarget[] = []
    for (const target of targets) {
        if (needsAccount && !target.account) outcomes.push({ stepId: target.stepId, ok: false, message: 'no cloud account configured for this customer' })
        else if (!target[needs] || !target.serial) outcomes.push({ stepId: target.stepId, ok: false, message: `missing ${needs === 'claimCode' ? 'claim code' : needs}` })
        else usable.push(target)
    }
    return { usable, outcomes }
}

/** An adapter that makes one call per device (serial and account required). */
function perDevice(request: (target: ClaimTarget) => HttpRequest, okMessage: (target: ClaimTarget) => string): ClaimAdapter {
    return (targets, http, maxCalls) => {
        const { usable, outcomes } = unusable(targets, 'serial')
        const sent = usable.slice(0, Math.max(0, maxCalls))
        for (const t of sent) outcomes.push(outcome(t, http(request(t)), okMessage(t)))
        return { outcomes, calls: sent.length }
    }
}

/** Meraki Dashboard: POST /organizations/{org}/inventory/claim { serials } (10 calls per 5 minutes). */
const merakiClaim: ClaimAdapter = (targets, http, maxCalls) => {
    const { usable, outcomes } = unusable(targets, 'serial')
    const sent = batches(usable, MERAKI_CLAIM_BATCH).slice(0, Math.max(0, maxCalls))
    for (const batch of sent) {
        const response = http({ fn: REST_MESSAGE.meraki.fn.claimInventory, params: { org_id: batch[0].account }, body: JSON.stringify({ serials: batch.map((t) => t.serial) }) })
        if (!isSuccess(response.status)) {
            outcomes.push(...fail(batch, errorText(response.status, response.body)))
            continue
        }
        // Only a missing serials field is unknown (counted as done); an explicit [] means nothing was claimed.
        const returned = field(parseJson(response.body), 'serials')
        const claimed = new Set(asArray(returned).map((s) => normalizeSerial(text(s))))
        for (const t of batch) {
            const done = !Array.isArray(returned) || claimed.has(normalizeSerial(t.serial))
            outcomes.push({ stepId: t.stepId, ok: done, message: done ? `claimed into Meraki org ${t.account}` : 'not in the claimed serials' })
        }
    }
    return { outcomes, calls: sent.length }
}

/** A Mist claim code without separators, upper case (inventory `magic` values carry no dashes). */
function claimCodeKey(code: unknown): string {
    return text(code).replace(/[^A-Z0-9]/gi, '').toUpperCase()
}

/**
 * HPE Mist: POST /orgs/{org}/inventory [claim codes]; already-claimed (duplicated) codes count as done.
 * A 400 carries the same per-code result (added, duplicated, error, reason) when no code was valid.
 */
const mistClaim: ClaimAdapter = (targets, http, maxCalls) => {
    const { usable, outcomes } = unusable(targets, 'claimCode')
    const sent = batches(usable, MIST_CLAIM_BATCH).slice(0, Math.max(0, maxCalls))
    for (const batch of sent) {
        const response = http({ fn: REST_MESSAGE.mist.fn.claimInventory, params: { org_id: batch[0].account }, body: JSON.stringify(batch.map((t) => t.claimCode)) })
        const json = parseJson(response.body)
        const hasResult = ['added', 'duplicated', 'error'].some((k) => Array.isArray(field(json, k)))
        if (!isSuccess(response.status) && !(response.status === 400 && hasResult)) {
            outcomes.push(...fail(batch, errorText(response.status, response.body)))
            continue
        }
        const accepted = new Set([...asArray(field(json, 'added')), ...asArray(field(json, 'duplicated'))].map(claimCodeKey))
        const errors = asArray(field(json, 'error')).map(claimCodeKey)
        const reasons = asArray(field(json, 'reason')).map(text)
        for (const t of batch) {
            const code = claimCodeKey(t.claimCode)
            const index = errors.indexOf(code)
            // reason[] is not documented as parallel to error[]: pair them only when the lengths agree.
            const reason = index < 0 ? '' : reasons.length === errors.length ? reasons[index] : reasons.join('; ')
            if (accepted.has(code)) outcomes.push({ stepId: t.stepId, ok: true, message: `claimed into Mist org ${t.account}` })
            else outcomes.push({ stepId: t.stepId, ok: false, message: reason || 'claim code not accepted' })
        }
    }
    return { outcomes, calls: sent.length }
}

/** HPE GreenLake: POST /devices/v1/devices { network: [{ serialNumber, macAddress }], compute: [], storage: [] } into the Provider's workspace (202), five devices per call. */
const greenLakeAdd: ClaimAdapter = (targets, http, maxCalls) => {
    const { usable, outcomes } = unusable(targets, 'mac', false)
    const sent = batches(usable, GREENLAKE_ADD_BATCH).slice(0, Math.max(0, maxCalls))
    for (const batch of sent) {
        const body = JSON.stringify({ network: batch.map((t) => ({ serialNumber: t.serial, macAddress: t.mac })), compute: [], storage: [] })
        const response = http({ fn: REST_MESSAGE.greenLake.fn.addDevices, params: {}, body })
        outcomes.push(...batch.map((t) => outcome(t, response, 'added to the GreenLake workspace')))
    }
    return { outcomes, calls: sent.length }
}

/**
 * HPE GreenLake: find the device by serial, then PATCH its subscription (GREENLAKE_SUBSCRIBE_CALLS = these two calls).
 * The PATCH is asynchronous (202), so a device found already carrying the subscription id is done without a PATCH:
 * a re-run confirms the assignment.
 */
const greenLakeSubscribe: ClaimAdapter = (targets, http, maxCalls) => {
    const { usable, outcomes } = unusable(targets, 'serial')
    let calls = 0
    for (const t of usable) {
        if (calls + GREENLAKE_SUBSCRIBE_CALLS > maxCalls) break
        calls++
        const found = http({ fn: REST_MESSAGE.greenLake.fn.findDevice, params: { serial: t.serial } })
        const device = isSuccess(found.status) ? asArray(field(parseJson(found.body), 'items'))[0] : undefined
        const deviceId = text(field(device, 'id'))
        if (!deviceId) {
            outcomes.push({ stepId: t.stepId, ok: false, message: isSuccess(found.status) ? 'device not in the GreenLake workspace yet' : errorText(found.status, found.body) })
            continue
        }
        if (asArray(field(device, 'subscription')).some((s) => text(field(s, 'id')).toLowerCase() === t.account.toLowerCase())) {
            outcomes.push({ stepId: t.stepId, ok: true, message: `subscription ${t.account} assigned` })
            continue
        }
        calls++
        const assigned = http({ fn: REST_MESSAGE.greenLake.fn.assignSubscription, params: { device_id: deviceId }, body: JSON.stringify({ subscription: [{ id: t.account }] }) })
        outcomes.push(outcome(t, assigned, `subscription ${t.account} assigned`))
    }
    return { outcomes, calls }
}

/** FortiCloud Asset Management: POST products/register { registrationUnits } (status 0 = registered). */
const fortiRegister: ClaimAdapter = (targets, http, maxCalls) => {
    // Registration goes to the Provider's own FortiCloud account: no per-customer account needed.
    const { usable, outcomes } = unusable(targets, 'serial', false)
    const sent = chunks(usable, FORTICLOUD_REGISTER_BATCH).slice(0, Math.max(0, maxCalls))
    for (const batch of sent) {
        const body = JSON.stringify({ registrationUnits: batch.map((t) => ({ serialNumber: t.serial, description: 'NaaS staging', isGovernment: false })) })
        const response = http({ fn: REST_MESSAGE.fortiCare.fn.registerProducts, params: {}, body })
        const json = parseJson(response.body)
        const error = isSuccess(response.status) ? fortiCloudError(json) : errorText(response.status, response.body)
        if (error === null) outcomes.push(...batch.map((t) => ({ stepId: t.stepId, ok: true, message: 'registered in FortiCloud' })))
        else outcomes.push(...fail(batch, error))
    }
    return { outcomes, calls: sent.length }
}

/** FortiZTP: PUT devices/{serial} provisioned to the customer's FortiManager. */
const fortiZtp = perDevice(
    (t) => ({
        fn: REST_MESSAGE.fortiZtp.fn.provisionDevice,
        params: { serial: t.serial },
        body: JSON.stringify({ deviceType: 'FortiGate', provisionStatus: 'provisioned', provisionTarget: 'FortiManager', fortiManagerOid: t.account }),
    }),
    (t) => `provisioned to FortiManager ${t.account}`,
)

/** A Zero Touch cloud account "<User Center account id>/<template id>" as numbers; undefined when it is not. */
function zeroTouchAccount(account: string): { accountId: number; templateId: number } | undefined {
    const parts = account.split('/').map((p) => p.trim())
    return parts.length === 2 && parts.every((p) => /^\d+$/.test(p)) ? { accountId: Number(parts[0]), templateId: Number(parts[1]) } : undefined
}

/**
 * Check Point Zero Touch web API v2, one session per run: login (API client id and key) returns a sid sent
 * in the X-chkp-sid header; then claim-gateway { object-name: serial, account-id, template-id, mac } per
 * gateway; then logout. Login and logout count against the budget, so a run needs at least three calls.
 */
const checkPointZeroTouch: ClaimAdapter = (targets, http, maxCalls) => {
    const { usable, outcomes } = unusable(targets, 'mac')
    const claims: Array<{ target: ClaimTarget; accountId: number; templateId: number }> = []
    for (const t of usable) {
        const account = zeroTouchAccount(t.account)
        if (account) claims.push({ target: t, ...account })
        else outcomes.push({ stepId: t.stepId, ok: false, message: 'cloud account must be "<User Center account id>/<template id>"' })
    }
    const reachable = claims.slice(0, Math.max(0, maxCalls - ZERO_TOUCH_SESSION_CALLS))
    if (reachable.length === 0) return { outcomes, calls: 0 }
    const login = http({ fn: REST_MESSAGE.checkPoint.fn.login, params: {} })
    const sid = isSuccess(login.status) ? text(field(parseJson(login.body), 'sid')) : ''
    if (!sid) {
        const reason = isSuccess(login.status) ? 'no session id returned' : errorText(login.status, login.body)
        outcomes.push(...fail(reachable.map((c) => c.target), `Zero Touch login failed: ${reason}`))
        return { outcomes, calls: 1 }
    }
    const headers = { 'X-chkp-sid': sid }
    for (const { target, accountId, templateId } of reachable) {
        const body = JSON.stringify({ 'object-name': target.serial, 'account-id': accountId, 'template-id': templateId, mac: target.mac })
        outcomes.push(outcome(target, http({ fn: REST_MESSAGE.checkPoint.fn.claimGateway, params: {}, headers, body }), `claimed with Zero Touch template ${templateId}`))
    }
    http({ fn: REST_MESSAGE.checkPoint.fn.logout, params: {}, headers })
    return { outcomes, calls: reachable.length + ZERO_TOUCH_SESSION_CALLS }
}

/** Which vendor can do which step, through which REST message. Cisco PnP has no public API. */
export const CLAIM_ROUTES: Partial<Record<OemVendor, Partial<Record<ClaimAction, ClaimRoute>>>> = {
    meraki: { oem_claim: { message: REST_MESSAGE.meraki.name, run: merakiClaim, perCall: MERAKI_CLAIM_BATCH } },
    mist: { oem_claim: { message: REST_MESSAGE.mist.name, run: mistClaim, perCall: MIST_CLAIM_BATCH } },
    aruba: {
        oem_claim: { message: REST_MESSAGE.greenLake.name, run: greenLakeAdd, perCall: GREENLAKE_ADD_BATCH },
        oem_licence: { message: REST_MESSAGE.greenLake.name, run: greenLakeSubscribe, perCall: 1 / GREENLAKE_SUBSCRIBE_CALLS },
    },
    fortinet: {
        oem_claim: { message: REST_MESSAGE.fortiCare.name, run: fortiRegister, perCall: FORTICLOUD_REGISTER_BATCH },
        oem_ztp: { message: REST_MESSAGE.fortiZtp.name, run: fortiZtp, perCall: 1 },
    },
    checkpoint: { oem_ztp: { message: REST_MESSAGE.checkPoint.name, run: checkPointZeroTouch, perCall: 1 } },
}

/** Vendors with at least one automated step (Cisco has none). */
export const CLAIM_VENDORS: readonly OemVendor[] = Object.keys(CLAIM_ROUTES) as OemVendor[]

/** Licensing and zero-touch need the device claimed first: on a staging task that also has a claim step, their step waits for it (initialAutomationStatus). */
export const CLAIM_PREREQUISITE: Partial<Record<ClaimAction, ClaimAction>> = { oem_licence: 'oem_claim', oem_ztp: 'oem_claim' }

/** The actions whose steps wait on an `action` step (CLAIM_PREREQUISITE). */
export function dependentActions(action: string): ClaimAction[] {
    return CLAIM_ORDER.filter((dependent) => CLAIM_PREREQUISITE[dependent] === action)
}

/**
 * The automation status of a step (x_daas_ham_staging_step.automation_status) by what it means to the claim run. A
 * step starts due, or waiting when its prerequisite step is on the task too (initialAutomationStatus); a waiting one is
 * released to due when that step is ticked; a run settles a due step done or failed (settledStatus); a failed one is
 * due again RETRY_AFTER_MINUTES later, until it has failed MAX_CLAIM_ATTEMPTS times (dueStepsQuery).
 */
export const STEP_STATUS = {
    /** To send at the next run. */
    due: 'pending',
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
    return prerequisite && taskActions.includes(prerequisite) ? STEP_STATUS.waiting : STEP_STATUS.due
}

/** The automation status a run's outcome leaves its step in. */
export function settledStatus(outcome: ClaimOutcome): Extract<AutomationStatus, 'done' | 'failed'> {
    return outcome.ok ? STEP_STATUS.done : STEP_STATUS.failed
}

/** Steps loaded per action and run at most. */
const MAX_STEPS_PER_LOAD = 200

/** Attempts after which a failing step is left for a person. */
const MAX_CLAIM_ATTEMPTS = 5

/** How long a failed step waits before a run sends it again. */
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
     * Record the outcomes of one action's run (each step at most once), each in its settledStatus: ok ticks the step
     * (done=true); otherwise it has failed one more attempt. Messages are at most AUTOMATION_MESSAGE_LENGTH long.
     */
    settle(outcomes: readonly ClaimOutcome[]): void
}

/** Steps `remaining` calls of `route` can carry: at least one, at most MAX_STEPS_PER_LOAD. */
function stepsFor(route: ClaimRoute, remaining: number): number {
    return Math.min(MAX_STEPS_PER_LOAD, Math.max(1, Math.ceil(remaining * route.perCall)))
}

/**
 * One vendor's 5-minute run. Its actions run in the fixed order oem_claim, oem_licence, oem_ztp and share maxCalls.
 * An action is loaded only while calls remain, with limit = min(200, max(1, ceil(remaining x perCall))).
 * The outcomes the adapter returns (attempted or refused steps) are settled together, once per action; loaded
 * steps the budget did not reach are not settled and wait for the next run. Returns the calls made (<= maxCalls).
 */
export function runVendorClaims(vendor: OemVendor, store: ClaimStore, transport: (message: string) => HttpPort, maxCalls: number): number {
    const routes = CLAIM_ROUTES[vendor] ?? {}
    let calls = 0
    for (const action of CLAIM_ORDER) {
        const route = routes[action]
        if (!route) continue
        const remaining = maxCalls - calls
        if (remaining <= 0) break
        const targets = store.due(vendor, action, stepsFor(route, remaining))
        if (targets.length === 0) continue
        const run = route.run(targets, transport(route.message), remaining)
        calls += run.calls
        store.settle(run.outcomes.map((outcome) => ({ ...outcome, message: outcome.message.slice(0, AUTOMATION_MESSAGE_LENGTH) })))
    }
    return calls
}

/**
 * Encoded query on x_daas_ham_staging_step: open automated `action` steps on `vendor` fleet assets (ADR 0016) whose
 * staging task is active. Only a fleet asset's serial is sent to an OEM cloud.
 */
function openStepsQuery(vendor: OemVendor, action: ClaimAction): string {
    const asset = 'staging_task.asset.'
    return `automation=${action}^done=false^staging_task.active=true^${asset}model.x_daas_ham_oem_source=${vendor}^${fleetCondition(asset)}`
}

/**
 * Encoded query on x_daas_ham_staging_step: open `action` steps (openStepsQuery) that are due, or failed over
 * RETRY_AFTER_MINUTES ago with fewer than MAX_CLAIM_ATTEMPTS attempts (so never waiting ones); those conditions are in
 * every OR group (andEachClause).
 */
export function dueStepsQuery(vendor: OemVendor, action: ClaimAction): string {
    const retry = `attempts<${MAX_CLAIM_ATTEMPTS}^sys_updated_on<javascript:gs.minutesAgoStart(${RETRY_AFTER_MINUTES})`
    return andEachClause(
        `automation_status=${STEP_STATUS.due}^NQautomation_status=${STEP_STATUS.failed}^${retry}`,
        openStepsQuery(vendor, action),
    )
}
