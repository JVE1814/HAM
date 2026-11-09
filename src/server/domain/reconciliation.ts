import { overlaps, powerBudget, type Placement, type RackSpec } from './rack'

/** Reconciliation exceptions between installed Assets and monitoring (P2.7), and in racks (D67). */

export type ExceptionType =
    | 'unseen'
    | 'serial_mismatch'
    | 'location_mismatch'
    | 'seen_without_asset'
    | 'audit_missing'
    | 'attested_missing'
    | RackExceptionType

/** The types a rack check raises and resolves: each is the rack's, open once per rack. */
export const RACK_EXCEPTION_TYPES = ['rack_overlap', 'rack_over_power'] as const

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

/** Disagreements between an installed Asset and what monitoring reports. */
export function reconcileAsset(asset: InstalledAssetView, now: number, unseenDays: number): ExceptionType[] {
    const exceptions: ExceptionType[] = []
    if (asset.lastSeenAt === undefined || now - asset.lastSeenAt > unseenDays * 86_400_000) exceptions.push('unseen')
    if (asset.ci) {
        if (asset.ci.serial && asset.ci.serial.trim().toUpperCase() !== asset.serial.trim().toUpperCase()) exceptions.push('serial_mismatch')
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
        const detail = shared.map(({ assetIds: [a, b], face, unit }) => `${a} and ${b} share rack unit ${unit} (${face})`).join('; ')
        found.push({ type: 'rack_overlap', detail })
    }
    const budget = powerBudget(rack.powerCapacityW, placements)
    if (budget.capacityW > 0 && budget.usedW > budget.capacityW) {
        found.push({ type: 'rack_over_power', detail: `Typical power ${budget.usedW} W is over the rack's ${budget.capacityW} W` })
    }
    return found
}
