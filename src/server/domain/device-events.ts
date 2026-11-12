import { ROLE } from './roles.ts'
import { DEVICE_EVENT_KIND_CHOICES, DEVICE_EVENT_SOURCE_CHOICES, type DeviceEventKind, type DeviceEventSource } from './vocabulary.ts'

/** Who posts Seen signals to the device-events route, and so creates device events: the Provider NMS, and asset managers. */
export const DEVICE_EVENT_SENDERS = [ROLE.integration, ROLE.assetManager]

export const DEFAULT_DEVICE_EVENT_SOURCE: DeviceEventSource = 'nms'

export interface DeviceEvent {
    /** Serial number, Provider tag or Customer tag of the Asset. */
    identifier: string
    event: DeviceEventKind
    observedAt: number
    source: DeviceEventSource
}

export type ParsedEvents =
    | { events: DeviceEvent[]; rejected: Array<{ index: number; reason: string }> }
    | { error: string }

const KINDS = Object.keys(DEVICE_EVENT_KIND_CHOICES) as DeviceEventKind[]
const SOURCES = Object.keys(DEVICE_EVENT_SOURCE_CHOICES) as DeviceEventSource[]

/** Monitoring clocks may run slightly ahead; anything further in the future is rejected. */
const MAX_CLOCK_SKEW_MS = 5 * 60_000

const OBSERVED_AT_FORMAT = 'observed_at must be an ISO-8601 timestamp with a UTC offset, such as 2026-11-06T10:00:00Z'

/**
 * The ISO-8601 timestamps observed_at may hold: a date and a time to the minute, second or fraction of a second, with
 * its UTC offset (Z, ±hh:mm or ±hhmm), such as 2026-11-06T10:00:00Z or 2026-11-06T11:00:00.250+01:00. Date.parse is
 * not used for this: it also takes other formats (11/06/2026 10:00) and reads a time without an offset in the server's
 * time zone.
 */
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(?:Z|([+-])(\d{2}):?(\d{2}))$/

/**
 * The events of a batch, validated (a malformed one is rejected by its index in the batch) and in the order they were
 * observed, oldest first: last_seen only moves forward (platform/in-service), so a batch listing a later sighting before an
 * earlier one would otherwise put a pending Asset in service at the later one, its first days unbilled. Events observed
 * at the same instant keep their order in the batch.
 */
export function parseDeviceEvents(body: unknown, maxBatch: number, now: number): ParsedEvents {
    const raw = (body as { events?: unknown } | null)?.events
    if (!Array.isArray(raw)) return { error: 'Body must be { "events": [...] }' }
    if (raw.length > maxBatch) return { error: `At most ${maxBatch} events per request` }

    const accepted: Array<{ event: DeviceEvent; index: number }> = []
    const rejected: Array<{ index: number; reason: string }> = []
    raw.forEach((item: Record<string, unknown>, index) => {
        const identifier = typeof item?.identifier === 'string' ? item.identifier.trim() : ''
        const event = item?.event as DeviceEventKind
        const observedAt = typeof item?.observed_at === 'string' ? parseTimestamp(item.observed_at) : NaN
        const source = (item?.source ?? DEFAULT_DEVICE_EVENT_SOURCE) as DeviceEventSource
        if (!identifier) return void rejected.push({ index, reason: 'identifier is required' })
        if (!KINDS.includes(event)) return void rejected.push({ index, reason: `event must be one of ${KINDS.join(', ')}` })
        if (Number.isNaN(observedAt)) return void rejected.push({ index, reason: OBSERVED_AT_FORMAT })
        if (observedAt > now + MAX_CLOCK_SKEW_MS) return void rejected.push({ index, reason: 'observed_at is in the future' })
        if (!SOURCES.includes(source)) return void rejected.push({ index, reason: `source must be one of ${SOURCES.join(', ')}` })
        accepted.push({ event: { identifier, event, observedAt, source }, index })
    })
    // The index breaks ties, so the order does not rest on the engine's sort being stable.
    accepted.sort((a, b) => a.event.observedAt - b.event.observedAt || a.index - b.index)
    return { events: accepted.map(({ event }) => event), rejected }
}

/**
 * The instant an ISO_TIMESTAMP names, in epoch milliseconds (fractions past the millisecond are dropped), or NaN when
 * `value` is not one or names a time that does not exist, such as 2026-02-31 or 24:00, which are refused rather than
 * rolled over.
 */
function parseTimestamp(value: string): number {
    const match = ISO_TIMESTAMP.exec(value)
    if (!match) return NaN
    const [year, month, day, hour, minute, second] = match.slice(1, 7).map((part) => Number(part ?? 0))
    const millis = Number((match[7] ?? '').padEnd(3, '0').slice(0, 3))
    const [offsetHours, offsetMinutes] = [Number(match[9] ?? 0), Number(match[10] ?? 0)]
    if (hour > 23 || minute > 59 || second > 59 || offsetHours > 23 || offsetMinutes > 59) return NaN
    // setUTCFullYear, unlike Date.UTC, keeps a year below 100 as written; a day past the month's end rolls over and is refused.
    const date = new Date(0)
    date.setUTCFullYear(year, month - 1, day)
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return NaN
    date.setUTCHours(hour, minute, second, millis)
    const offset = (match[8] === '-' ? -1 : 1) * (offsetHours * 60 + offsetMinutes) * 60_000
    return date.getTime() - offset
}

/**
 * Whether an event is stored: device events keep state changes only, so a sighting that follows a stored sighting adds
 * nothing.
 */
export function isStateChange(kind: DeviceEventKind, lastStored: () => string): boolean {
    return kind !== 'seen' || lastStored() !== 'seen'
}
