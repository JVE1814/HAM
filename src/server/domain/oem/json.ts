/** Tolerant readers for vendor JSON (shapes vary between API versions). */

export function parseJson(body: string): unknown {
    try {
        return JSON.parse(body)
    } catch {
        return undefined
    }
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

/** An ISO calendar date from "YYYY-MM-DD", an ISO timestamp, or epoch seconds / milliseconds. */
export function isoDate(value: unknown): string | undefined {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        const ms = value < 1e12 ? value * 1000 : value
        return new Date(ms).toISOString().slice(0, 10)
    }
    const raw = text(value)
    if (!raw) return undefined
    const match = raw.match(/^(\d{4}-\d{2}-\d{2})/)
    return match ? match[1] : undefined
}

export function chunks<T>(items: readonly T[], size: number): T[][] {
    const out: T[][] = []
    for (let i = 0; i < items.length; i += Math.max(1, size)) out.push(items.slice(i, i + Math.max(1, size)))
    return out
}
