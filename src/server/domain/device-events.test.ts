import { describe, expect, it } from 'vitest'
import { parseDeviceEvents } from './device-events'

describe('parseDeviceEvents', () => {
    it('accepts a batch of well-formed events and normalises them', () => {
        const result = parseDeviceEvents(
            { events: [{ identifier: ' FOC1234X ', event: 'seen', observed_at: '2026-11-06T10:00:00Z' }] },
            100,
        )
        if ('error' in result) throw new Error(result.error)
        expect(result.rejected).toEqual([])
        expect(result.events).toEqual([{ identifier: 'FOC1234X', event: 'seen', observedAt: Date.parse('2026-11-06T10:00:00Z'), source: 'nms' }])
    })

    it('rejects individual malformed events but keeps the rest', () => {
        const result = parseDeviceEvents(
            {
                events: [
                    { identifier: '', event: 'seen', observed_at: '2026-11-06T10:00:00Z' },
                    { identifier: 'A', event: 'exploded', observed_at: '2026-11-06T10:00:00Z' },
                    { identifier: 'B', event: 'down', observed_at: 'yesterday' },
                    { identifier: 'C', event: 'up', observed_at: '2026-11-06T10:00:00Z', source: 'connector' },
                ],
            },
            100,
        )
        if ('error' in result) throw new Error(result.error)
        expect(result.events.map((e) => e.identifier)).toEqual(['C'])
        expect(result.rejected).toEqual([
            { index: 0, reason: 'identifier is required' },
            { index: 1, reason: 'event must be one of seen, down, up' },
            { index: 2, reason: 'observed_at must be an ISO-8601 timestamp' },
        ])
    })

    it('refuses a body without an events array or a batch that is too large', () => {
        expect(parseDeviceEvents({}, 10)).toEqual({ error: 'Body must be { "events": [...] }' })
        expect(parseDeviceEvents({ events: new Array(11).fill({}) }, 10)).toEqual({ error: 'At most 10 events per request' })
    })
})
