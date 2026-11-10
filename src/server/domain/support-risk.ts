import { addDays } from './calendar.ts'
import { withoutCoverage } from './coverage.ts'
import { PAST_SUPPORT_PHASES } from './model-lifecycle.ts'
import { LIFECYCLE_PHASE, type LifecyclePhase } from './vocabulary.ts'

/** How exposed an installed device is to running unsupported, as the rack elevation colours it. */
export type SupportRisk = 'high' | 'medium' | 'low'

/** A refresh due within this many days counts as near. */
export const REFRESH_NEAR_DAYS = 180

/**
 * A device's support risk on `today`: high once its Model is past its end of support or it is without OEM coverage;
 * medium while its Model is past its end of sale or its refresh is near (`REFRESH_NEAR_DAYS`); low otherwise.
 * `coverageEnd` and `refreshDue` are YYYY-MM-DD, '' when the Asset has none.
 */
export function supportRisk(device: { lifecyclePhase: LifecyclePhase | ''; coverageEnd: string; refreshDue: string }, today: string): SupportRisk {
    if (device.lifecyclePhase !== '' && PAST_SUPPORT_PHASES.includes(device.lifecyclePhase)) return 'high'
    if (withoutCoverage(device.coverageEnd, today)) return 'high'
    const refreshNear = device.refreshDue !== '' && device.refreshDue < addDays(today, REFRESH_NEAR_DAYS)
    return device.lifecyclePhase === LIFECYCLE_PHASE.end_of_sale || refreshNear ? 'medium' : 'low'
}
