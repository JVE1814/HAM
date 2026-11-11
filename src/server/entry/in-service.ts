import type { RESTAPIRequest, RESTAPIResponse } from '@servicenow/glide/sn_ws_int'
import { parseDeviceEvents } from '../domain/device-events.ts'
import { PROPERTY } from '../domain/properties.ts'
import { ROLE } from '../domain/roles.ts'
import { nowMs } from '../platform/clock.ts'
import { applyDeviceEvents, purgeDeviceEventsOlderThan } from '../platform/in-service.ts'
import { intProperty } from '../platform/properties.ts'
import { reply, requireRole } from '../platform/rest-api.ts'

/** In-service detection: Seen signals in, billing start out (P1.8). */

/** POST /api/x_daas_ham/naas/device_events - Seen signals from the Provider NMS (platform/in-service `applyDeviceEvents`). */
export function postDeviceEvents(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!requireRole(response, [ROLE.integration, ROLE.assetManager], 'Requires the x_daas_ham.integration role')) return
    const parsed = parseDeviceEvents(request.body.data, intProperty(PROPERTY.eventsMaxBatch), nowMs())
    if ('error' in parsed) return reply(response, 400, { error: parsed.error })
    const { unknown, busy } = applyDeviceEvents(parsed.events)
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
