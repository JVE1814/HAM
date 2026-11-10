import { addMonths } from './calendar.ts'
import { fleetStagesQuery } from './fleet.ts'
import type { Stage } from './lifecycle.ts'
import { normalizeSerial } from './serials.ts'
import { INSTALL_STATUS, TASK_STATE, type AuditLineResult } from './vocabulary.ts'

/** Audits (blind counts, site audits) and Attestations (P2.7, D63). */

/** The task states an audit takes: in progress from the moment it is started, closed once its scans are compared. */
export const AUDIT_STATE = { inProgress: TASK_STATE.workInProgress, closed: TASK_STATE.closedComplete } as const

/** The task states an attestation takes: pending while its Assets are listed, open to answer, closed once attested. */
export const ATTESTATION_STATE = { pending: TASK_STATE.pending, open: TASK_STATE.open, closed: TASK_STATE.closedComplete } as const

/**
 * The stages of the units on a stockroom's shelves, which its blind count expects there. A unit in transfer is one of
 * them until its transfer order line is In Transit: from Draft to Shipment Preparation Inventory keeps it In stock
 * (Pending transfer) in the stockroom it is sent from, and sets the stockroom it is sent to only once the line is
 * received (ADR 0002, external-contracts N38), so the Asset's stockroom says which shelf it is on. At In Transit it is
 * In transit by install status, on its way and on no shelf, so `onTheShelfQuery` keeps to units In stock by install
 * status, which every other stage here is too.
 */
const ON_THE_SHELF: readonly Stage[] = [
    'available',
    'reserved',
    'spare_pool',
    'staging',
    'staged',
    'pending_evaluation',
    'pending_wipe',
    'pending_disposal',
    'in_transfer',
]

/** Encoded alm_hardware query: the fleet assets on the shelves of the stockroom, In stock by install status, in one of the ON_THE_SHELF stages. */
export function onTheShelfQuery(stockroomId: string): string {
    return fleetStagesQuery(ON_THE_SHELF, `stockroom=${stockroomId}^install_status=${INSTALL_STATUS.inStock}`)
}

export interface ExpectedAsset {
    assetId: string
    serial: string
    providerTag: string
    customerTag: string
}

export interface AuditComparison {
    matched: string[]
    missing: string[]
    unexpected: string[]
}

/** The identifier fields of an expected Asset, in the order a scan is matched against them (domain/asset-identifier). */
const FIELDS = ['serial', 'providerTag', 'customerTag'] as const

/**
 * What was found, what is missing and which scans match nothing expected. A scan names the expected Asset whose serial
 * it is, else whose Provider tag, else whose Customer tag, as everywhere else a code is resolved (domain/asset-identifier):
 * a Customer tag never takes a scan from another unit's serial. A code that two expected Assets carry in the same field
 * names neither and is listed as unexpected, for a person to resolve, rather than marking one of them found by row order.
 */
export function compareAudit(expected: readonly ExpectedAsset[], scans: readonly string[]): AuditComparison {
    const byField = FIELDS.map((field) => {
        const index = new Map<string, string[]>()
        for (const asset of expected) {
            const code = asset[field] ? normalizeSerial(asset[field]) : ''
            if (code) index.set(code, [...(index.get(code) ?? []), asset.assetId])
        }
        return index
    })
    const named = (scan: string): string | undefined => {
        for (const index of byField) {
            const ids = index.get(normalizeSerial(scan))
            if (ids) return ids.length === 1 ? ids[0] : undefined
        }
        return undefined
    }
    const found = new Set<string>()
    const unexpected: string[] = []
    for (const scan of scans) {
        const assetId = named(scan)
        if (assetId) found.add(assetId)
        else unexpected.push(scan.trim())
    }
    return {
        matched: expected.filter((a) => found.has(a.assetId)).map((a) => a.assetId),
        missing: expected.filter((a) => !found.has(a.assetId)).map((a) => a.assetId),
        unexpected,
    }
}

/**
 * The result a line takes when its audit is closed: a line of the expected list is found or missing, and a scan that
 * matched nothing expected is unexpected. Null for a scan that matched, which keeps the result it was recorded with.
 */
export function closedLineResult(line: { assetId: string; scannedCode: string }, comparison: AuditComparison): AuditLineResult | null {
    if (!line.scannedCode) return comparison.missing.includes(line.assetId) ? 'missing' : 'found'
    return comparison.unexpected.includes(line.scannedCode) ? 'unexpected' : null
}

export function attestationDue(input: { lastAttestedOn?: string; intervalMonths: number; today: string }): boolean {
    if (input.intervalMonths <= 0) return false
    if (!input.lastAttestedOn) return true
    return addMonths(input.lastAttestedOn, input.intervalMonths) <= input.today
}
