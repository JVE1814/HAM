import { describe, expect, it } from 'vitest'
import { parseDeviceEvents } from './device-events'

const NOW = Date.parse('2026-11-06T12:00:00Z')

describe('parseDeviceEvents', () => {
    it('accepts a batch of well-formed events and normalises them', () => {
        const result = parseDeviceEvents(
            { events: [{ identifier: ' FOC1234X ', event: 'seen', observed_at: '2026-11-06T10:00:00Z' }] },
            100,
            NOW,
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
            NOW,
        )
        if ('error' in result) throw new Error(result.error)
        expect(result.events.map((e) => e.identifier)).toEqual(['C'])
        expect(result.rejected).toEqual([
            { index: 0, reason: 'identifier is required' },
            { index: 1, reason: 'event must be one of seen, down, up' },
            { index: 2, reason: 'observed_at must be an ISO-8601 timestamp with a UTC offset, such as 2026-11-06T10:00:00Z' },
        ])
    })

    it('reads ISO-8601 timestamps to the minute, second or fraction, with Z or a UTC offset', () => {
        const at = (observed_at: string) => {
            const result = parseDeviceEvents({ events: [{ identifier: 'A', event: 'seen', observed_at }] }, 10, NOW)
            if ('error' in result) throw new Error(result.error)
            return result.events[0]?.observedAt
        }
        expect(at('2026-11-06T10:00Z')).toBe(Date.parse('2026-11-06T10:00:00Z'))
        expect(at('2026-11-06T10:00:00.25Z')).toBe(Date.parse('2026-11-06T10:00:00.250Z'))
        expect(at('2026-11-06T10:00:00.123456789Z')).toBe(Date.parse('2026-11-06T10:00:00.123Z'))
        expect(at('2026-11-06T11:30:00+01:30')).toBe(Date.parse('2026-11-06T10:00:00Z'))
        expect(at('2026-11-06T05:00:00-0500')).toBe(Date.parse('2026-11-06T10:00:00Z'))
        expect(at('2026-11-06T00:30:00+01:00')).toBe(Date.parse('2026-11-05T23:30:00Z'))
        expect(at('2024-02-29T10:00:00Z')).toBe(Date.parse('2024-02-29T10:00:00Z'))
    })

    it('rejects timestamps Date.parse would take that are not ISO-8601 with an offset, and impossible dates or times', () => {
        const values = [
            '11/06/2026 10:00',
            '2026/11/06 10:00:00',
            'Fri, 06 Nov 2026 10:00:00 GMT',
            'November 6, 2026 10:00 UTC',
            '2026-11-06',
            '2026-11-06T10:00:00',
            '2026-11-06 10:00:00Z',
            '2026-02-31T10:00:00Z',
            '2025-02-29T10:00:00Z',
            '2026-13-01T10:00:00Z',
            '2026-11-00T10:00:00Z',
            '2026-11-06T24:00:00Z',
            '2026-11-06T10:60:00Z',
            '2026-11-06T10:00:60Z',
            '2026-11-06T10:00:00+24:00',
            '2026-11-06T10:00:00+01:60',
            ' 2026-11-06T10:00:00Z',
        ]
        const result = parseDeviceEvents({ events: values.map((observed_at) => ({ identifier: 'A', event: 'seen', observed_at })) }, 100, NOW)
        if ('error' in result) throw new Error(result.error)
        expect(result.events).toEqual([])
        expect(result.rejected.map((r) => r.index)).toEqual(values.map((_, index) => index))
        expect(new Set(result.rejected.map((r) => r.reason))).toEqual(new Set(['observed_at must be an ISO-8601 timestamp with a UTC offset, such as 2026-11-06T10:00:00Z']))
    })

    it('rejects an observed_at that is not a string', () => {
        const result = parseDeviceEvents({ events: [{ identifier: 'A', event: 'seen', observed_at: Date.parse('2026-11-06T10:00:00Z') }] }, 10, NOW)
        if ('error' in result) throw new Error(result.error)
        expect(result.rejected).toEqual([{ index: 0, reason: 'observed_at must be an ISO-8601 timestamp with a UTC offset, such as 2026-11-06T10:00:00Z' }])
    })

    it('refuses a body without an events array or a batch that is too large', () => {
        expect(parseDeviceEvents({}, 10, NOW)).toEqual({ error: 'Body must be { "events": [...] }' })
        expect(parseDeviceEvents({ events: new Array(11).fill({}) }, 10, NOW)).toEqual({ error: 'At most 10 events per request' })
    })

    it('rejects events observed in the future (beyond clock skew)', () => {
        const result = parseDeviceEvents(
            {
                events: [
                    { identifier: 'A', event: 'seen', observed_at: '2026-11-06T12:04:00Z' },
                    { identifier: 'B', event: 'seen', observed_at: '2026-11-06T13:00:00Z' },
                ],
            },
            10,
            NOW,
        )
        if ('error' in result) throw new Error(result.error)
        expect(result.events.map((e) => e.identifier)).toEqual(['A'])
        expect(result.rejected).toEqual([{ index: 1, reason: 'observed_at is in the future' }])
    })

    it('gives the events oldest first, so a later sighting listed first does not put a unit in service late', () => {
        const result = parseDeviceEvents(
            {
                events: [
                    { identifier: 'A', event: 'seen', observed_at: '2026-11-06T09:00:00Z' },
                    { identifier: 'A', event: 'seen', observed_at: '2026-11-05T09:00:00Z' },
                    { identifier: 'B', event: 'bogus', observed_at: '2026-11-04T09:00:00Z' },
                    { identifier: 'A', event: 'down', observed_at: '2026-11-05T10:00:00+01:00' },
                ],
            },
            10,
            NOW,
        )
        if ('error' in result) throw new Error(result.error)
        expect(result.events.map((e) => [e.event, new Date(e.observedAt).toISOString()])).toEqual([
            ['seen', '2026-11-05T09:00:00.000Z'],
            ['down', '2026-11-05T09:00:00.000Z'],
            ['seen', '2026-11-06T09:00:00.000Z'],
        ])
        // A rejected event keeps its index in the batch as sent.
        expect(result.rejected).toEqual([{ index: 2, reason: 'event must be one of seen, down, up' }])
    })

    it('keeps events observed at the same instant in their order in the batch', () => {
        const at = '2026-11-06T10:00:00Z'
        const kinds = ['down', 'up', 'seen', 'down', 'up'] as const
        const result = parseDeviceEvents({ events: kinds.map((event) => ({ identifier: 'A', event, observed_at: at })) }, 10, NOW)
        if ('error' in result) throw new Error(result.error)
        expect(result.events.map((e) => e.event)).toEqual([...kinds])
    })
})
