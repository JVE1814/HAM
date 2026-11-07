/** Rack placement (P2.8): units are numbered from 1 at the bottom; a device occupies ruStart..ruStart+height-1. */

export type RackFace = 'front' | 'rear'

export interface Placement {
    assetId: string
    ruStart: number
    height: number
    face: RackFace
}

/** Why `candidate` cannot go where it is placed, or null if it fits. */
export function placementProblem(rackUnits: number, placements: readonly Placement[], candidate: Placement): string | null {
    const top = candidate.ruStart + Math.max(1, candidate.height) - 1
    if (candidate.ruStart < 1 || top > rackUnits) {
        return `Rack units ${candidate.ruStart}-${top} do not fit in a ${rackUnits}U rack`
    }
    for (const other of placements) {
        if (other.assetId === candidate.assetId || other.face !== candidate.face) continue
        const otherTop = other.ruStart + Math.max(1, other.height) - 1
        for (let unit = candidate.ruStart; unit <= top; unit++) {
            if (unit >= other.ruStart && unit <= otherTop) return `Rack unit ${unit} is taken by ${other.assetId}`
        }
    }
    return null
}

export interface ElevationRow {
    unit: number
    assetId: string | null
    span: number
}

/** Rows for drawing one face of a rack, top unit first; a device appears once, spanning its height. */
export function rackElevation(rackUnits: number, placements: readonly Placement[], face: RackFace): ElevationRow[] {
    const rows: ElevationRow[] = []
    let unit = rackUnits
    while (unit >= 1) {
        const device = placements.find((p) => p.face === face && unit >= p.ruStart && unit <= p.ruStart + Math.max(1, p.height) - 1)
        if (device) {
            const span = unit - device.ruStart + 1
            rows.push({ unit, assetId: device.assetId, span })
            unit -= span
        } else {
            rows.push({ unit, assetId: null, span: 1 })
            unit--
        }
    }
    return rows
}
