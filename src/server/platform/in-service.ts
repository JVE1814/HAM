import { GlideRecord } from '@servicenow/glide'
import { isStateChange, type DeviceEvent } from '../domain/device-events.ts'
import { fleetStagesQuery } from '../domain/fleet.ts'
import { decideInService, seenSourceOf } from '../domain/in-service.ts'
import { LONG_HOLD_LOCK_TRIES, type HeldLock } from '../domain/job-lock.ts'
import { LOCK } from '../domain/lock-names.ts'
import type { OrderType, SeenSource } from '../domain/vocabulary.ts'
import { findAssetByIdentifier } from './asset-identifiers.ts'
import { moveAndSave, readStage } from './assets.ts'
import { runTableJob } from './chunked.ts'
import { daysAgoGlide, glideToMs, msToGlide } from './clock.ts'
import { applyLifecycleDates, lifecycleReaders, type LifecycleReaders } from './lifecycle-dates.ts'
import { withLockTries } from './locks.ts'
import { log } from './log.ts'
import { choice, deleteWhere, findById, refusal, str } from './records.ts'
import { attachToSubscription } from './subscriptions.ts'

/** In-service detection: Seen signals in, billing start out (P1.8), and the device events they are kept as. */

/** Record that an Asset was seen at `at` (only moves last_seen forward). */
function recordSeen(asset: GlideRecord, at: number, source: SeenSource): void {
    const previous = glideToMs(str(asset, 'x_daas_ham_last_seen'))
    if (previous !== undefined && previous >= at) return
    asset.setValue('x_daas_ham_last_seen', msToGlide(at))
    asset.setValue('x_daas_ham_seen_source', source)
}

/**
 * Put a pending Asset in service if it has been seen since its install, and save it. False when it saved nothing:
 * having outlasted its sighting `lock` (ADR 0013), as the sighting that took the lock over read the Asset after this
 * one, or because the save was refused (logged), so the sighting is applied again when sent again or at the next run.
 */
function goLiveIfSeen(lock: HeldLock, asset: GlideRecord, readers: LifecycleReaders): boolean {
    const stage = readStage(asset)
    const decision = decideInService({
        stage,
        installCompletedAt: glideToMs(str(asset, 'x_daas_ham_install_completed')),
        lastSeenAt: glideToMs(str(asset, 'x_daas_ham_last_seen')),
        // Only a pending Asset can go live, so only it pays for the dot-walk to its Order.
        temporary: stage === 'pending_in_service' && choice<OrderType>(asset, 'x_daas_ham_order_line.order.order_type') === 'temporary',
    })
    if (!lock.held()) return false
    // An Asset whose Subscription line could not be started stays pending, so a later sighting or run attaches it.
    if (!decision.goesLive || !attachToSubscription(asset, decision.at)) {
        if (asset.update()) return true
        log.error(`in-service detection: sighting of ${str(asset, 'serial_number')} not saved: ${refusal(asset)}`)
        return false
    }
    asset.setValue('x_daas_ham_in_service_date', msToGlide(decision.at))
    applyLifecycleDates(asset, readers)
    if (moveAndSave(asset, decision.stage, 'in-service detection')) return true
    // A line started above stays active: the sighting applied again finds it active and joins it, its start date kept.
    const pending = `${str(asset, 'serial_number')} stays pending in service, its Subscription line possibly active`
    log.error(`in-service detection: ${pending}: left to the next sighting or run`)
    return false
}

/**
 * Run `see` on the Asset read afresh, holding its sighting lock: true once `see` applied the sighting (or the Asset is
 * gone), false when another sighting held the lock through every try, or `see` found it lost before saving or had its
 * save refused. Two NMS batches, or a batch and the detection job, can see one Asset at once; each reading it before
 * the other saved, the later save would put back an older last_seen and in-service date, or move an Asset the other had
 * put in service (and since moved on) into service again. Taken before any other lock, by the sightings below only: a
 * go-live starts its Subscription line under the line's lock (platform/subscriptions) and its save's rule takes the
 * Asset's interval lock (platform/service-intervals), and a second take of a lock is refused. A holder keeps it for one
 * event and, on a go-live, the Asset's save and its rules. A lock that cannot be taken throws (platform/locks); that
 * error escapes.
 */
function underSeenLock(assetId: string, see: (lock: HeldLock, asset: GlideRecord) => boolean): boolean {
    const seen = withLockTries(
        LOCK.seenAsset(assetId),
        (lock) => {
            // Read past the visibility rules, as the identifier lookup finds it; its save runs every rule.
            const asset = findById('alm_hardware', assetId, { beyondVisibility: true })
            return !asset || see(lock, asset)
        },
        LONG_HOLD_LOCK_TRIES,
    )
    return seen.ran && seen.value
}

