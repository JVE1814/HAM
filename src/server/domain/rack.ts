/**
 * Rack placement (P2.8) and power budget (P3.29): units are numbered from 1 at the bottom; a device
 * occupies ruStart..ruStart+height-1.
 */

export type RackFace = 'front' | 'rear'

export interface Placement {
    assetId: string
    ruStart: number
    height: number
    face: RackFace
    /** The Model's typical power draw (P3.29); unknown counts as 0. */
    powerW?: number
}

export interface RackSpec {
    units: number
    /** Power the rack can supply; 0 = no budget recorded. */
    powerCapacityW: number
}

/**
 * Why `candidate` cannot go where it is placed, or null if it fits: space on its face, and power for
 * the whole rack when the change adds draw (a device new to the rack, or a different Model). A move
 * within the rack adds none, so it is allowed even in a rack already over its budget.
 */
export function placementProblem(rack: RackSpec, placements: readonly Placement[], candidate: Placement, addsPower = true): string | null {
    const top = candidate.ruStart + Math.max(1, candidate.height) - 1
    if (candidate.ruStart < 1 || top > rack.units) {
        return `Rack units ${candidate.ruStart}-${top} do not fit in a ${rack.units}U rack`
    }
    const others = placements.filter((other) => other.assetId !== candidate.assetId)
    for (const other of others) {
        if (other.face !== candidate.face) continue
        const otherTop = other.ruStart + Math.max(1, other.height) - 1
        for (let unit = candidate.ruStart; unit <= top; unit++) {
            if (unit >= other.ruStart && unit <= otherTop) return `Rack unit ${unit} is taken by ${other.assetId}`
        }
    }
    const budget = powerBudget(rack.powerCapacityW, [...others, candidate])
    if (addsPower && budget.remainingW !== null && budget.remainingW < 0) {
        return `The rack's power budget would be exceeded: ${budget.usedW} W of ${budget.capacityW} W`
    }
    return null
}

export interface PowerBudget {
    capacityW: number
    usedW: number
    /** Null without a recorded capacity. */
    remainingW: number | null
    /** Used share of the capacity, in percent. */
    utilisation: number | null
}

/** Typical power drawn by the placed devices against the rack's capacity. */
export function powerBudget(capacityW: number, placements: readonly Placement[]): PowerBudget {
    const usedW = placements.reduce((sum, p) => sum + Math.max(0, p.powerW ?? 0), 0)
    if (capacityW <= 0) return { capacityW: 0, usedW, remainingW: null, utilisation: null }
    return { capacityW, usedW, remainingW: capacityW - usedW, utilisation: Math.round((usedW / capacityW) * 100) }
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
