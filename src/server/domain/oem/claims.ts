import type { HttpPort } from '../http'
import { asArray, field, parseJson, text } from '../json'
import type { OemVendor } from './types'

/**
 * OEM claim and provisioning (P3.27, D70): staging checklist steps that the manufacturer's cloud can
 * do for us. Each adapter takes a batch of steps, makes at most `maxCalls` calls and reports an
 * outcome for every step it attempted; steps left out wait for the next run (rate limits).
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

interface Route {
    /** Name of the REST message that serves the calls. */
    message: string
    run: ClaimAdapter
}

const ok2xx = (status: number) => status >= 200 && status < 300

function errorText(status: number, body: string): string {
    const json = parseJson(body)
    const detail =
        text(asArray(field(json, 'errors'))[0]) ||
        text(field(asArray(field(json, 'errors'))[0], 'message')) ||
        text(field(json, 'message')) ||
        text(field(json, 'detail'))
    return `HTTP ${status}${detail ? `: ${detail}` : ''}`
}

/** Group targets by account, then cut each group into chunks of `size`. */
function batches(targets: readonly ClaimTarget[], size: number): ClaimTarget[][] {
    const byAccount = new Map<string, ClaimTarget[]>()
    for (const target of targets) byAccount.set(target.account, [...(byAccount.get(target.account) ?? []), target])
    const chunks: ClaimTarget[][] = []
    for (const group of byAccount.values()) for (let i = 0; i < group.length; i += size) chunks.push(group.slice(i, i + size))
    return chunks
}

