import { GlideRecord, gs } from '@servicenow/glide'
import { toIsoDate } from '../domain/calendar.ts'
import { chooseSubscriptionLine, type SubscriptionLineView } from '../domain/in-service.ts'
import { withLockTries, type HeldLock } from './locks.ts'
import { findById, refusal, str } from './records.ts'

/**
 * Attach an Asset going into service to the Subscription line it delivers and start that line (the caller saves the
 * Asset). False (and a warning) when its pending line cannot be started: billing skips pending lines, so the Asset must
 * not go into service on one. An Asset no line matches is attached to none and may go into service unbilled (the
 * Billing integrity dashboard counts it).
 */
export function attachToSubscription(asset: GlideRecord, inServiceAt: number): boolean {
    const lines: SubscriptionLineView[] = []
    const gr = new GlideRecord('x_daas_ham_subscription_line')
    gr.addQuery('agreement', str(asset, 'x_daas_ham_agreement'))
    gr.addQuery('status', '!=', 'ended')
    gr.query()
    while (gr.next()) {
        lines.push({
            id: gr.getUniqueValue(),
            lineType: str(gr, 'line_type') as SubscriptionLineView['lineType'],
            siteId: str(gr, 'site'),
            deviceClass: str(gr, 'device_class'),
            status: str(gr, 'status') as SubscriptionLineView['status'],
        })
    }
    const lineId = chooseSubscriptionLine(lines, {
        siteId: str(asset, 'x_daas_ham_site'),
        deviceClass: str(asset, 'model.x_daas_ham_device_class'),
    })
    if (!lineId) return true
    if (lines.find((l) => l.id === lineId)?.status === 'pending') {
        const unstarted = startLine(lineId, inServiceAt)
        if (unstarted) {
            const serial = str(asset, 'serial_number')
            gs.warn(`[x_daas_ham] ${serial} stays pending in service, line not started: ${unstarted}`)
            return false
        }
    }
    // The Service interval opens when the Asset actually enters service (entry/assets.ts onAssetServiceChange).
    asset.setValue('x_daas_ham_subscription_line', lineId)
    return true
}

/** Tries at taking a line's start lock: a holder keeps it for one read and one save. */
const LINE_LOCK_TRIES = 5

/**
 * Start the pending line from `inServiceAt`: '' once it is active, else why not. Go-lives of two Assets, each under its
 * own sighting lock, can both find the line pending, and the later save would replace the first one's start date. So
 * the line is read afresh under its lock `subscription_line_<sys_id>` (ADR 0013): one another go-live started is joined
 * with its start date kept. One ended since (by hand) is not set active again: the Asset stays pending, as it does when
 * another go-live held the lock through every try, and its next sighting chooses among the open lines left. Taken under
 * the sighting lock, nothing is taken under it, and it is released before the go-live save takes the interval lock. A
 * take that throws is tried again (platform/locks `withLockTries`), and its error escapes only when every try threw.
 */
function startLine(lineId: string, inServiceAt: number): string {
    // Set inside the lock; null gives the try up, the lock lost before the save.
    let why = null as string | null
    const ran = withLockTries(`subscription_line_${lineId}`, LINE_LOCK_TRIES, (lock) => {
        why = startHolding(lock, lineId, inServiceAt)
        return why !== null
    })
    return ran ? (why ?? '') : 'another go-live held its lock through every try'
}

/** Start the line read afresh, holding its `lock` (see startLine); null when the lock was lost before the save. */
function startHolding(lock: HeldLock, lineId: string, inServiceAt: number): string | null {
    const line = findById('x_daas_ham_subscription_line', lineId)
    if (!line) return 'the line is gone'
    const status = str(line, 'status')
    if (status === 'active') return ''
    if (status !== 'pending') return `the line is ${status || 'without a status'} now`
    if (!lock.held()) return null
    line.setValue('status', 'active')
    line.setValue('start_date', toIsoDate(inServiceAt))
    if (!line.update()) return refusal(line)
    // The go-live that took the lock over may have read it pending too, and saved its own start date.
    if (!lock.held()) {
        gs.error(`[x_daas_ham] ${str(line, 'description')} started after its lock was lost: check its start date`)
    }
    return ''
}
