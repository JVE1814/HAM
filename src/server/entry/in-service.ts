import type { RESTAPIRequest, RESTAPIResponse } from '@servicenow/glide/sn_ws_int'
import { parseDeviceEvents } from '../domain/device-events.ts'
import { PROPERTY } from '../domain/properties.ts'
import { ROLE } from '../domain/roles.ts'
import { findAssetByIdentifier } from '../platform/assets.ts'
import { nowMs } from '../platform/clock.ts'
import { applyDeviceEvent, purgeDeviceEventsOlderThan } from '../platform/in-service.ts'
import { lifecycleReaders } from '../platform/lifecycle-dates.ts'
import { intProperty } from '../platform/properties.ts'
import { reply, requireRole } from '../platform/rest-api.ts'

/** In-service detection: Seen signals in, billing start out (P1.8). */

/**
 * POST /api/x_daas_ham/naas/device_events - Seen signals from the Provider NMS. An identifier is matched to a fleet
 * asset only (platform/assets `findAssetByIdentifier`, ADR 0016): one the Provider IT's equipment carries, like one no
 * Asset carries, is reported in `unknown_identifiers` and stored as no event.
 */
export function postDeviceEvents(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!requireRole(response, [ROLE.integration, ROLE.assetManager], 'Requires the x_daas_ham.integration role')) return
    const parsed = parseDeviceEvents(request.body.data, intProperty(PROPERTY.eventsMaxBatch), nowMs())
    if ('error' in parsed) return reply(response, 400, { error: parsed.error })
    const readers = lifecycleReaders()
    const unknown: string[] = []
    // Not applied, as another request held their Asset's lock through every try, its save was refused or its event was
    // not stored: for the NMS to send again.
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

export function purgeDeviceEvents(): void {
    purgeDeviceEventsOlderThan(intProperty(PROPERTY.eventsRetentionDays))
}
