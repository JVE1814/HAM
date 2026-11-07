import { andEachClause } from '../encoded-query'
import { errorText, isSuccess, type HttpPort, type HttpRequest, type HttpResponse } from '../http'
import { asArray, chunks, field, parseJson, text } from '../json'
import type { OemVendor } from './types'

/**
 * OEM claim and provisioning (P3.27, D70): staging checklist steps that the manufacturer's cloud can
 * do for us. Each adapter takes a batch of steps, makes at most `maxCalls` calls and reports an
 * outcome for every step it attempted; steps left out wait for the next run (rate limits).
 * runVendorClaims runs one vendor's adapters within its call budget against a ClaimStore.
 */

export type ClaimAction = 'oem_claim' | 'oem_licence' | 'oem_ztp'

export interface ClaimTarget {
    stepId: string
    serial: string
    mac: string
    claimCode: string
    /** The Customer's cloud account the device goes to (org, subscription, FortiManager, template); '' where the call needs none. */
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
/** Devices per GreenLake add call. */
const GREENLAKE_ADD_BATCH = 25
/** GreenLake subscription assignment: find the device, then PATCH it. */
const GREENLAKE_SUBSCRIBE_CALLS = 2
/** Registration units per FortiCloud register call. */
const FORTICLOUD_REGISTER_BATCH = 10

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
        let calls = 0
        for (const t of usable) {
            if (calls >= maxCalls) break
            calls++
            outcomes.push(outcome(t, http(request(t)), okMessage(t)))
        }
        return { outcomes, calls }
    }
}

/** Meraki Dashboard: POST /organizations/{org}/inventory/claim { serials } (10 calls per 5 minutes). */
const merakiClaim: ClaimAdapter = (targets, http, maxCalls) => {
    const { usable, outcomes } = unusable(targets, 'serial')
    let calls = 0
    for (const batch of batches(usable, MERAKI_CLAIM_BATCH)) {
        if (calls >= maxCalls) break
        calls++
        const response = http({ fn: 'claim_inventory', params: { org_id: batch[0].account }, body: JSON.stringify({ serials: batch.map((t) => t.serial) }) })
        if (!isSuccess(response.status)) {
            outcomes.push(...fail(batch, errorText(response.status, response.body)))
            continue
        }
        const claimed = new Set(asArray(field(parseJson(response.body), 'serials')).map((s) => text(s).toUpperCase()))
        for (const t of batch) {
            const done = claimed.size === 0 || claimed.has(t.serial.toUpperCase())
            outcomes.push({ stepId: t.stepId, ok: done, message: done ? `claimed into Meraki org ${t.account}` : 'not in the claimed serials' })
        }
    }
    return { outcomes, calls }
}

/** HPE Mist: POST /orgs/{org}/inventory [claim codes]; already-claimed (duplicated) codes count as done. */
const mistClaim: ClaimAdapter = (targets, http, maxCalls) => {
    const { usable, outcomes } = unusable(targets, 'claimCode')
    let calls = 0
    for (const batch of batches(usable, MIST_CLAIM_BATCH)) {
        if (calls >= maxCalls) break
        calls++
        const response = http({ fn: 'claim_inventory', params: { org_id: batch[0].account }, body: JSON.stringify(batch.map((t) => t.claimCode)) })
        if (!isSuccess(response.status)) {
            outcomes.push(...fail(batch, errorText(response.status, response.body)))
            continue
        }
        const json = parseJson(response.body)
        const accepted = new Set([...asArray(field(json, 'added')), ...asArray(field(json, 'duplicated'))].map((c) => text(c).toUpperCase()))
        const errors = asArray(field(json, 'error')).map((c) => text(c).toUpperCase())
        const reasons = asArray(field(json, 'reason')).map(text)
        for (const t of batch) {
            const code = t.claimCode.toUpperCase()
            if (accepted.has(code)) outcomes.push({ stepId: t.stepId, ok: true, message: `claimed into Mist org ${t.account}` })
            else outcomes.push({ stepId: t.stepId, ok: false, message: reasons[errors.indexOf(code)] || 'claim code not accepted' })
        }
    }
    return { outcomes, calls }
}

