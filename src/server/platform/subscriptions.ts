import { GlideRecord } from '@servicenow/glide'
import { toIsoDate } from '../domain/calendar.ts'
import { chooseSubscriptionLine, type SubscriptionLineView } from '../domain/in-service.ts'
import { TRY_AGAIN, type HeldLock, type TryAgain } from '../domain/job-lock.ts'
import { LOCK } from '../domain/lock-names.ts'
import { sitePackageHoldersQuery } from '../domain/returns.ts'
import { SUBSCRIPTION_LINE_STATUS } from '../domain/vocabulary.ts'
import { todayIso } from './clock.ts'
import { withLockTries } from './locks.ts'
import { log } from './log.ts'
import { exists, findById, refusal, str, warnRefused } from './records.ts'

/** Subscription lines (x_daas_ham_subscription_line): a pending one starts with its first Asset into service, a site package ends as the last unit leaves its Site. */

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
    gr.addQuery('status', '!=', SUBSCRIPTION_LINE_STATUS.ended)
    gr.query()
    while (gr.next()) {
        lines.push({
            id: gr.getUniqueValue(),
            lineType: str(gr, 'line_type') as SubscriptionLineView['lineType'],
            siteId: str(gr, 'site'),
            deviceClass: str(gr, 'device_class'),
            status: str(gr, 'status') as SubscriptionLineView['status'],
            start: str(gr, 'start_date') || undefined,
            end: str(gr, 'end_date') || undefined,
        })
    }
    const lineId = chooseSubscriptionLine(lines, {
        siteId: str(asset, 'x_daas_ham_site'),
        deviceClass: str(asset, 'model.x_daas_ham_device_class'),
        liveOn: toIsoDate(inServiceAt),
    })
    if (!lineId) return true
    if (lines.find((l) => l.id === lineId)?.status === 'pending') {
        const unstarted = startLine(lineId, inServiceAt)
        if (unstarted) {
            const serial = str(asset, 'serial_number')
            log.warn(`${serial} stays pending in service, line not started: ${unstarted}`)
            return false
        }
    }
    // The Service interval opens when the Asset actually enters service (entry/billing.ts onAssetServiceChange).
    asset.setValue('x_daas_ham_subscription_line', lineId)
    return true
}

/**
 * Start the pending line from `inServiceAt`: '' once it is active, else why not. Go-lives of two Assets, each under its
 * own sighting lock, can both find the line pending, and the later save would replace the first one's start date. So
 * the line is read afresh under its lock (ADR 0013): one another go-live started is joined with its start date kept.
 * One ended since (by hand) is not set active again: the Asset stays pending, as it does when another go-live held the
 * lock through every try, and its next sighting chooses among the open lines left. Taken under the sighting lock,
 * nothing is taken under it, and it is released before the go-live save takes the interval lock. A holder keeps it for
 * one read and one save. A take that throws is tried again, and its error escapes only when every try threw.
 */
function startLine(lineId: string, inServiceAt: number): string {
    const started = withLockTries(LOCK.subscriptionLine(lineId), (lock) => startHolding(lock, lineId, inServiceAt))
    return started.ran ? started.value : 'another go-live held its lock through every try'
}

/** Start the line read afresh, holding its `lock` (see startLine); the try is given up when the lock was lost before the save. */
function startHolding(lock: HeldLock, lineId: string, inServiceAt: number): string | TryAgain {
    const line = findById('x_daas_ham_subscription_line', lineId)
    if (!line) return 'the line is gone'
    const status = str(line, 'status')
    if (status === SUBSCRIPTION_LINE_STATUS.active) return ''
    if (status !== SUBSCRIPTION_LINE_STATUS.pending) return `the line is ${status || 'without a status'} now`
    line.setValue('status', SUBSCRIPTION_LINE_STATUS.active)
    line.setValue('start_date', toIsoDate(inServiceAt))
    // The go-live that took a lost lock over may have read the line pending too, and saved its own start date.
    const late = { check: 'check its start date', level: 'error' } as const
    const saved = lock.save(`${str(line, 'description')} started`, () => line.update(), late)
    if (saved === 'lock lost') return TRY_AGAIN
    return saved === 'refused' ? refusal(line) : ''
}

/**
 * An active site package ends on the day nothing is left at its Site under its Agreement (domain/returns
 * `sitePackageHoldersQuery`). It is found by the Site and Agreement the unit leaves, not the line it carries, so a
 * swap's new unit that leaves before monitoring attached it still ends it. The Assets left are counted past the
 * before-query visibility rules (ADR 0005): the receiving tech sees only Assets in their stockrooms, so the units
 * still at the Site would be missed and the line would end on the first unit back.
 */
export function endSitePackageIfEmpty(siteId: string, agreementId: string): void {
    if (!siteId || !agreementId) return
    const line = new GlideRecord('x_daas_ham_subscription_line')
    line.addQuery('agreement', agreementId)
    line.addQuery('site', siteId)
    line.addQuery('line_type', 'site_package')
    line.addQuery('status', SUBSCRIPTION_LINE_STATUS.active)
    line.query()
    if (!line.hasNext()) return
    if (exists('alm_hardware', sitePackageHoldersQuery({ siteId, agreementId }), { beyondVisibility: true })) return
    while (line.next()) {
        line.setValue('status', SUBSCRIPTION_LINE_STATUS.ended)
        line.setValue('end_date', todayIso())
        // A site package bills its own dates, and no later unit leaving ends it: logged for finance to end by hand.
        if (!line.update()) warnRefused(line, `Site package "${str(line, 'description')}" not ended`)
    }
}
