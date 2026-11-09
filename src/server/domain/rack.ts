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
 * the whole rack. `previousPowerW` is the draw the device had in this rack before the change
 * (undefined when it is new to the rack). An over-budget rack refuses a new device or a change that
 * raises its draw, but allows a move or a swap to a Model that draws no more.
 */
export function placementProblem(rack: RackSpec, placements: readonly Placement[], candidate: Placement, previousPowerW?: number): string | null {
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
    // The other devices draw the same before and after, so only the candidate's own draw can raise it.
    const raisesDraw = previousPowerW === undefined || drawW(candidate) > Math.max(0, previousPowerW)
    if (raisesDraw && budget.capacityW > 0 && budget.usedW > budget.capacityW) {
        return `The rack's power budget would be exceeded: ${budget.usedW} W of ${budget.capacityW} W`
    }
    return null
}

function drawW(placement: Placement): number {
    return Math.max(0, placement.powerW ?? 0)
}

function topUnit(placement: Placement): number {
    return placement.ruStart + Math.max(1, placement.height) - 1
}

/** Two devices on one face of a rack that share units; `unit` is the lowest unit they share. */
export interface Overlap {
    assetIds: [string, string]
    face: RackFace
    unit: number
}

/**
 * Every pair of devices sharing a unit on the same face, lowest unit first. placementProblem refuses a save that
 * would overlap, but two saves into the same units at the same moment both pass it, so the whole rack is re-checked
 * once they are written. Pairs are by position in the list, so two devices with the same name are still compared.
 */
export function overlaps(placements: readonly Placement[]): Overlap[] {
    const found: Overlap[] = []
    placements.forEach((a, i) => {
        for (const b of placements.slice(i + 1)) {
            if (a.face !== b.face) continue
            const unit = Math.max(a.ruStart, b.ruStart)
            if (unit <= Math.min(topUnit(a), topUnit(b))) found.push({ assetIds: [a.assetId, b.assetId], face: a.face, unit })
        }
    })
    return found.sort((x, y) => x.unit - y.unit)
}

export interface PowerBudget {
    capacityW: number
    usedW: number
    /** Used share of the capacity, in percent; null without a recorded capacity. */
    utilisation: number | null
}

/** Typical power drawn by the placed devices against the rack's capacity. */
export function powerBudget(capacityW: number, placements: readonly Placement[]): PowerBudget {
    const usedW = placements.reduce((sum, p) => sum + drawW(p), 0)
    if (capacityW <= 0) return { capacityW: 0, usedW, utilisation: null }
    return { capacityW, usedW, utilisation: Math.round((usedW / capacityW) * 100) }
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
