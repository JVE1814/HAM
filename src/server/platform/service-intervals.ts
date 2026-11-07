import { GlideRecord, gs } from '@servicenow/glide'
import { intervalEnd, restartInterval } from '../domain/billing'
import { isBillable } from '../domain/lifecycle'
import { readStage } from './assets'
import { todayIso } from './clock'
import { withLockTries, type HeldLock } from './locks'
import { exists, refusal, str } from './records'

/** Service intervals: the days each Asset delivered a Subscription line (P3.25). */

/** Tries at taking an Asset's interval lock: a holder keeps it for a few reads and a save or two. */
const LOCK_ATTEMPTS = 5

/**
 * Start billing an Asset on a Subscription line from `startIso`, unless an interval is already open for
 * it; one it closed on that day or later at the same line and Site is reopened instead (restartInterval).
 * Two saves of the Asset can put it in service at once (a Seen signal and the detection job, two NMS batches), and one
 * can take it out of service before this save's rule runs, its close finding nothing open yet. So the open and the
 * close (closeServiceIntervals) of one Asset take turns under a lock on it, each reading the Asset afresh there: the
 * open re-checks what is open, and closes its interval today if the Asset has left service since, as that close would
 * have done had it come second. A save that finds the lock held tries again, then leaves the interval to the holder.
 *
 * It runs after the Asset's save, which it cannot undo, and no later stage change retries it, so an interval not open
 * is logged for an asset manager or finance to open by hand: a refused save as a warning, like every refusal, and as an
 * error one the lock kept from opening (the holder had still not opened it when this save gave up, and may have died
 * holding the lock, ADR 0013; or the lock could not be taken, platform/locks throws).
 */
export function openServiceInterval(asset: GlideRecord, lineId: string, startIso: string): void {
    const assetId = asset.getUniqueValue()
    const why = underIntervalLock(assetId, (lock) => openHolding(lock, asset, lineId, startIso))
    // The holder has normally opened it by now; one that has not may be slow, or have died holding the lock.
    if (why === null || hasOpenInterval(assetId)) return
    const unopened = `${str(asset, 'serial_number')} in service from ${startIso}, no interval open`
    gs.error(`[x_daas_ham] ${unopened}: ${why}; open it by hand if it is still not open`)
}

/**
 * Run `work` holding the Asset's interval lock, trying again while another save holds it. Null once it ran, else why it
 * did not (held through every try, or the lock could not be taken), for the caller to log; `work`'s own errors escape.
 */
