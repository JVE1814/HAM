import type { Stage } from './lifecycle.ts'
import type { SeenSource, SubscriptionLineStatus, SubscriptionLineType } from './vocabulary.ts'

/**
 * In service: an Asset installed at a Site and seen by monitoring after the install. That instant
 * starts billing for its Subscription line: the first sighting since the install, which the Asset keeps
 * (`firstSeenAt`) so that a go-live put off (its Subscription line could not be started) still starts from it.
 */
export interface InServiceFacts {
    stage: Stage | null
    installCompletedAt?: number
    /** The first sighting since the install, as stored on the Asset when an earlier sighting found one. */
    firstSeenAt?: number
    lastSeenAt?: number
    temporary: boolean
}

export type InServiceDecision =
    | { goesLive: true; at: number; stage: 'in_service' | 'temporary_deployment' }
    | { goesLive: false; reason: string }

/**
 * The first sighting since the install that the Asset's record knows of: the one stored, unless it is from before the
 * install (the install was completed again since), else the last sighting when that is since the install. Undefined
 * while the Asset has not been seen since its install, or has no install time.
 */
export function firstSeenSinceInstall(facts: Pick<InServiceFacts, 'installCompletedAt' | 'firstSeenAt' | 'lastSeenAt'>): number | undefined {
    const { installCompletedAt, firstSeenAt, lastSeenAt } = facts
    if (installCompletedAt === undefined) return undefined
    if (firstSeenAt !== undefined && firstSeenAt >= installCompletedAt) return firstSeenAt
    return lastSeenAt !== undefined && lastSeenAt >= installCompletedAt ? lastSeenAt : undefined
}

export function decideInService(facts: InServiceFacts): InServiceDecision {
    if (facts.stage !== 'pending_in_service') return { goesLive: false, reason: 'not pending in service' }
    if (facts.installCompletedAt === undefined) return { goesLive: false, reason: 'install not completed' }
    const at = firstSeenSinceInstall(facts)
    if (at === undefined) return { goesLive: false, reason: 'not seen since install' }
    return { goesLive: true, at, stage: facts.temporary ? 'temporary_deployment' : 'in_service' }
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