/**
 * Apply one NMS event to the Asset under its sighting lock: the event is stored when it is a state change, and a
 * sighting moves last_seen forward and puts a pending Asset in service. False when it was not wholly applied (see
 * `underSeenLock`), or the platform refused to store it (logged), for the NMS to send again. A down event is only
 * stored, so one refused would be lost once acknowledged; a refused event sent again has its sighting applied again,
 * which changes nothing.
 */
function applyDeviceEvent(assetId: string, event: DeviceEvent, readers: LifecycleReaders): boolean {
    return underSeenLock(assetId, (lock, asset) => {
        const stored = !isStateChange(event.event, () => lastEventKind(assetId)) || storeEvent(assetId, event)
        if (event.event === 'down') return stored
        recordSeen(asset, event.observedAt, event.source)
        return goLiveIfSeen(lock, asset, readers) && stored
    })
}

/**
 * Apply a batch of NMS events, each to the fleet asset its identifier names (platform/asset-identifiers
 * `findAssetByIdentifier`, ADR 0016). The identifiers no fleet asset carries, the Provider IT's included, are `unknown`
 * and stored as no event; those `busy` were not wholly applied (`applyDeviceEvent`), for the NMS to send again.
 */
export function applyDeviceEvents(events: readonly DeviceEvent[]): { unknown: string[]; busy: string[] } {
    const readers = lifecycleReaders()
    const unknown: string[] = []
    const busy: string[] = []
    for (const event of events) {
        const asset = findAssetByIdentifier(event.identifier, { beyondVisibility: true })
        if (!asset) unknown.push(event.identifier)
        else if (!applyDeviceEvent(asset.getUniqueValue(), event, readers)) busy.push(event.identifier)
    }
    return { unknown, busy }
}

/**
 * Apply what Discovery or a connector last saw of the Asset's CI, under its sighting lock, and put a pending Asset in
 * service. False when it was not applied (see `underSeenLock`): the next run reads the CI again.
 */
function applyCiSighting(assetId: string, readers: LifecycleReaders): boolean {
    return underSeenLock(assetId, (lock, asset) => {
        const discovered = glideToMs(str(asset, 'ci.last_discovered'))
        if (discovered !== undefined) recordSeen(asset, discovered, seenSourceOf(str(asset, 'ci.discovery_source')))
        return goLiveIfSeen(lock, asset, readers)
    })
}

/**
 * One chunk of the detection job (a scheduled chunked job): what Discovery or a connector last saw of each pending
 * fleet asset (ADR 0016) puts it in service.
 */
export function detectPendingInService(): void {
    const readers = lifecycleReaders()
    runTableJob({
        job: 'in_service_detection',
        table: 'alm_hardware',
        query: fleetStagesQuery(['pending_in_service']),
        read: (asset) => asset.getUniqueValue(),
        // An Asset whose lock an NMS event holds, or whose save is refused, is left to the next run, which reads its CI
        // again.
        handle: (assetId) => void applyCiSighting(assetId, readers),
    })
}

function lastEventKind(assetId: string): string {
    const gr = new GlideRecord('x_daas_ham_device_event')
    gr.addQuery('asset', assetId)
    gr.orderByDesc('observed_at')
    gr.setLimit(1)
    gr.query()
    return gr.next() ? str(gr, 'event') : ''
}

/** Store the event; false when the platform refuses it (logged as an error). */
function storeEvent(assetId: string, event: DeviceEvent): boolean {
    const gr = new GlideRecord('x_daas_ham_device_event')
    gr.initialize()
    gr.setValue('asset', assetId)
    gr.setValue('identifier', event.identifier)
    gr.setValue('event', event.event)
    gr.setValue('source', event.source)
    gr.setValue('observed_at', msToGlide(event.observedAt))
    if (gr.insert()) return true
    log.error(`in-service detection: ${event.event} event of ${event.identifier} not stored: ${refusal(gr)}`)
    return false
}

/** Drop the device events stored more than `retentionDays` ago. */
export function purgeDeviceEventsOlderThan(retentionDays: number): void {
    // What is left (deleteWhere says whether any is) is not checked: tomorrow's purge takes it.
    deleteWhere('x_daas_ham_device_event', `sys_created_on<${daysAgoGlide(retentionDays)}`)
}