/** HPE GreenLake: POST /devices/v1/devices { network: [{ serialNumber, macAddress }] } into the Provider's workspace (202). */
const greenLakeAdd: ClaimAdapter = (targets, http, maxCalls) => {
    const { usable, outcomes } = unusable(targets, 'mac', false)
    let calls = 0
    for (const batch of batches(usable, GREENLAKE_ADD_BATCH)) {
        if (calls >= maxCalls) break
        calls++
        const body = JSON.stringify({ network: batch.map((t) => ({ serialNumber: t.serial, macAddress: t.mac })) })
        const response = http({ fn: 'add_devices', params: {}, body })
        outcomes.push(...batch.map((t) => outcome(t, response, 'added to the GreenLake workspace')))
    }
    return { outcomes, calls }
}

/** HPE GreenLake: find the device by serial, then PATCH its subscription (GREENLAKE_SUBSCRIBE_CALLS = these two calls). */
const greenLakeSubscribe: ClaimAdapter = (targets, http, maxCalls) => {
    const { usable, outcomes } = unusable(targets, 'serial')
    let calls = 0
    for (const t of usable) {
        if (calls + GREENLAKE_SUBSCRIBE_CALLS > maxCalls) break
        calls++
        const found = http({ fn: 'find_device', params: { serial: t.serial } })
        const deviceId = isSuccess(found.status) ? text(field(asArray(field(parseJson(found.body), 'items'))[0], 'id')) : ''
        if (!deviceId) {
            outcomes.push({ stepId: t.stepId, ok: false, message: isSuccess(found.status) ? 'device not in the GreenLake workspace yet' : errorText(found.status, found.body) })
            continue
        }
        calls++
        const assigned = http({ fn: 'assign_subscription', params: { device_id: deviceId }, body: JSON.stringify({ subscription: [{ id: t.account }] }) })
        outcomes.push(outcome(t, assigned, `subscription ${t.account} assigned`))
    }
    return { outcomes, calls }
}

/** FortiCloud Asset Management: POST products/register { registrationUnits } (status 0 = registered). */
const fortiRegister: ClaimAdapter = (targets, http, maxCalls) => {
    // Registration goes to the Provider's own FortiCloud account: no per-customer account needed.
    const { usable, outcomes } = unusable(targets, 'serial', false)
    let calls = 0
    for (const batch of chunks(usable, FORTICLOUD_REGISTER_BATCH)) {
        if (calls >= maxCalls) break
        calls++
        const body = JSON.stringify({ registrationUnits: batch.map((t) => ({ serialNumber: t.serial, description: 'NaaS staging', isGovernment: false })) })
        const response = http({ fn: 'register_products', params: {}, body })
        const json = parseJson(response.body)
        if (isSuccess(response.status) && Number(field(json, 'status') ?? 0) === 0) {
            outcomes.push(...batch.map((t) => ({ stepId: t.stepId, ok: true, message: 'registered in FortiCloud' })))
        } else {
            outcomes.push(...fail(batch, text(field(json, 'message')) || errorText(response.status, response.body)))
        }
    }
    return { outcomes, calls }
}

/** FortiZTP: PUT devices/{serial} provisioned to the customer's FortiManager. */
const fortiZtp = perDevice(
    (t) => ({
        fn: 'provision_device',
        params: { serial: t.serial },
        body: JSON.stringify({ deviceType: 'FortiGate', provisionStatus: 'provisioned', provisionTarget: 'FortiManager', fortiManagerOid: t.account }),
    }),
    (t) => `provisioned to FortiManager ${t.account}`,
)

/** Check Point Zero Touch: assign a gateway to its customer template. */
const checkPointZeroTouch = perDevice(
    (t) => ({ fn: 'assign_gateway', params: {}, body: JSON.stringify({ serialNumber: t.serial, template: t.account }) }),
    (t) => `assigned to Zero Touch template ${t.account}`,
)

