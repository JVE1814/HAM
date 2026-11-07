import { GlideRecord, gs } from '@servicenow/glide'
import { intervalEnd, restartInterval } from '../domain/billing'
import { exists, str } from './records'

/** Service intervals: the days each Asset delivered a Subscription line (P3.25). */

/**
 * Start billing an Asset on a Subscription line from `startIso`, unless an interval is already open for
 * it; one it closed on that day or later at the same line and Site is reopened instead (restartInterval).
 * It runs after the Asset's save, which it cannot undo, and no later stage change retries it: a refused save is
 * logged for an asset manager or finance to add the interval by hand.
 */
export function openServiceInterval(asset: GlideRecord, lineId: string, startIso: string): void {
    const assetId = asset.getUniqueValue()
    if (exists('x_daas_ham_service_interval', `asset=${assetId}^end_dateISEMPTY`)) return
    const place = { lineId, siteId: str(asset, 'x_daas_ham_site') }
    const latest = latestClosedInterval(assetId)
    const restart = restartInterval(latest && { lineId: str(latest, 'subscription_line'), siteId: str(latest, 'site'), end: str(latest, 'end_date') }, place, startIso)
    if ('reopen' in restart) {
        // restartInterval only reopens the latest interval, so it exists here.
        latest?.setValue('end_date', '')
        if (latest && !latest.update()) warnUnbilled(asset, startIso, latest)
        return
    }
    const interval = new GlideRecord('x_daas_ham_service_interval')
    interval.initialize()
    interval.setValue('asset', assetId)
    interval.setValue('subscription_line', lineId)
    interval.setValue('customer', str(asset, 'company'))
    interval.setValue('site', place.siteId)
    interval.setValue('start_date', restart.start)
    if (!interval.insert()) warnUnbilled(asset, startIso, interval)
}

function warnUnbilled(asset: GlideRecord, startIso: string, interval: GlideRecord): void {
    const reason = interval.getLastErrorMessage() || 'the save was refused'
    gs.warn(`[x_daas_ham] ${str(asset, 'serial_number')} in service from ${startIso}, no interval open: ${reason}`)
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
        const reason = interval.getLastErrorMessage() || 'the save was refused'
        gs.warn(
            `[x_daas_ham] ${str(interval, 'asset.serial_number')} left service on ${endIso}, ` +
                `its Service interval did not close: ${reason}`,
        )
    }
}
