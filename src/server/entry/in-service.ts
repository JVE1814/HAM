import { gs } from '@servicenow/glide'
import type { RESTAPIRequest, RESTAPIResponse } from '@servicenow/glide/sn_ws_int'
import { parseDeviceEvents } from '../domain/device-events.ts'
import { fleetStagesQuery } from '../domain/fleet.ts'
import { ROLE } from '../domain/visibility.ts'
import { findAssetByIdentifier } from '../platform/assets.ts'
import { runTableJob } from '../platform/chunked.ts'
import { nowMs } from '../platform/clock.ts'
import { applyCiSighting, applyDeviceEvent, purgeDeviceEventsOlderThan } from '../platform/in-service.ts'
import { lifecycleReaders } from '../platform/lifecycle-dates.ts'
import { intProperty, PROPERTY } from '../platform/properties.ts'
import { reply } from '../platform/rest-api.ts'

/** In-service detection: Seen signals in, billing start out (P1.8). */

/**
 * POST /api/x_daas_ham/naas/v1/device_events - Seen signals from the Provider NMS. An identifier is matched to a fleet
 * asset only (platform/assets `findAssetByIdentifier`, ADR 0016): one the Provider IT's equipment carries, like one no
 * Asset carries, is reported in `unknown_identifiers` and stored as no event.
 */
export function postDeviceEvents(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!gs.hasRole(ROLE.integration) && !gs.hasRole(ROLE.assetManager)) return reply(response, 403, { error: 'Requires the x_daas_ham.integration role' })
    const parsed = parseDeviceEvents(request.body.data, intProperty(PROPERTY.eventsMaxBatch, 500), nowMs())
    if ('error' in parsed) return reply(response, 400, { error: parsed.error })
    const readers = lifecycleReaders()
    const unknown: string[] = []
    // Not applied, as another request held their Asset's lock through every try or its save was refused: for the NMS to
    // send again.
    const busy: string[] = []
    for (const event of parsed.events) {
        const asset = findAssetByIdentifier(event.identifier, { beyondVisibility: true })
        if (!asset) {
            unknown.push(event.identifier)
            continue
        }
        if (!applyDeviceEvent(asset.getUniqueValue(), event, readers)) busy.push(event.identifier)
    }
    reply(response, 202, {
        accepted: parsed.events.length - unknown.length - busy.length,
        unknown_identifiers: unknown,
        busy_identifiers: busy,
        rejected: parsed.rejected,
    })
}

/**
 * Scheduled job: pick up Discovery / connector sightings of pending fleet assets (ADR 0016) and put them in service.
 */
export function evaluatePendingInService(): void {
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

/** Daily job: drop device events older than the retention period. */
export function purgeDeviceEvents(): void {
    purgeDeviceEventsOlderThan(intProperty(PROPERTY.eventsRetentionDays, 90))
}
