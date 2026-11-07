import { GlideRecord } from '@servicenow/glide'
import { OPEN_SHIPMENTS } from '../domain/shipping'
import { str } from './records'

/** Reads of shipments (x_daas_ham_shipment) bought from the shipping aggregator (P3.26, D73). */

/** A prepaid return label the Site contact prints. */
export interface ReturnLabel {
    labelUrl: string
    trackingNumber: string
}

/** The latest prepaid return label still in use (not delivered or returned) of each Return order that has one. */
export function returnLabels(returnOrderIds: readonly string[]): Map<string, ReturnLabel> {
    const labels = new Map<string, ReturnLabel>()
    if (returnOrderIds.length === 0) return labels
    const shipment = new GlideRecord('x_daas_ham_shipment')
    shipment.addEncodedQuery(`direction=return^${OPEN_SHIPMENTS}^return_orderIN${returnOrderIds.join(',')}`)
    shipment.orderBy('sys_created_on')
    shipment.query()
    while (shipment.next()) labels.set(str(shipment, 'return_order'), { labelUrl: str(shipment, 'label_url'), trackingNumber: str(shipment, 'tracking_number') })
    return labels
}
