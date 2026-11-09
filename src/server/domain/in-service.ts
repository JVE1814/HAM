import type { Stage } from './lifecycle.ts'

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

export interface SubscriptionLineView {
    id: string
    lineType: 'site_package' | 'device_class'
    siteId: string
    deviceClass: string
    status: 'pending' | 'active' | 'ended'
}

/** The open Subscription line an in-service Asset delivers: its Site's package, else its Device-class line. */
export function chooseSubscriptionLine(
    lines: readonly SubscriptionLineView[],
    asset: { siteId: string; deviceClass: string },
): string | null {
    const open = lines.filter((l) => l.status !== 'ended')
    const sitePackage = open.find((l) => l.lineType === 'site_package' && l.siteId === asset.siteId)
    if (sitePackage) return sitePackage.id
    const classLine = open.find(
        (l) => l.lineType === 'device_class' && l.deviceClass === asset.deviceClass && (!l.siteId || l.siteId === asset.siteId),
    )
    return classLine?.id ?? null
}
