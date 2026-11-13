import { gs, type GlideRecord } from '@servicenow/glide'
import type { RESTAPIRequest, RESTAPIResponse } from '@servicenow/glide/sn_ws_int'
import { PROPERTY } from '../domain/properties.ts'
import {
    boundedTracking,
    parseTrackingWebhook,
    tokenMatches,
    WEBHOOK_TOKEN_HEADER,
    webhookToken,
} from '../domain/shipping.ts'
import { timesRequeued } from '../platform/events.ts'
import { log } from '../platform/log.ts'
import { secretProperty } from '../platform/properties.ts'
import { str } from '../platform/records.ts'
import { queryParam, reply } from '../platform/rest-api.ts'
import { labelReturn, retryTracking, trackShipment, voidLabel } from '../platform/shipping.ts'

export function uiCreateReturnLabel(current: GlideRecord): void {
    const label = labelReturn(current)
    if (!label.bought) return void gs.addErrorMessage(label.why)
    if (label.unnoted) return void gs.addErrorMessage(label.unnoted)
    gs.addInfoMessage(`Return label ${label.trackingNumber} created`)
}

/**
 * UI action "Mark label voided" on a Shipment, once the person voided the label with the carrier.
 * Edits on the form are not saved with it.
 */
export function uiMarkLabelVoided(current: GlideRecord): void {
    const outcome = voidLabel(current.getUniqueValue(), str(current, 'tracking_number'))
    if (!outcome.voided) return void gs.addErrorMessage(outcome.why)
    if (outcome.leftUndone) gs.addErrorMessage(outcome.message)
    else gs.addInfoMessage(outcome.message)
}

/**
 * POST /shipping/tracking: tracking webhook from the aggregator (no platform login), authenticated by
 * the X-NaaS-Webhook-Token header, or by ?token= when the header is absent (ADR 0012). A Shipment or tracking event
 * the platform refuses is answered 500, not as a success, so an aggregator that retries failed deliveries
 * sends the update again. An update held off by its Shipment's tracking lock is answered 202 and applied in the
 * background, not left to the aggregator; only one that cannot be queued is
 * answered 503.
 * A configured token shorter than domain/shipping `WEBHOOK_TOKEN_MIN_LENGTH` counts as none: every call is answered as
 * for a wrong token. Nothing is logged then, since anyone can call the route; the preflight check reports the property.
 * Of an update that lists more events than `MAX_TRACKING_EVENTS`, only the newest are taken (`boundedTracking`), with
 * a warning.
 */
export function postTrackingUpdate(request: RESTAPIRequest, response: RESTAPIResponse): void {
    const token = webhookToken(request.getHeader(WEBHOOK_TOKEN_HEADER), queryParam(request, 'token'))
    const secret = secretProperty(PROPERTY.shippingWebhookToken)
    if (!tokenMatches(token, secret)) return reply(response, 401, { error: 'bad token' })
    const parsed = parseTrackingWebhook(request.body.data)
    if ('error' in parsed) return reply(response, 400, { error: parsed.error })
    const { update, dropped } = boundedTracking(parsed)
    if (dropped > 0) {
        log.warn(`Tracking update of ${update.trackingNumber}: ${dropped} of its ${parsed.events.length} events left out, only the newest ${update.events.length} are taken`)
    }
    const tracking = trackShipment(update)
    switch (tracking.outcome) {
        case 'unmatched':
            return reply(response, 200, { matched: false })
        case 'queued':
            return reply(response, 202, { matched: true, queued: true })
        case 'busy':
            return reply(response, 503, { error: 'Another update of this Shipment is being saved; send it again' })
        case 'shipment_refused':
            return reply(response, 500, { error: 'Shipment not saved; send the update again' })
        case 'events_refused':
            return reply(response, 500, { error: `${tracking.count} tracking event(s) not recorded; send the update again` })
        case 'applied':
            return reply(response, 200, { matched: true, status: tracking.status })
    }
}

export function retryTrackingUpdate(event: GlideRecord, current: GlideRecord): void {
    if (!current.getUniqueValue()) return
    retryTracking(current, str(event, 'parm1'), timesRequeued(event))
}
