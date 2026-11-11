import { anyOf } from './encoded-query.ts'
import { fleetStagesQuery, outsideFleetCondition, SITE_CONDITION } from './fleet.ts'
import { ALL_STAGES, IN_USE_STAGES } from './lifecycle.ts'
import { overlaps, powerBudget, type Placement, type RackSpec } from './rack.ts'
import { normalizeSerial } from './serials.ts'
import { EXCEPTION_STATUS, type ExceptionType } from './vocabulary.ts'

/** Reconciliation exceptions between installed Assets and monitoring (P2.7), and in racks (Q67). */

/** The types the daily comparison of an installed Asset with monitoring raises and resolves (`reconcileAsset`). */
export const MONITORING_EXCEPTION_TYPES = ['unseen', 'serial_mismatch', 'location_mismatch'] as const satisfies readonly ExceptionType[]

/** The types a rack check raises and resolves: each is the rack's, open once per rack. */
export const RACK_EXCEPTION_TYPES = ['rack_overlap', 'rack_over_power'] as const satisfies readonly ExceptionType[]

export type RackExceptionType = (typeof RACK_EXCEPTION_TYPES)[number]

export interface InstalledAssetView {
    serial: string
    siteId: string
    lastSeenAt?: number
    /**
     * The Asset's configuration item, when it has one. `locationIds` are its location and the
     * locations that contain it (room, building, site), nearest first.
     */
    ci?: { serial: string; locationIds: readonly string[] }
}

/**
 * A CI's Asset as alm_hardware, to dot-walk to its fields: a CI's `asset` references alm_asset, which has no Fleet
 * flag, and the platform ignores a condition on a field the table lacks rather than refusing it (it would match every
 * CI).
 */
const CI_HARDWARE = 'asset.ref_alm_hardware.'

/**
 * Encoded query on network-gear CIs for *seen without asset*: at a customer Site (the CI's location, or the location
 * one or two levels up, as for a location mismatch) and pointing at no fleet asset (ADR 0016): at none, or at one of
 * the Provider IT's, which an asset manager adds to the fleet. The Provider IT's own network gear elsewhere is not
 * NaaS's to report. The caller adds how recently it was discovered.
 */
export function seenWithoutFleetAssetQuery(): string {
    const atSite = ['location.', 'location.parent.', 'location.parent.parent.'].map((via) => `${via}${SITE_CONDITION}`)
    return `assetISEMPTY^OR${outsideFleetCondition(CI_HARDWARE)}^${atSite.join('^OR')}`
}

/**
 * Encoded query on network-gear CIs: those of `ciIds` that `seenWithoutFleetAssetQuery` still matches, however long
 * ago they were discovered. A *seen without asset* exception whose CI it leaves out has cleared: the CI points at a
 * fleet asset now (an asset manager added its Asset to the fleet), is no longer at a customer Site, or is gone. That
 * includes one raised before the Fleet flag on the Provider IT's own network gear, which is not NaaS's to report. Null
 * for no CI.
 */
export function stillSeenWithoutFleetAssetQuery(ciIds: readonly string[]): string | null {
    const ids = anyOf('sys_id', ciIds)
    return ids && `${ids}^${seenWithoutFleetAssetQuery()}`
}

/** The longest detail a reconciliation exception keeps: its column's length, so a longer one is cut rather than refused. */
export const EXCEPTION_DETAIL_MAX_LENGTH = 255

/** Encoded query on reconciliation exceptions: the open ones, which the navigator, the workspace and the dashboard list and count. */
export const OPEN_EXCEPTIONS_QUERY = `status=${EXCEPTION_STATUS.open}`

/**
 * Encoded query on reconciliation exceptions: the open ones of `types` on an Asset outside the fleet (ADR 0016). The
 * daily reconciliation checks fleet assets only, so it would never find these cleared: raised before the Fleet flag on
 * the Provider IT's equipment in use, they are resolved. A blank flag (a row from before the column, or an Asset since
 * deleted) counts as outside.
 */
export function outsideFleetExceptionsQuery(types: readonly ExceptionType[]): string {
    return `${OPEN_EXCEPTIONS_QUERY}^exception_typeIN${types.join(',')}^assetISNOTEMPTY^${outsideFleetCondition('asset.')}`
}

/**
 * Encoded query on reconciliation exceptions: the open ones of `types` on a fleet asset no longer in use (pending
 * return, back in a stockroom, disposed). The daily reconciliation compares the Assets in use only, so it would never
 * find these cleared: they are resolved.
 */
export function outOfUseExceptionsQuery(types: readonly ExceptionType[]): string {
    const outOfUse = ALL_STAGES.filter((stage) => !IN_USE_STAGES.includes(stage))
    return fleetStagesQuery(outOfUse, `${OPEN_EXCEPTIONS_QUERY}^exception_typeIN${types.join(',')}`, 'asset.')
}

/** Disagreements between an installed Asset and what monitoring reports. */
export function reconcileAsset(asset: InstalledAssetView, now: number, unseenDays: number): ExceptionType[] {
    const exceptions: ExceptionType[] = []
    if (asset.lastSeenAt === undefined || now - asset.lastSeenAt > unseenDays * 86_400_000) exceptions.push('unseen')
    if (asset.ci) {
        if (asset.ci.serial && normalizeSerial(asset.ci.serial) !== normalizeSerial(asset.serial)) exceptions.push('serial_mismatch')
        const located = asset.ci.locationIds.filter(Boolean)
        if (located.length > 0 && asset.siteId && !located.includes(asset.siteId)) exceptions.push('location_mismatch')
    }
    return exceptions
}

export interface RackException {
    type: RackExceptionType
    detail: string
}

/**
 * What a fresh read of every device placed in a rack finds wrong with it: devices sharing units on one face, and
 * typical power over the rack's capacity (none recorded: no budget). The before rule refuses a save that would cause
 * either, but two saves at the same moment can both pass it. A type not found here no longer applies: its open one
 * resolves.
 */
export function reconcileRack(rack: RackSpec, placements: readonly Placement[]): RackException[] {
    const found: RackException[] = []
    const shared = overlaps(placements)
    if (shared.length > 0) {
        const detail = shared.map(({ labels: [a, b], face, unit }) => `${a} and ${b} share rack unit ${unit} (${face})`).join('; ')
        found.push({ type: 'rack_overlap', detail })
    }
    const budget = powerBudget(rack.powerCapacityW, placements)
    if (budget.capacityW > 0 && budget.usedW > budget.capacityW) {
        found.push({ type: 'rack_over_power', detail: `Typical power ${budget.usedW} W is over the rack's ${budget.capacityW} W` })
    }
    return found
}
