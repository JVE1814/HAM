import { normalizeSerial } from '../serials.ts'
import { chunks } from '../collections.ts'
import { failureText, isSuccess, type HttpResponse } from '../http.ts'
import { asArray, field, parseJson, text } from '../json.ts'
import { fortiCloudError } from './forticloud.ts'
import { REST_MESSAGE } from '../rest-message-names.ts'
import { LOCK_LOST, type ClaimAdapter, type ClaimOutcome, type ClaimRoute, type ClaimTarget } from './claims.ts'

/**
 * The OEM claim adapters (plan §13 OEM claim adapters, Q70), one per vendor action: each takes a batch of steps, makes
 * at most `maxCalls` calls through its REST message and reports an outcome for every step it attempted; steps left out
 * wait for the next run (rate limits).
 */

const MERAKI_CLAIM_BATCH = 50
const MIST_CLAIM_BATCH = 100
/** Devices per GreenLake add call (at most five, counting network, compute and storage devices together). */
const GREENLAKE_ADD_BATCH = 5
/** GreenLake subscription assignment: find the device, then PATCH it. */
const GREENLAKE_SUBSCRIBE_CALLS = 2
const FORTICLOUD_REGISTER_BATCH = 10
/** Check Point Zero Touch: the login and logout calls around a session's claim-gateway calls. */
const ZERO_TOUCH_SESSION_CALLS = 2

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

function outcome(target: ClaimTarget, response: HttpResponse, okMessage: string): ClaimOutcome {
    return isSuccess(response.status)
        ? { stepId: target.stepId, ok: true, message: okMessage }
        : { stepId: target.stepId, ok: false, message: failureText(response) }
}

function unusable(targets: readonly ClaimTarget[], needs: 'serial' | 'claimCode' | 'mac'): { usable: ClaimTarget[]; outcomes: ClaimOutcome[] } {
    const outcomes: ClaimOutcome[] = []
    const usable: ClaimTarget[] = []
    for (const target of targets) {
        if (!target[needs] || !target.serial) outcomes.push({ stepId: target.stepId, ok: false, message: `missing ${needs === 'claimCode' ? 'claim code' : needs}` })
        else usable.push(target)
    }
    return { usable, outcomes }
}