function underIntervalLock(assetId: string, work: (lock: HeldLock) => void): string | null {
    // Set inside the lock: `work`'s errors escape, and only a lock that could not be taken is reported.
    let started = false as boolean
    try {
        const ran = withLockTries(`service_interval_${assetId}`, LOCK_ATTEMPTS, (lock) => {
            started = true
            work(lock)
        })
        return ran ? null : 'left to another save holding its lock, which has not finished'
    } catch (error) {
        if (started) throw error
        return errorText(error)
    }
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

/**
 * Open (or reopen) the interval holding `lock`, then close it today if the Asset has left service since. A holder that
 * outlasts the lock (ADR 0013) may overlap the save that took it over and opens the interval too: one that lost it
 * before saving leaves the interval to that save, one that lost it during the save is logged.
 */
function openHolding(lock: HeldLock, asset: GlideRecord, lineId: string, startIso: string): void {
    if (!hasOpenInterval(asset.getUniqueValue()) && !openInterval(lock, asset, lineId, startIso)) return
    closeHolding(lock, asset.getUniqueValue(), todayIso())
}

/** Open the interval (see openHolding); false when it is not saved or the lock was lost before saving it. */
function openInterval(lock: HeldLock, asset: GlideRecord, lineId: string, startIso: string): boolean {
    const assetId = asset.getUniqueValue()
    const place = { lineId, siteId: str(asset, 'x_daas_ham_site') }
    const latest = latestClosedInterval(assetId)
    const closed = latest && {
        lineId: str(latest, 'subscription_line'),
        siteId: str(latest, 'site'),
        end: str(latest, 'end_date'),
    }
    const restart = restartInterval(closed, place, startIso)
    if (!lock.held()) return false
    let interval: GlideRecord
    let saved: string | null
    if ('reopen' in restart) {
        // restartInterval only reopens the latest interval, so it exists here.
        if (!latest) return false
        interval = latest
        interval.setValue('end_date', '')
        saved = interval.update()
    } else {
        interval = new GlideRecord('x_daas_ham_service_interval')
        interval.initialize()
        interval.setValue('asset', assetId)
        interval.setValue('subscription_line', lineId)
        interval.setValue('customer', str(asset, 'company'))
        interval.setValue('site', place.siteId)
        interval.setValue('start_date', restart.start)
        saved = interval.insert()
    }
    const opened = `${str(asset, 'serial_number')} in service from ${startIso}`
    if (!saved) {
        gs.warn(`[x_daas_ham] ${opened}, no interval open: ${refusal(interval)}`)
        return false
    }
    // The save that took the lock over may have opened one too.
    if (!lock.held()) {
        gs.error(`[x_daas_ham] ${opened}, interval opened after its lock was lost: check only one is open`)
    }
    return true
}

function hasOpenInterval(assetId: string): boolean {
    return exists('x_daas_ham_service_interval', `asset=${assetId}^end_dateISEMPTY`)
}

function latestClosedInterval(assetId: string): GlideRecord | null {
    const interval = new GlideRecord('x_daas_ham_service_interval')
    interval.addQuery('asset', assetId)
    interval.addNotNullQuery('end_date')
    interval.orderByDesc('end_date')
    interval.setLimit(1)
    interval.query()
    return interval.next() ? interval : null
}

/**
 * Whether the Asset, read afresh, is in a billed stage now. It is read past the before-query rules (ADR 0005), as the
 * user whose save runs this may not see it; only read, never saved.
 */
function inServiceNow(assetId: string): boolean {
    const asset = new GlideRecord('alm_hardware')
    asset.setWorkflow(false)
    asset.addQuery('sys_id', assetId)
    asset.query()
    return asset.next() && isBillable(readStage(asset))
}

/**
 * Stop billing an Asset: its open intervals end on `endIso` (inclusive). It takes turns with the open under the Asset's
 * interval lock (see openServiceInterval) and closes only while the Asset, read afresh there, is still out of service:
 * one a later save put back in service keeps its interval, which that save's open then finds open. A save that finds
 * the lock held tries again, then leaves the close to the holder; an interval still open for an Asset out of service
 * when it gives up is logged as an error, to close by hand if the holder does not.
 */
export function closeServiceIntervals(assetId: string, endIso: string): void {
    const why = underIntervalLock(assetId, (lock) => closeHolding(lock, assetId, endIso))
    if (why === null) return
    const open = openIntervals(assetId)
    if (!open.next() || inServiceNow(assetId)) return
    // A holder that is an open closes it too once it sees the Asset out of service, so this may clear itself.
    const unclosed = `${str(open, 'asset.serial_number')} left service on ${endIso}, its Service interval still open`
    gs.error(`[x_daas_ham] ${unclosed}: ${why}; close it by hand if it is still open`)
}

/**
 * Close the open intervals holding `lock`, unless the Asset is back in service. A holder that outlasts the lock may
 * overlap the save that took it over: one that lost it before saving leaves the close to that save (an open, too,
 * closes what it finds open for an Asset out of service), one that lost it during the save is logged.
 */
function closeHolding(lock: HeldLock, assetId: string, endIso: string): void {
    if (inServiceNow(assetId)) return
    const interval = openIntervals(assetId)
    if (!interval.hasNext() || !lock.held()) return
    let closed = ''
    while (interval.next()) {
        const serial = str(interval, 'asset.serial_number')
        interval.setValue('end_date', intervalEnd(str(interval, 'start_date'), endIso))
        if (interval.update()) {
            closed = serial
            continue
        }
        // Left open, the interval goes on billing an Asset that has left service.
        const reason = refusal(interval)
        gs.warn(`[x_daas_ham] ${serial} left service on ${endIso}, its Service interval did not close: ${reason}`)
    }
    // The save that took the lock over may have put the Asset back in service and found the interval still open.
    if (closed && !lock.held()) {
        gs.error(`[x_daas_ham] ${closed} interval closed after its lock was lost: check it matches the Asset's stage`)
    }
}

function openIntervals(assetId: string): GlideRecord {
    const interval = new GlideRecord('x_daas_ham_service_interval')
    interval.addQuery('asset', assetId)
    interval.addNullQuery('end_date')
    interval.query()
    return interval
}
