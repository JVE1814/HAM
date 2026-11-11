import { firstBest } from './collections.ts'
import { RMA_STATE, type RmaState } from './vocabulary.ts'

/** RMAs whose replacement is still to come: their line counts each as a unit on its way. */
export const RMA_AWAITED: readonly RmaState[] = [RMA_STATE.to_open, RMA_STATE.open]

/** RMAs still open, the defective unit not yet back with the OEM. */
export const RMA_OPEN: readonly RmaState[] = [...RMA_AWAITED, RMA_STATE.replacement_received]

/**
 * The open RMAs the OEM knows of: its status can be asked for, and the defective unit can be recorded as returned to it
 * (the action's condition is written from these states; the built action is checked against them).
 */
export const RMA_AT_OEM: readonly RmaState[] = RMA_OPEN.filter((state) => state !== RMA_STATE.to_open)

/**
 * Encoded query on x_daas_ham_oem_rma: the open RMAs, as the workspace lists them. A constant written out from the
 * state names for Fluent metadata to import (domain/oem-rma.test.ts holds it to `RMA_OPEN`).
 */
export const OPEN_RMAS_QUERY = `stateIN${RMA_STATE.to_open},${RMA_STATE.open},${RMA_STATE.replacement_received}`

/** An RMA for the Asset a break-fix line replaces, as `advanceReplacementRma` weighs it. */
export interface OpenRma {
    rmaId: string
    rmaNumber: string
    state: RmaState
    /** The Order line it serves; '' for none. */
    lineId: string
    /** Whether that line still waits to be filled (domain/sourcing `lineStillOpen`); false for none. */
    lineOpen: boolean
}

/** An open RMA a line's advance replacement goes under, and the state it is saved in. */
export interface RmaReuse {
    rma: OpenRma
    state: RmaState
    /** Its replacement was received (then lost in transit or failed staging): the vendor is asked for another. */
    askAgain: boolean
}

/**
 * Whether a break-fix line whose shortfall goes to an OEM advance replacement reuses an RMA already open for the unit
 * it replaces, or (null) opens one: the OEM is not asked twice for one defective unit. Reused, the RMA serves the line
 * and its replacement is awaited, so the line waits for it; one whose replacement was received goes back to open. The
 * line's own RMA comes first, then one still awaited, then the first given (`rmas` oldest first). One that another
 * open line waits for is that line's.
 */
export function advanceReplacementRma(lineId: string, rmas: readonly OpenRma[]): RmaReuse | null {
    const rank = (rma: OpenRma) => (rma.lineId === lineId ? 0 : 2) + (RMA_AWAITED.includes(rma.state) ? 0 : 1)
    const reusable = rmas.filter((rma) => RMA_OPEN.includes(rma.state) && (rma.lineId === lineId || !rma.lineOpen))
    const best = firstBest(reusable, (a, b) => rank(b) - rank(a))
    if (!best) return null
    const askAgain = !RMA_AWAITED.includes(best.state)
    return { rma: best, state: askAgain ? 'open' : best.state, askAgain }
}
