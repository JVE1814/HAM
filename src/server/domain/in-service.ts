import type { Stage } from './lifecycle.ts'
import type { SeenSource, SubscriptionLineStatus, SubscriptionLineType } from './vocabulary.ts'

/**
 * In service: an Asset installed at a Site and seen by monitoring after the install. That instant
 * starts billing for its Subscription line.
 */
export interface InServiceFacts {
    stage: Stage | null
    installCompletedAt?: number
    lastSeenAt?: number
    temporary: boolean
}

export type InServiceDecision =
    | { goesLive: true; at: number; stage: 'in_service' | 'temporary_deployment' }
    | { goesLive: false; reason: string }

export function decideInService(facts: InServiceFacts): InServiceDecision {
    if (facts.stage !== 'pending_in_service') return { goesLive: false, reason: 'not pending in service' }
    if (facts.installCompletedAt === undefined) return { goesLive: false, reason: 'install not completed' }
    if (facts.lastSeenAt === undefined || facts.lastSeenAt < facts.installCompletedAt) {
        return { goesLive: false, reason: 'not seen since install' }
    }
    return { goesLive: true, at: facts.lastSeenAt, stage: facts.temporary ? 'temporary_deployment' : 'in_service' }
}

/**
 * The Seen source of a sighting read from the Asset's CI: Discovery's own (it writes the discovery source
 * `ServiceNow`), or a connector's for any other source.
 */
export function seenSourceOf(discoverySource: string): Extract<SeenSource, 'discovery' | 'connector'> {
    return discoverySource === 'ServiceNow' ? 'discovery' : 'connector'
}

export interface SubscriptionLineView {
    id: string
    lineType: SubscriptionLineType
    siteId: string
    deviceClass: string
    status: SubscriptionLineStatus
    start?: string
    end?: string
}

/**
 * The open Subscription line an in-service Asset delivers from `liveOn`: its Site's package, else its Device-class line.
 * A Device-class line for the Asset's Site is chosen before one with no Site, whatever order the lines are read in. A
 * line whose end date is before `liveOn` is passed over, set ended or not: it would bill none of the unit's days. Within
 * each of those, a line started by `liveOn` (or pending, which starts then) is chosen before one that starts later.
 */
export function chooseSubscriptionLine(
    lines: readonly SubscriptionLineView[],
    asset: { siteId: string; deviceClass: string; liveOn: string },
): string | null {
    const open = lines.filter((l) => l.status !== 'ended' && !(l.end && l.end < asset.liveOn))
    const classLines = open.filter((l) => l.lineType === 'device_class' && l.deviceClass === asset.deviceClass)
    const inPrecedence = [
        open.filter((l) => l.lineType === 'site_package' && l.siteId === asset.siteId),
        classLines.filter((l) => l.siteId && l.siteId === asset.siteId),
        classLines.filter((l) => !l.siteId),
    ]
    for (const candidates of inPrecedence) {
        const chosen = candidates.find((l) => !l.start || l.start <= asset.liveOn) ?? candidates[0]
        if (chosen) return chosen.id
    }
    return null
}
