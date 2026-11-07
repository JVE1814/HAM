/** Reconciliation exceptions between installed Assets and monitoring (P2.7). */

export type ExceptionType = 'unseen' | 'serial_mismatch' | 'location_mismatch' | 'seen_without_asset' | 'audit_missing' | 'attested_missing'

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
