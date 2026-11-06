import { GlideDateTime } from '@servicenow/glide'
import { toIsoDate } from '../domain/calendar'

/** Conversions between Glide date/time values (UTC "yyyy-MM-dd HH:mm:ss") and domain values. */

export function nowMs(): number {
    return new GlideDateTime().getNumericValue()
}

export function todayIso(): string {
    return toIsoDate(nowMs())
}

/** Epoch ms of a stored date/time value, or undefined when empty. */
export function glideToMs(value: string): number | undefined {
    if (!value) return undefined
    const ms = Date.parse(`${value.replace(' ', 'T')}Z`)
    return Number.isNaN(ms) ? undefined : ms
}

export function msToGlide(ms: number): string {
    return new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
}
