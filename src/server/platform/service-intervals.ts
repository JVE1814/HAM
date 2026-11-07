import { GlideRecord } from '@servicenow/glide'
import { count, str } from './records'

/** Service intervals: the days each Asset delivered a Subscription line (P3.25). */

/** Start billing an Asset on a Subscription line from `startIso`, unless an interval is already open for it. */
export function openServiceInterval(asset: GlideRecord, lineId: string, startIso: string): void {
    if (count('x_daas_ham_service_interval', `asset=${asset.getUniqueValue()}^end_dateISEMPTY`) > 0) return
    const interval = new GlideRecord('x_daas_ham_service_interval')
    interval.initialize()
    interval.setValue('asset', asset.getUniqueValue())
    interval.setValue('subscription_line', lineId)
    interval.setValue('customer', str(asset, 'company'))
    interval.setValue('site', str(asset, 'x_daas_ham_site'))
    interval.setValue('start_date', startIso)
    interval.insert()
}

/** Stop billing an Asset: its open intervals end on `endIso` (inclusive). */
export function closeServiceIntervals(assetId: string, endIso: string): void {
    const interval = new GlideRecord('x_daas_ham_service_interval')
    interval.addQuery('asset', assetId)
    interval.addNullQuery('end_date')
    interval.query()
    while (interval.next()) {
        interval.setValue('end_date', endIso < str(interval, 'start_date') ? str(interval, 'start_date') : endIso)
        interval.update()
    }
}
