import { GlideDateTime, GlideRecord, gs } from '@servicenow/glide'
import type { RESTAPIRequest, RESTAPIResponse } from '@servicenow/glide/sn_ws_int'
import { parseDeviceEvents, type DeviceEvent } from '../domain/device-events'
import { decideInService } from '../domain/in-service'
import { stagesQuery } from '../domain/lifecycle'
import { ROLE } from '../domain/visibility'
import { findAssetByIdentifier, moveAndSave, readStage } from '../platform/assets'
import { runTableJob } from '../platform/chunked'
import { glideToMs, msToGlide, nowMs } from '../platform/clock'
import { applyLifecycleDates, modelLifecycles, type ModelLifecycles } from '../platform/lifecycle-dates'
import { intProperty, PROPERTY } from '../platform/properties'
import { str } from '../platform/records'
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
function goLiveIfSeen(asset: GlideRecord, lifecycles: ModelLifecycles): void {
    const decision = decideInService({
        stage: readStage(asset),
        installCompletedAt: glideToMs(str(asset, 'x_daas_ham_install_completed')),
        lastSeenAt: glideToMs(str(asset, 'x_daas_ham_last_seen')),
        temporary: str(asset, 'x_daas_ham_order_line.order.order_type') === 'temporary',
    })
    if (!decision.goesLive) {
        asset.update()
        return
    }
    asset.setValue('x_daas_ham_in_service_date', msToGlide(decision.at))
    attachToSubscription(asset, decision.at)
    applyLifecycleDates(asset, lifecycles)
    moveAndSave(asset, decision.stage, 'in-service detection')
}

/** POST /api/x_daas_ham/naas/v1/device_events - Seen signals from the Provider NMS. */
export function postDeviceEvents(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!gs.hasRole(ROLE.integration) && !gs.hasRole(ROLE.assetManager)) {
        response.setStatus(403)
        response.setBody({ error: 'Requires the x_daas_ham.integration role' } as never)
        return
    }
    const parsed = parseDeviceEvents(request.body.data, intProperty(PROPERTY.eventsMaxBatch, 500), nowMs())
    if ('error' in parsed) {
        response.setStatus(400)
        response.setBody({ error: parsed.error } as never)
        return
    }
    const lifecycles = modelLifecycles()
    const unknown: string[] = []
    for (const event of parsed.events) {
        const asset = findAssetByIdentifier(event.identifier, { beyondVisibility: true })
        if (!asset) {
            unknown.push(event.identifier)
            continue
        }
        applyEvent(asset, event, lifecycles)
    }
    response.setStatus(202)
    response.setBody({
        accepted: parsed.events.length - unknown.length,
        unknown_identifiers: unknown,
        rejected: parsed.rejected,
    } as never)
}

function applyEvent(asset: GlideRecord, event: DeviceEvent, lifecycles: ModelLifecycles): void {
    const lastKind = lastEventKind(asset.getUniqueValue())
    if (event.event !== 'seen' || lastKind !== 'seen') storeEvent(asset.getUniqueValue(), event)
    if (event.event === 'down') return
    recordSeen(asset, event.observedAt, event.source)
    goLiveIfSeen(asset, lifecycles)
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
    const lifecycles = modelLifecycles()
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
            goLiveIfSeen(asset, lifecycles)
        },
    })
}

/** Daily job: drop device events older than the retention period. */
export function purgeDeviceEvents(): void {
    const cutoff = new GlideDateTime()
    cutoff.addDaysUTC(-intProperty(PROPERTY.eventsRetentionDays, 90))
    const gr = new GlideRecord('x_daas_ham_device_event')
    gr.addQuery('sys_created_on', '<', cutoff.getValue())
    gr.deleteMultiple()
}

