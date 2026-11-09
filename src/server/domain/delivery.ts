import type { Stage } from './lifecycle.ts'
import { INSTALLED_STAGES } from './returns.ts'

/**
 * Shipping an Order to its Site: when "Ship" is refused, what label it buys and what on-site work it opens, and when
 * install completion takes a replaced Asset out of service (P1.7).
 */

export type OrderType = 'site_rollout' | 'device_add' | 'device_replace' | 'temporary' | 'refresh'
export type InstallMode = 'fsm_engineer' | 'self_install' | 'subcontractor' | 'remote_hands'

/** What "Ship" needs to know about an Order. */
export interface ShipFacts {
    orderType: OrderType
    installMode: InstallMode
    /** The Order has a carrier and tracking number. */
    hasTrackingNumber: boolean
    /** That tracking number is a label an earlier Ship bought: it covers only the Assets that Ship packed. */
    trackingNumberBought: boolean
    /** On-site work is already open (an earlier Ship). */
    hasWorkOrder: boolean
    /** The Order's Assets in 'staged' that the lifecycle lets ship. */
    staged: number
    /** The Order's staged Assets and hot spares that the lifecycle refuses to ship. */
    refused: number
    /** Why the first refused Asset may not ship ('' when none is refused). */
    refusedReason: string
    /** The Order's Assets in 'spare_pool' that the lifecycle lets ship: hot spares already at the Site, handed over. */
    hotSpares: number
    /** The shipping aggregator is on. */
    shippingEnabled: boolean
}

/** The change request and FSM work order to open at the Site (D57). */
export interface OnSiteWork {
    changeType: 'standard' | 'normal'
    purpose: 'install' | 'swap'
    subcontracted: boolean
}

/**
 * The errors to show the user (refused Assets first) and, unless Ship is refused, the label to buy
 * and the on-site work to open. Refused Assets alone do not stop the others from shipping.
 */
export type ShipPlan = { errors: string[] } & ({ ok: false } | { ok: true; labelPackages: number | null; onSiteWork: OnSiteWork | null })

/** What "Ship" does for an Order: refuse, buy a label for N packages, open on-site work. Total, no I/O. */
export function planShipment(facts: ShipFacts): ShipPlan {
    const refusals = facts.refused > 0 ? [`${facts.refused} asset(s) cannot ship: ${facts.refusedReason}`] : []
    if (facts.staged + facts.hotSpares === 0) {
        return { ok: false, errors: refusals.length > 0 ? refusals : ['Nothing is staged for this order yet'] }
    }
    const enteredByHand = facts.hasTrackingNumber && !facts.trackingNumberBought
    const needsCarrier = facts.staged > 0 && !enteredByHand && facts.installMode !== 'remote_hands'
    if (needsCarrier && !facts.shippingEnabled) {
        return { ok: false, errors: [...refusals, 'Enter the carrier and tracking number before shipping'] }
    }
    return {
        ok: true,
        errors: refusals,
        // The shipping aggregator replaces manual tracking numbers (P3.26): one package per staged Asset, and a
        // new label for Assets staged after an earlier Ship. Hot spares are already at the Site, so never packaged.
        labelPackages: needsCarrier ? facts.staged : null,
        onSiteWork: facts.installMode === 'self_install' || facts.hasWorkOrder ? null : onSiteWork(facts),
    }
}

/** A device replace is a routine (standard) change; device replace and refresh swap Assets, the rest install them. */
function onSiteWork({ orderType, installMode }: ShipFacts): OnSiteWork {
    return {
        changeType: orderType === 'device_replace' ? 'standard' : 'normal',
        purpose: orderType === 'device_replace' || orderType === 'refresh' ? 'swap' : 'install',
        subcontracted: installMode === 'subcontractor' || installMode === 'remote_hands',
    }
}

/** A line that replaces an Asset (break-fix, refresh): its quantity and the stages of the units allocated to it. */
export interface ReplacementLine {
    quantity: number
    assetStages: ReadonlyArray<Stage | null>
}

/**
 * Whether a replacing line's own units are installed (pending in service or further), so the Asset it replaces may
 * come out of service. Decided per line: a replacement the platform refused to move is still shipped, and the unit it
 * replaces keeps serving the Site until confirming again installs it. A line with no quantity replaces nothing.
 */
export function replacementInstalled(line: ReplacementLine): boolean {
    const installed = line.assetStages.filter((stage) => stage !== null && INSTALLED_STAGES.includes(stage)).length
    return line.quantity > 0 && installed >= line.quantity
}
