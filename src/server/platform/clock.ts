import { GlideDateTime } from '@servicenow/glide'
import { DAY_MS, toIsoDate } from '../domain/calendar.ts'

/** Conversions between Glide date/time values (UTC "yyyy-MM-dd HH:mm:ss") and domain values. */

export function nowMs(): number {
    return new GlideDateTime().getNumericValue()
}

export function nowGlide(): string {
    return msToGlide(nowMs())
}

export function daysAgoGlide(days: number): string {
    return msToGlide(nowMs() - days * DAY_MS)
}

export function todayIso(): string {
    return toIsoDate(nowMs())
}

/** Epoch ms of a stored date/time value, or undefined when it is empty or unreadable. */
export function glideToMs(value: string): number | undefined {
    if (!value) return undefined
    const ms = Date.parse(`${value.replace(' ', 'T')}Z`)
    return Number.isNaN(ms) ? undefined : ms
}

/** The calendar date (YYYY-MM-DD, UTC) of a stored date/time value, or undefined when it is empty or unreadable. */
export function glideToIsoDate(value: string): string | undefined {
    const ms = glideToMs(value)
    return ms === undefined ? undefined : toIsoDate(ms)
}

export function msToGlide(ms: number): string {
    return new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
}
