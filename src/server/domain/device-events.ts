/** Seen signals posted by the Provider's NMS (validated before anything touches the database). */

export type DeviceEventKind = 'seen' | 'down' | 'up'
export type SeenSource = 'discovery' | 'connector' | 'nms'

export interface DeviceEvent {
    /** Serial number, Provider tag or Customer tag of the Asset. */
    identifier: string
    event: DeviceEventKind
    observedAt: number
    source: SeenSource
}

export type ParsedEvents =
    | { events: DeviceEvent[]; rejected: Array<{ index: number; reason: string }> }
    | { error: string }

const KINDS: readonly DeviceEventKind[] = ['seen', 'down', 'up']
const SOURCES: readonly SeenSource[] = ['discovery', 'connector', 'nms']

export function parseDeviceEvents(body: unknown, maxBatch: number): ParsedEvents {
    const raw = (body as { events?: unknown } | null)?.events
    if (!Array.isArray(raw)) return { error: 'Body must be { "events": [...] }' }
    if (raw.length > maxBatch) return { error: `At most ${maxBatch} events per request` }

    const events: DeviceEvent[] = []
    const rejected: Array<{ index: number; reason: string }> = []
    raw.forEach((item: Record<string, unknown>, index) => {
        const identifier = typeof item?.identifier === 'string' ? item.identifier.trim() : ''
        const event = item?.event as DeviceEventKind
        const observedAt = typeof item?.observed_at === 'string' ? Date.parse(item.observed_at) : NaN
        const source = (item?.source ?? 'nms') as SeenSource
        if (!identifier) return void rejected.push({ index, reason: 'identifier is required' })
        if (!KINDS.includes(event)) return void rejected.push({ index, reason: 'event must be one of seen, down, up' })
        if (Number.isNaN(observedAt)) return void rejected.push({ index, reason: 'observed_at must be an ISO-8601 timestamp' })
        if (!SOURCES.includes(source)) return void rejected.push({ index, reason: 'source must be one of discovery, connector, nms' })
        events.push({ identifier, event, observedAt, source })
    })
    return { events, rejected }
}