/** Which vendor can do which step, through which REST message. Cisco PnP has no public API. */
export const CLAIM_ROUTES: Partial<Record<OemVendor, Partial<Record<ClaimAction, ClaimRoute>>>> = {
    meraki: { oem_claim: { message: 'NaaS Meraki Dashboard', run: merakiClaim, perCall: MERAKI_CLAIM_BATCH } },
    mist: { oem_claim: { message: 'NaaS HPE Mist', run: mistClaim, perCall: MIST_CLAIM_BATCH } },
    aruba: {
        oem_claim: { message: 'NaaS HPE GreenLake', run: greenLakeAdd, perCall: GREENLAKE_ADD_BATCH },
        oem_licence: { message: 'NaaS HPE GreenLake', run: greenLakeSubscribe, perCall: 1 / GREENLAKE_SUBSCRIBE_CALLS },
    },
    fortinet: {
        oem_claim: { message: 'NaaS FortiCare', run: fortiRegister, perCall: FORTICLOUD_REGISTER_BATCH },
        oem_ztp: { message: 'NaaS FortiZTP', run: fortiZtp, perCall: 1 },
    },
    checkpoint: { oem_ztp: { message: 'NaaS Check Point Zero Touch', run: checkPointZeroTouch, perCall: 1 } },
}

/** Vendors with at least one automated step (Cisco has none). */
export const CLAIM_VENDORS: readonly OemVendor[] = Object.keys(CLAIM_ROUTES) as OemVendor[]

/** The order a vendor's actions run in: a device is claimed before it is licensed or provisioned (every action ranked). */
const CLAIM_RANK: Record<ClaimAction, number> = { oem_claim: 0, oem_licence: 1, oem_ztp: 2 }
const CLAIM_ORDER = (Object.keys(CLAIM_RANK) as ClaimAction[]).sort((a, b) => CLAIM_RANK[a] - CLAIM_RANK[b])

/** Steps loaded per action and run at most. */
const MAX_STEPS_PER_LOAD = 200

/** Attempts after which a failing step is left for a person. */
const MAX_CLAIM_ATTEMPTS = 5

/** Length of a staging step's automation_message. */
const MESSAGE_LENGTH = 255

/** Where a run reads its due steps and records their outcomes (the Glide store is in platform/claim-steps.ts). */
export interface ClaimStore {
    /** Up to `limit` of `vendor`'s steps due for `action` (dueStepsQuery), fewest attempts first, then oldest; each carries the Customer's OEM cloud account for `action` ('' when none). */
    due(vendor: OemVendor, action: ClaimAction, limit: number): ClaimTarget[]
    /** Record one attempted or refused step. ok: tick it (automation_status=done, done=true); otherwise automation_status=failed and one more attempt. outcome.message is at most 255 characters. */
    settle(outcome: ClaimOutcome): void
}

/** Steps `remaining` calls of `route` can carry: at least one, at most MAX_STEPS_PER_LOAD. */
function stepsFor(route: ClaimRoute, remaining: number): number {
    return Math.min(MAX_STEPS_PER_LOAD, Math.max(1, Math.ceil(remaining * route.perCall)))
}

/**
 * One vendor's 5-minute run. Its actions run in the fixed order oem_claim, oem_licence, oem_ztp and share maxCalls.
 * An action is loaded only while calls remain, with limit = min(200, max(1, ceil(remaining x perCall))).
 * Every outcome the adapter returns (attempted or refused) is settled exactly once; loaded steps the
 * budget did not reach are not settled and wait for the next run. Returns the calls made (<= maxCalls).
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
        for (const outcome of run.outcomes) store.settle({ ...outcome, message: outcome.message.slice(0, MESSAGE_LENGTH) })
    }
    return calls
}

/** Encoded query on x_daas_ham_staging_step: open automated `action` steps on `vendor` Assets (active task) that are pending, or failed over 30 minutes ago with fewer than 5 attempts; the vendor/action condition is in every OR group (andEachClause). */
export function dueStepsQuery(vendor: OemVendor, action: ClaimAction): string {
    return andEachClause(
        `automation_status=pending^NQautomation_status=failed^attempts<${MAX_CLAIM_ATTEMPTS}^sys_updated_on<javascript:gs.minutesAgoStart(30)`,
        `automation=${action}^done=false^staging_task.active=true^staging_task.asset.model.x_daas_ham_oem_source=${vendor}`,
    )
}
