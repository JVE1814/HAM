import { GlideRecord, gs } from '@servicenow/glide'
import { toIsoDate } from '../domain/calendar'
import { chooseSubscriptionLine, type SubscriptionLineView } from '../domain/in-service'
import { findById, refusal, str } from './records'

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
        const line = findById('x_daas_ham_subscription_line', lineId)
        line?.setValue('status', 'active')
        line?.setValue('start_date', toIsoDate(inServiceAt))
        if (!line?.update()) {
            const reason = line ? refusal(line) : 'the line is gone'
            gs.warn(`[x_daas_ham] ${str(asset, 'serial_number')} stays pending in service, line not started: ${reason}`)
            return false
        }
    }
    // The Service interval opens when the Asset actually enters service (entry/assets.ts onAssetServiceChange).
    asset.setValue('x_daas_ham_subscription_line', lineId)
    return true
}
