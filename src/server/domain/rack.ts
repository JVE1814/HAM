/**
 * Rack placement (P2.8) and power budget (plan §13 Rack power budget): units are numbered from 1 at the bottom; a device
 * occupies ruStart..ruStart+height-1.
 */

export type RackFace = 'front' | 'rear'

/** Every rack face, to read x_daas_ham_rack_face with (platform/records `choice`). */
export const RACK_FACES: readonly RackFace[] = ['front', 'rear']

export interface Placement {
    /**
     * The key that tells the device from every other. Pass its sys_id: an asset tag or a serial number can be blank,
     * or shared by two devices. It must be the same for one device among `placements` and as the candidate, because
     * placementProblem leaves out the candidate's earlier placement by it. Shown only for a device with no `label`.
     */
    assetId: string
    /**
     * How messages and the elevation name the device (its asset tag, else its serial number). Two devices can share
     * one, so it is never compared. Left out or blank, the device is named by `assetId`.
     */
    label?: string
    ruStart: number
    height: number
    face: RackFace
    /** The Model's typical power draw (plan §13 Rack power budget); unknown counts as 0. */
    powerW?: number
}

/** A device placed in a rack, as its callers read it: the Asset's fields, and its Model's height and draw. */
export interface RackedDevice {
    /** The Asset's sys_id. */
    id: string
    tag: string
    serial: string
    ruStart: number
    face: RackFace
    /** Rack units its Model takes; under 1 counts as 1. */
    height: number
    powerW?: number
}

/**
 * The device's Placement, keyed by its sys_id and named by its asset tag, else its serial number. Every caller builds
 * its placements with it, so one device has one key wherever it is read, and as the candidate it is never counted as
 * overlapping itself.
 */
export function devicePlacement(device: RackedDevice): Placement {
    const { id, tag, serial, ruStart, face, height, powerW } = device
    return { assetId: id, label: tag || serial, ruStart, height: Math.max(1, height), face, powerW }
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
            if (unit >= other.ruStart && unit <= otherTop) return `Rack unit ${unit} is taken by ${labelOf(other)}`
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

function labelOf(placement: Placement): string {
    return placement.label || placement.assetId
}

function drawW(placement: Placement): number {
    return Math.max(0, placement.powerW ?? 0)
}

function topUnit(placement: Placement): number {
    return placement.ruStart + Math.max(1, placement.height) - 1
}

/** Two devices on one face of a rack that share units; `unit` is the lowest unit they share. */
export interface Overlap {
    /** The two devices' keys (Placement `assetId`), in list order, to tell them apart. Messages name them by `labels`. */
    assetIds: [string, string]
    /** Their names (Placement `label`, else `assetId`), for messages. */
    labels: [string, string]
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
            if (unit <= Math.min(topUnit(a), topUnit(b))) {
                found.push({ assetIds: [a.assetId, b.assetId], labels: [labelOf(a), labelOf(b)], face: a.face, unit })
            }
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
    /** The device in these units (Placement `assetId`), null for an empty unit. */
    assetId: string | null
    /** Its name (Placement `label`), null for an empty unit. */
    label: string | null
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
            rows.push({ unit, assetId: device.assetId, label: labelOf(device), span })
            unit -= span
        } else {
            rows.push({ unit, assetId: null, label: null, span: 1 })
            unit--
        }
    }
    return rows
}
