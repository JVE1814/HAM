/** Shipping an Order to its Site: when "Ship" is refused, what label it buys and what on-site work it opens (P1.7). */

export type OrderType = 'site_rollout' | 'device_add' | 'device_replace' | 'temporary' | 'refresh'
export type InstallMode = 'fsm_engineer' | 'self_install' | 'subcontractor' | 'remote_hands'

/** What "Ship" needs to know about an Order. */
export interface ShipFacts {
    orderType: OrderType
    installMode: InstallMode
    /** A carrier and tracking number were entered by hand. */
    hasTrackingNumber: boolean
    /** On-site work is already open (an earlier Ship). */
    hasWorkOrder: boolean
    /** The Order's Assets in 'staged' that the lifecycle lets ship. */
    staged: number
    /** The Order's Assets in 'spare_pool': hot spares already at the Site. */
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

export type ShipPlan =
    | { ok: false; error: string }
    | { ok: true; labelPackages: number | null; onSiteWork: OnSiteWork | null }

/** What "Ship" does for an Order: refuse, buy a label for N packages, open on-site work. Total, no I/O. */
export function planShipment(facts: ShipFacts): ShipPlan {
    if (facts.staged + facts.hotSpares === 0) return { ok: false, error: 'Nothing is staged for this order yet' }
    const needsCarrier = facts.staged > 0 && !facts.hasTrackingNumber && facts.installMode !== 'remote_hands'
    if (needsCarrier && !facts.shippingEnabled) {
        return { ok: false, error: 'Enter the carrier and tracking number before shipping' }
    }
    return {
        ok: true,
        // The shipping aggregator replaces manual tracking numbers (P3.26): one package per staged Asset.
        // Hot spares are already at the Site, so they are never packaged.
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
