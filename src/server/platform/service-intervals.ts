import { GlideRecord, gs } from '@servicenow/glide'
import { intervalEnd, restartInterval } from '../domain/billing'
import { withLock, type HeldLock } from './locks'
import { exists, refusal, str } from './records'

/** Service intervals: the days each Asset delivered a Subscription line (P3.25). */

/** Tries at taking an Asset's interval lock: a holder keeps it for a few reads and one save. */
const LOCK_ATTEMPTS = 5

/**
 * Start billing an Asset on a Subscription line from `startIso`, unless an interval is already open for
 * it; one it closed on that day or later at the same line and Site is reopened instead (restartInterval).
 * Two saves of the Asset can put it in service at once (a Seen signal and the detection job, two NMS batches), so the
 * check and the reopen or insert are made under a lock on the Asset, re-checking there. Only this takes that lock, so
 * its holder is another save opening the same interval: a save that finds it held tries again, then leaves the
 * interval to the holder.
 *
 * It runs after the Asset's save, which it cannot undo, and no later stage change retries it, so an interval not open
 * is logged for an asset manager or finance to open by hand: a refused save as a warning, like every refusal, and as an
 * error one the lock kept from opening (the holder had still not opened it when this save gave up, and may have died
 * holding the lock, ADR 0013; or the lock could not be taken, platform/locks throws).
 */
export function openServiceInterval(asset: GlideRecord, lineId: string, startIso: string): void {
    const assetId = asset.getUniqueValue()
    let held = false
    let takeError: unknown = null
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
        let started = false
        try {
            const taken = withLock(`service_interval_${assetId}`, (lock) => {
                started = true
                openHolding(lock, asset, lineId, startIso)
            })
            if (taken) return
            held = true
        } catch (error) {
            if (started) throw error
            takeError = error
        }
    }
    // The holder has normally opened it by now; one that has not may be slow, or have died holding the lock.
    if (hasOpenInterval(assetId)) return
    const why = held ? 'left to another save holding its lock, which has not opened it yet' : errorText(takeError)
    const unopened = `${str(asset, 'serial_number')} in service from ${startIso}, no interval open`
    gs.error(`[x_daas_ham] ${unopened}: ${why}; open it by hand if it is still not open`)
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

/**
 * Open (or reopen) the interval holding `lock`. A holder that outlasts the lock (ADR 0013) may overlap the save that
 * took it over and opens the interval too: one that lost it before saving leaves the interval to that save, one that
 * lost it during the save is logged.
 */
function openHolding(lock: HeldLock, asset: GlideRecord, lineId: string, startIso: string): void {
    const assetId = asset.getUniqueValue()
    if (hasOpenInterval(assetId)) return
    const place = { lineId, siteId: str(asset, 'x_daas_ham_site') }
    const latest = latestClosedInterval(assetId)
    const closed = latest && {
        lineId: str(latest, 'subscription_line'),
        siteId: str(latest, 'site'),
        end: str(latest, 'end_date'),
    }
    const restart = restartInterval(closed, place, startIso)
    if (!lock.held()) return
    let interval: GlideRecord
    let saved: string | null
    if ('reopen' in restart) {
        // restartInterval only reopens the latest interval, so it exists here.
        if (!latest) return
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
    } else if (!lock.held()) {
        // The save that took the lock over may have opened one too.
        gs.error(`[x_daas_ham] ${opened}, interval opened after its lock was lost: check only one is open`)
    }
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

/** Stop billing an Asset: its open intervals end on `endIso` (inclusive). */
export function closeServiceIntervals(assetId: string, endIso: string): void {
    const interval = new GlideRecord('x_daas_ham_service_interval')
    interval.addQuery('asset', assetId)
    interval.addNullQuery('end_date')
    interval.query()
    while (interval.next()) {
        interval.setValue('end_date', intervalEnd(str(interval, 'start_date'), endIso))
        if (interval.update()) continue
        // Left open, the interval goes on billing an Asset that has left service.
        const reason = refusal(interval)
        gs.warn(
            `[x_daas_ham] ${str(interval, 'asset.serial_number')} left service on ${endIso}, ` +
                `its Service interval did not close: ${reason}`,
        )
    }
}