/** Meraki Dashboard: POST /organizations/{org}/inventory/claim { serials } (10 calls per 5 minutes). */
const merakiClaim: ClaimAdapter = (targets, http, maxCalls) => {
    const { usable, outcomes } = unusable(targets, 'serial')
    let calls = 0
    for (const batch of batches(usable, MERAKI_CLAIM_BATCH).slice(0, Math.max(0, maxCalls))) {
        const response = http({ fn: REST_MESSAGE.meraki.fn.claimInventory, params: { org_id: batch[0].account }, body: JSON.stringify({ serials: batch.map((t) => t.serial) }) })
        if (response === LOCK_LOST) break
        calls++
        if (!isSuccess(response.status)) {
            outcomes.push(...fail(batch, failureText(response)))
            continue
        }
        // A body that is not a JSON object says nothing about the claim (as FortiCloud's): the batch fails, to be tried
        // again, rather than release the licence and zero-touch steps waiting on it.
        const json = parseJson(response.body)
        if (json === null || typeof json !== 'object' || Array.isArray(json)) {
            outcomes.push(...fail(batch, `HTTP ${response.status}: the response is not a JSON object`))
            continue
        }
        // Only a missing serials field is unknown (counted as done); an explicit [] means nothing was claimed.
        const returned = field(json, 'serials')
        const claimed = new Set(asArray(returned).map((s) => normalizeSerial(text(s))))
        for (const t of batch) {
            const done = !Array.isArray(returned) || claimed.has(normalizeSerial(t.serial))
            outcomes.push({ stepId: t.stepId, ok: done, message: done ? `claimed into Meraki org ${t.account}` : 'not in the claimed serials' })
        }
    }
    return { outcomes, calls }
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
    let calls = 0
    for (const batch of batches(usable, MIST_CLAIM_BATCH).slice(0, Math.max(0, maxCalls))) {
        const response = http({ fn: REST_MESSAGE.mist.fn.claimInventory, params: { org_id: batch[0].account }, body: JSON.stringify(batch.map((t) => t.claimCode)) })
        if (response === LOCK_LOST) break
        calls++
        const json = parseJson(response.body)
        const hasResult = ['added', 'duplicated', 'error'].some((k) => Array.isArray(field(json, k)))
        if (!isSuccess(response.status) && !(response.status === 400 && hasResult)) {
            outcomes.push(...fail(batch, failureText(response)))
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
    return { outcomes, calls }
}

/** HPE GreenLake: POST /devices/v1/devices { network: [{ serialNumber, macAddress }], compute: [], storage: [] } into the Provider's workspace (202), five devices per call. */
const greenLakeAdd: ClaimAdapter = (targets, http, maxCalls) => {
    const { usable, outcomes } = unusable(targets, 'mac')
    let calls = 0
    for (const batch of batches(usable, GREENLAKE_ADD_BATCH).slice(0, Math.max(0, maxCalls))) {
        const body = JSON.stringify({ network: batch.map((t) => ({ serialNumber: t.serial, macAddress: t.mac })), compute: [], storage: [] })
        const response = http({ fn: REST_MESSAGE.greenLake.fn.addDevices, params: {}, body })
        if (response === LOCK_LOST) break
        calls++
        outcomes.push(...batch.map((t) => outcome(t, response, 'added to the GreenLake workspace')))
    }
    return { outcomes, calls }
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
        const found = http({ fn: REST_MESSAGE.greenLake.fn.findDevice, params: { serial: t.serial } })
        if (found === LOCK_LOST) break
        calls++
        const device = isSuccess(found.status) ? asArray(field(parseJson(found.body), 'items'))[0] : undefined
        const deviceId = text(field(device, 'id'))
        if (!deviceId) {
            outcomes.push({ stepId: t.stepId, ok: false, message: isSuccess(found.status) ? 'device not in the GreenLake workspace yet' : failureText(found) })
            continue
        }
        if (asArray(field(device, 'subscription')).some((s) => text(field(s, 'id')).toLowerCase() === t.account.toLowerCase())) {
            outcomes.push({ stepId: t.stepId, ok: true, message: `subscription ${t.account} assigned` })
            continue
        }
        const assigned = http({ fn: REST_MESSAGE.greenLake.fn.assignSubscription, params: { device_id: deviceId }, body: JSON.stringify({ subscription: [{ id: t.account }] }) })
        if (assigned === LOCK_LOST) break
        calls++
        outcomes.push(outcome(t, assigned, `subscription ${t.account} assigned`))
    }
    return { outcomes, calls }
}

/** FortiCloud Asset Management: POST products/register { registrationUnits } (status 0 = registered). */
const fortiRegister: ClaimAdapter = (targets, http, maxCalls) => {
    const { usable, outcomes } = unusable(targets, 'serial')
    let calls = 0
    for (const batch of chunks(usable, FORTICLOUD_REGISTER_BATCH).slice(0, Math.max(0, maxCalls))) {
        const body = JSON.stringify({ registrationUnits: batch.map((t) => ({ serialNumber: t.serial, description: 'NaaS staging', isGovernment: false })) })
        const response = http({ fn: REST_MESSAGE.fortiCare.fn.registerProducts, params: {}, body })
        if (response === LOCK_LOST) break
        calls++
        const json = parseJson(response.body)
        const error = isSuccess(response.status) ? fortiCloudError(json) : failureText(response)
        if (error === null) outcomes.push(...batch.map((t) => ({ stepId: t.stepId, ok: true, message: 'registered in FortiCloud' })))
        else outcomes.push(...fail(batch, error))
    }
    return { outcomes, calls }
}

/** FortiZTP: PUT devices/{serial} provisioned to the customer's FortiManager. */
const fortiZtp: ClaimAdapter = (targets, http, maxCalls) => {
    const { usable, outcomes } = unusable(targets, 'serial')
    let calls = 0
    for (const t of usable.slice(0, Math.max(0, maxCalls))) {
        const body = JSON.stringify({ deviceType: 'FortiGate', provisionStatus: 'provisioned', provisionTarget: 'FortiManager', fortiManagerOid: t.account })
        const response = http({ fn: REST_MESSAGE.fortiZtp.fn.provisionDevice, params: { serial: t.serial }, body })
        if (response === LOCK_LOST) break
        calls++
        outcomes.push(outcome(t, response, `provisioned to FortiManager ${t.account}`))
    }
    return { outcomes, calls }
}

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
    if (login === LOCK_LOST) return { outcomes, calls: 0 }
    const sid = isSuccess(login.status) ? text(field(parseJson(login.body), 'sid')) : ''
    if (!sid) {
        const reason = isSuccess(login.status) ? 'no session id returned' : failureText(login)
        outcomes.push(...fail(reachable.map((c) => c.target), `Zero Touch login failed: ${reason}`))
        return { outcomes, calls: 1 }
    }
    const headers = { 'X-chkp-sid': sid }
    let calls = 1
    for (const { target, accountId, templateId } of reachable) {
        const body = JSON.stringify({ 'object-name': target.serial, 'account-id': accountId, 'template-id': templateId, mac: target.mac })
        const response = http({ fn: REST_MESSAGE.checkPoint.fn.claimGateway, params: {}, headers, body })
        if (response === LOCK_LOST) break
        calls++
        outcomes.push(outcome(target, response, `claimed with Zero Touch template ${templateId}`))
    }
    if (http({ fn: REST_MESSAGE.checkPoint.fn.logout, params: {}, headers }) !== LOCK_LOST) calls++
    return { outcomes, calls }
}

export const MERAKI_CLAIM: ClaimRoute = { message: REST_MESSAGE.meraki.name, run: merakiClaim, perCall: MERAKI_CLAIM_BATCH, account: 'customer' }
export const MIST_CLAIM: ClaimRoute = { message: REST_MESSAGE.mist.name, run: mistClaim, perCall: MIST_CLAIM_BATCH, account: 'customer' }
export const GREENLAKE_ADD: ClaimRoute = { message: REST_MESSAGE.greenLake.name, run: greenLakeAdd, perCall: GREENLAKE_ADD_BATCH, account: 'provider' }
export const GREENLAKE_SUBSCRIBE: ClaimRoute = {
    message: REST_MESSAGE.greenLake.name,
    run: greenLakeSubscribe,
    perCall: 1 / GREENLAKE_SUBSCRIBE_CALLS,
    account: 'customer',
}
export const FORTICLOUD_REGISTER: ClaimRoute = { message: REST_MESSAGE.fortiCare.name, run: fortiRegister, perCall: FORTICLOUD_REGISTER_BATCH, account: 'provider' }
export const FORTIZTP_PROVISION: ClaimRoute = { message: REST_MESSAGE.fortiZtp.name, run: fortiZtp, perCall: 1, account: 'customer' }
export const ZERO_TOUCH_CLAIM: ClaimRoute = { message: REST_MESSAGE.checkPoint.name, run: checkPointZeroTouch, perCall: 1, account: 'customer' }
