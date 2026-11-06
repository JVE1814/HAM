import { GlideRecord } from '@servicenow/glide'
import { toIsoDate } from '../domain/calendar'
import { chooseSubscriptionLine, type SubscriptionLineView } from '../domain/in-service'
import { findById, str } from './records'

/** Attach an in-service Asset to the Subscription line it delivers and start that line's billing. */
export function attachToSubscription(asset: GlideRecord, inServiceAt: number): string | null {
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
    if (!lineId) return null
    asset.setValue('x_daas_ham_subscription_line', lineId)
    if (lines.find((l) => l.id === lineId)?.status === 'pending') {
        const line = findById('x_daas_ham_subscription_line', lineId)
        line?.setValue('status', 'active')
        line?.setValue('start_date', toIsoDate(inServiceAt))
        line?.update()
    }
    return lineId
}
