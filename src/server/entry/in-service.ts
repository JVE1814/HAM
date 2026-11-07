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
import { withLockTries, type HeldLock } from '../platform/locks'
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

/**
 * Put a pending Asset in service if it has been seen since its install, and save it. False when it saved nothing,
 * having outlasted its sighting `lock` (ADR 0013): the sighting that took the lock over read the Asset after this one.
 */
function goLiveIfSeen(lock: HeldLock, asset: GlideRecord, readers: LifecycleReaders): boolean {
    const stage = readStage(asset)
    const decision = decideInService({
        stage,
        installCompletedAt: glideToMs(str(asset, 'x_daas_ham_install_completed')),
        lastSeenAt: glideToMs(str(asset, 'x_daas_ham_last_seen')),
        // Only a pending Asset can go live, so only it pays for the dot-walk to its Order.
        temporary: stage === 'pending_in_service' && str(asset, 'x_daas_ham_order_line.order.order_type') === 'temporary',
    })
    if (!lock.held()) return false
    // An Asset whose Subscription line could not be started stays pending, so a later sighting or run attaches it.
    if (!decision.goesLive || !attachToSubscription(asset, decision.at)) {
        asset.update()
        return true
    }
    asset.setValue('x_daas_ham_in_service_date', msToGlide(decision.at))
    applyLifecycleDates(asset, readers)
    moveAndSave(asset, decision.stage, 'in-service detection')
    return true
}

/**
 * Tries at taking an Asset's sighting lock: a holder keeps it for one event and, on a go-live, the Asset's save and its
 * rules, so as many as an Order line's.
 */
const SEEN_LOCK_TRIES = 10

/**
 * Run `see` on the Asset read afresh, holding its sighting lock `seen_asset_<sys_id>`: true once `see` applied the
 * sighting (or the Asset is gone), false when another sighting held the lock through every try, or `see` found it lost
 * before saving. Two NMS batches, or a batch and the detection job, can see one Asset at once; each reading it before
 * the other saved, the later save would put back an older last_seen and in-service date, or move an Asset the other had
 * put in service (and since moved on) into service again. Taken before any other lock, by these entry points only: a
 * go-live starts its Subscription line under the line's lock (platform/subscriptions) and its save's rule takes the
 * Asset's interval lock (platform/service-intervals), and a second take of a lock is refused. A lock that cannot be
 * taken throws (platform/locks); that error escapes.
 */
function underSeenLock(assetId: string, see: (lock: HeldLock, asset: GlideRecord) => boolean): boolean {
    // Set inside the lock.
    let applied = false as boolean
    const ran = withLockTries(`seen_asset_${assetId}`, SEEN_LOCK_TRIES, (lock) => {
        const asset = freshAsset(assetId)
        applied = !asset || see(lock, asset)
    })
    return ran && applied
}

/** The Asset read past the before-query rules, as the identifier lookup finds it; rules back on for its save. */
function freshAsset(assetId: string): GlideRecord | null {
    const asset = new GlideRecord('alm_hardware')
    asset.setWorkflow(false)
    const found = asset.get(assetId)
    asset.setWorkflow(true)
    return found ? asset : null
}

/** POST /api/x_daas_ham/naas/v1/device_events - Seen signals from the Provider NMS. */
export function postDeviceEvents(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!gs.hasRole(ROLE.integration) && !gs.hasRole(ROLE.assetManager)) return reply(response, 403, { error: 'Requires the x_daas_ham.integration role' })
    const parsed = parseDeviceEvents(request.body.data, intProperty(PROPERTY.eventsMaxBatch, 500), nowMs())
    if ('error' in parsed) return reply(response, 400, { error: parsed.error })
    const readers = lifecycleReaders()
    const unknown: string[] = []
    // Not applied, as another request held their Asset's lock through every try: for the NMS to send again.
    const busy: string[] = []
    for (const event of parsed.events) {
        const asset = findAssetByIdentifier(event.identifier, { beyondVisibility: true })
        if (!asset) {
            unknown.push(event.identifier)
            continue
        }
        const applied = underSeenLock(asset.getUniqueValue(), (lock, fresh) => applyEvent(lock, fresh, event, readers))
        if (!applied) busy.push(event.identifier)
    }
    reply(response, 202, {
        accepted: parsed.events.length - unknown.length - busy.length,
        unknown_identifiers: unknown,
        busy_identifiers: busy,
        rejected: parsed.rejected,
    })
}

/** Apply one event holding the Asset's sighting `lock` (see goLiveIfSeen for false). */
function applyEvent(lock: HeldLock, asset: GlideRecord, event: DeviceEvent, readers: LifecycleReaders): boolean {
    const assetId = asset.getUniqueValue()
    if (event.event !== 'seen' || lastEventKind(assetId) !== 'seen') storeEvent(assetId, event)
    if (event.event === 'down') return true
    recordSeen(asset, event.observedAt, event.source)
    return goLiveIfSeen(lock, asset, readers)
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
        // An Asset whose lock an NMS event holds is left to the next run, which reads its CI again.
        handle: (assetId) => {
            underSeenLock(assetId, (lock, asset) => {
                const discovered = glideToMs(str(asset, 'ci.last_discovered'))
                if (discovered !== undefined) {
                    const source = str(asset, 'ci.discovery_source') === 'ServiceNow' ? 'discovery' : 'connector'
                    recordSeen(asset, discovered, source)
                }
                return goLiveIfSeen(lock, asset, readers)
            })
        },
    })
}

/** Daily job: drop device events older than the retention period. */
export function purgeDeviceEvents(): void {
    const cutoff = new GlideDateTime()
    cutoff.addDaysUTC(-intProperty(PROPERTY.eventsRetentionDays, 90))
    deleteWhere('x_daas_ham_device_event', `sys_created_on<${cutoff.getValue()}`)
}

