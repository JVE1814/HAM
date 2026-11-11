import { LOCK } from '../domain/lock-names.ts'
import { withLock } from '../platform/locks.ts'
import { log } from '../platform/log.ts'
import { raiseDueRefreshOrders } from '../platform/refresh.ts'

/**
 * Daily: refresh Orders for in-service Assets due within the horizon (P2.2, Q48: fully automatic). Two runs at once
 * (the scheduled job and an *Execute now*) would both read an Asset as on no open replacing line and raise it twice, so
 * a run holds a job lock (ADR 0013) from its read of the Assets due to its last Order; one that finds it held raises
 * nothing and logs so. Taking the lock throws only when an insert is refused with no lock row (platform/locks): that
 * error escapes.
 */
export function raiseRefreshOrders(): void {
    const lockName = LOCK.refreshOrders()
    if (withLock(lockName, raiseDueRefreshOrders).ran) return
    log.info(`Refresh Orders not raised: another run holds the ${lockName} lock and raises them`)
}
