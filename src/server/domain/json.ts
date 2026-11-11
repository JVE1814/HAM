import { isIsoDate, toIsoDate } from './calendar.ts'

/** Tolerant readers for third-party JSON (vendor and aggregator shapes vary between API versions). */

export function parseJson(body: string): unknown {
    try {
        return JSON.parse(body)
    } catch {
        return undefined
    }
}

/** An object, not null, an array or a scalar: a body a vendor's envelope or fields can be read from. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function asArray(value: unknown): unknown[] {
    if (Array.isArray(value)) return value
    return value === undefined || value === null ? [] : [value]
}

export function field(value: unknown, ...path: string[]): unknown {
    let current = value
    for (const key of path) {
        if (current === null || typeof current !== 'object') return undefined
        current = (current as Record<string, unknown>)[key]
    }
    return current
}

export function text(value: unknown): string {
    return typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : ''
}

/** The last instant toISOString writes with a four-digit year: later ones read +YYYYYY-MM-DD, or throw past +275760. */
const LAST_ISO_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999)

/**
 * An ISO calendar date from "YYYY-MM-DD", an ISO timestamp, or epoch seconds / milliseconds. A day that does not exist
 * (2026-02-31, 2026-13-01) is no date: it would be stored and compared as one.
 */
export function isoDate(value: unknown): string | undefined {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        const ms = value < 1e12 ? value * 1000 : value
        return ms <= LAST_ISO_MS ? toIsoDate(ms) : undefined
    }
    const raw = text(value)
    if (!raw) return undefined
    const match = raw.match(/^(\d{4}-\d{2}-\d{2})/)
    return match && isIsoDate(match[1]) ? match[1] : undefined
}
