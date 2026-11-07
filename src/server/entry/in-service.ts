import { GlideDateTime, GlideRecord, gs } from '@servicenow/glide'
import type { RESTAPIRequest, RESTAPIResponse } from '@servicenow/glide/sn_ws_int'
import { parseDeviceEvents, type DeviceEvent } from '../domain/device-events'
import { decideInService } from '../domain/in-service'
import { stagesQuery } from '../domain/lifecycle'
import { ROLE } from '../domain/visibility'
import { findAssetByIdentifier, moveAndSave, readStage } from '../platform/assets'
import { runTableJob } from '../platform/chunked'
import { glideToMs, msToGlide, nowMs } from '../platform/clock'
import { applyLifecycleDates, lifecycleReaders, type LifecycleReaders } from '../platform/lifecycle-dates'
import { intProperty, PROPERTY } from '../platform/properties'
import { deleteWhere, str } from '../platform/records'
import { reply } from '../platform/rest-api'
import { attachToSubscription } from '../platform/subscriptions'

// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.

/** In-service detection: Seen signals in, billing start out (P1.8). */

/** Record that an Asset was seen at `at` (only moves last_seen forward). */
function recordSeen(asset: GlideRecord, at: number, source: string): void {
    const previous = glideToMs(str(asset, 'x_daas_ham_last_seen'))
    if (previous !== undefined && previous >= at) return
    asset.setValue('x_daas_ham_last_seen', msToGlide(at))
    asset.setValue('x_daas_ham_seen_source', source)
}

/** Put a pending Asset in service if it has been seen since its install. Saves the asset. */
function goLiveIfSeen(asset: GlideRecord, readers: LifecycleReaders): void {
    const stage = readStage(asset)
    const decision = decideInService({
        stage,
        installCompletedAt: glideToMs(str(asset, 'x_daas_ham_install_completed')),
        lastSeenAt: glideToMs(str(asset, 'x_daas_ham_last_seen')),
        // Only a pending Asset can go live, so only it pays for the dot-walk to its Order.
        temporary: stage === 'pending_in_service' && str(asset, 'x_daas_ham_order_line.order.order_type') === 'temporary',
    })
    if (!decision.goesLive) {
        asset.update()
        return
    }
    asset.setValue('x_daas_ham_in_service_date', msToGlide(decision.at))
    attachToSubscription(asset, decision.at)
    applyLifecycleDates(asset, readers)
    moveAndSave(asset, decision.stage, 'in-service detection')
}

/** POST /api/x_daas_ham/naas/v1/device_events - Seen signals from the Provider NMS. */
export function postDeviceEvents(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!gs.hasRole(ROLE.integration) && !gs.hasRole(ROLE.assetManager)) return reply(response, 403, { error: 'Requires the x_daas_ham.integration role' })
    const parsed = parseDeviceEvents(request.body.data, intProperty(PROPERTY.eventsMaxBatch, 500), nowMs())
    if ('error' in parsed) return reply(response, 400, { error: parsed.error })
    const readers = lifecycleReaders()
    const unknown: string[] = []
    for (const event of parsed.events) {
        const asset = findAssetByIdentifier(event.identifier, { beyondVisibility: true })
        if (!asset) {
            unknown.push(event.identifier)
            continue
        }
        applyEvent(asset, event, readers)
    }
    reply(response, 202, {
        accepted: parsed.events.length - unknown.length,
        unknown_identifiers: unknown,
        rejected: parsed.rejected,
    })
}

function applyEvent(asset: GlideRecord, event: DeviceEvent, readers: LifecycleReaders): void {
    const lastKind = lastEventKind(asset.getUniqueValue())
    if (event.event !== 'seen' || lastKind !== 'seen') storeEvent(asset.getUniqueValue(), event)
    if (event.event === 'down') return
    recordSeen(asset, event.observedAt, event.source)
    goLiveIfSeen(asset, readers)
}

function lastEventKind(assetId: string): string {
    const gr = new GlideRecord('x_daas_ham_device_event')
    gr.addQuery('asset', assetId)
    gr.orderByDesc('observed_at')
    gr.setLimit(1)
    gr.query()
    return gr.next() ? str(gr, 'event') : ''
}

function storeEvent(assetId: string, event: DeviceEvent): void {
    const gr = new GlideRecord('x_daas_ham_device_event')
    gr.initialize()
    gr.setValue('asset', assetId)
    gr.setValue('identifier', event.identifier)
    gr.setValue('event', event.event)
    gr.setValue('source', event.source)
    gr.setValue('observed_at', msToGlide(event.observedAt))
    gr.insert()
}

/** Scheduled job: pick up Discovery / connector sightings of pending Assets and put them in service. */
export function evaluatePendingInService(): void {
    const readers = lifecycleReaders()
    runTableJob({
        job: 'in_service_detection',
        table: 'alm_hardware',
        query: stagesQuery(['pending_in_service']),
        read: (asset) => asset.getUniqueValue(),
        handle: (assetId) => {
            const asset = new GlideRecord('alm_hardware')
            if (!asset.get(assetId)) return
            const discovered = glideToMs(str(asset, 'ci.last_discovered'))
            if (discovered !== undefined) {
                recordSeen(asset, discovered, str(asset, 'ci.discovery_source') === 'ServiceNow' ? 'discovery' : 'connector')
            }
            goLiveIfSeen(asset, readers)
        },
    })
}

/** Daily job: drop device events older than the retention period. */
export function purgeDeviceEvents(): void {
    const cutoff = new GlideDateTime()
    cutoff.addDaysUTC(-intProperty(PROPERTY.eventsRetentionDays, 90))
    deleteWhere('x_daas_ham_device_event', `sys_created_on<${cutoff.getValue()}`)
}