function fail(targets: readonly ClaimTarget[], message: string): ClaimOutcome[] {
    return targets.map((t) => ({ stepId: t.stepId, ok: false, message }))
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

/** Meraki Dashboard: POST /organizations/{org}/inventory/claim { serials } (10 calls per 5 minutes). */
const merakiClaim: ClaimAdapter = (targets, http, maxCalls) => {
    const { usable, outcomes } = unusable(targets, 'serial')
    let calls = 0
    for (const batch of batches(usable, 50)) {
        if (calls >= maxCalls) break
        calls++
        const response = http({ fn: 'claim_inventory', params: { org_id: batch[0].account }, body: JSON.stringify({ serials: batch.map((t) => t.serial) }) })
        if (!ok2xx(response.status)) {
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
    for (const batch of batches(usable, 100)) {
        if (calls >= maxCalls) break
        calls++
        const response = http({ fn: 'claim_inventory', params: { org_id: batch[0].account }, body: JSON.stringify(batch.map((t) => t.claimCode)) })
        if (!ok2xx(response.status)) {
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
    for (const batch of batches(usable, 25)) {
        if (calls >= maxCalls) break
        calls++
        const body = JSON.stringify({ network: batch.map((t) => ({ serialNumber: t.serial, macAddress: t.mac })) })
        const response = http({ fn: 'add_devices', params: {}, body })
        if (ok2xx(response.status)) outcomes.push(...batch.map((t) => ({ stepId: t.stepId, ok: true, message: 'added to the GreenLake workspace' })))
        else outcomes.push(...fail(batch, errorText(response.status, response.body)))
    }
    return { outcomes, calls }
}

/** HPE GreenLake: find the device by serial, then PATCH its subscription (two calls per device). */
const greenLakeSubscribe: ClaimAdapter = (targets, http, maxCalls) => {
    const { usable, outcomes } = unusable(targets, 'serial')
    let calls = 0
    for (const t of usable) {
        if (calls + 2 > maxCalls) break
        calls++
        const found = http({ fn: 'find_device', params: { serial: t.serial } })
        const deviceId = ok2xx(found.status) ? text(field(asArray(field(parseJson(found.body), 'items'))[0], 'id')) : ''
        if (!deviceId) {
            outcomes.push({ stepId: t.stepId, ok: false, message: ok2xx(found.status) ? 'device not in the GreenLake workspace yet' : errorText(found.status, found.body) })
            continue
        }
        calls++
        const assigned = http({ fn: 'assign_subscription', params: { device_id: deviceId }, body: JSON.stringify({ subscription: [{ id: t.account }] }) })
        outcomes.push(
            ok2xx(assigned.status)
                ? { stepId: t.stepId, ok: true, message: `subscription ${t.account} assigned` }
                : { stepId: t.stepId, ok: false, message: errorText(assigned.status, assigned.body) },
        )
    }
    return { outcomes, calls }
}

/** FortiCloud Asset Management: POST products/register { registrationUnits } (status 0 = registered). */
const fortiRegister: ClaimAdapter = (targets, http, maxCalls) => {
    // Registration goes to the Provider's own FortiCloud account: no per-customer account needed.
    const { usable, outcomes } = unusable(targets, 'serial', false)
    let calls = 0
    for (let i = 0; i < usable.length; i += 10) {
        if (calls >= maxCalls) break
        calls++
        const batch = usable.slice(i, i + 10)
        const body = JSON.stringify({ registrationUnits: batch.map((t) => ({ serialNumber: t.serial, description: 'NaaS staging', isGovernment: false })) })
        const response = http({ fn: 'register_products', params: {}, body })
        const json = parseJson(response.body)
        if (ok2xx(response.status) && Number(field(json, 'status') ?? 0) === 0) {
            outcomes.push(...batch.map((t) => ({ stepId: t.stepId, ok: true, message: 'registered in FortiCloud' })))
        } else {
            outcomes.push(...fail(batch, text(field(json, 'message')) || errorText(response.status, response.body)))
        }
    }
    return { outcomes, calls }
}

/** FortiZTP: PUT devices/{serial} provisioned to the customer's FortiManager. */
const fortiZtp: ClaimAdapter = (targets, http, maxCalls) => {
    const { usable, outcomes } = unusable(targets, 'serial')
    let calls = 0
    for (const t of usable) {
        if (calls >= maxCalls) break
        calls++
        const body = JSON.stringify({ deviceType: 'FortiGate', provisionStatus: 'provisioned', provisionTarget: 'FortiManager', fortiManagerOid: t.account })
        const response = http({ fn: 'provision_device', params: { serial: t.serial }, body })
        outcomes.push(
            ok2xx(response.status)
                ? { stepId: t.stepId, ok: true, message: `provisioned to FortiManager ${t.account}` }
                : { stepId: t.stepId, ok: false, message: errorText(response.status, response.body) },
        )
    }
    return { outcomes, calls }
}

/** Check Point Zero Touch: assign a gateway to its customer template. */
const checkPointZeroTouch: ClaimAdapter = (targets, http, maxCalls) => {
    const { usable, outcomes } = unusable(targets, 'serial')
    let calls = 0
    for (const t of usable) {
        if (calls >= maxCalls) break
        calls++
        const response = http({ fn: 'assign_gateway', params: {}, body: JSON.stringify({ serialNumber: t.serial, template: t.account }) })
        outcomes.push(
            ok2xx(response.status)
                ? { stepId: t.stepId, ok: true, message: `assigned to Zero Touch template ${t.account}` }
                : { stepId: t.stepId, ok: false, message: errorText(response.status, response.body) },
        )
    }
    return { outcomes, calls }
}

/** Which vendor can do which step, through which REST message. Cisco PnP has no public API. */
export const CLAIM_ROUTES: Partial<Record<OemVendor, Partial<Record<ClaimAction, Route>>>> = {
    meraki: { oem_claim: { message: 'NaaS Meraki Dashboard', run: merakiClaim } },
    mist: { oem_claim: { message: 'NaaS HPE Mist', run: mistClaim } },
    aruba: {
        oem_claim: { message: 'NaaS HPE GreenLake', run: greenLakeAdd },
        oem_licence: { message: 'NaaS HPE GreenLake', run: greenLakeSubscribe },
    },
    fortinet: {
        oem_claim: { message: 'NaaS FortiCare', run: fortiRegister },
        oem_ztp: { message: 'NaaS FortiZTP', run: fortiZtp },
    },
    checkpoint: { oem_ztp: { message: 'NaaS Check Point Zero Touch', run: checkPointZeroTouch } },
}

/** Attempts after which a failing step is left for a person. */
export const MAX_CLAIM_ATTEMPTS = 5
