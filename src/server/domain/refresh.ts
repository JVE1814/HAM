import { firstBest } from './collections.ts'
import { andEachClause } from './encoded-query.ts'
import type { LifecycleDates } from './model-lifecycle.ts'

/** Hardware refresh (P2.2, Q48): which Assets go together and what replaces them. */

export interface RefreshCandidate {
    assetId: string
    agreementId: string
    customerId: string
    siteId: string
    modelId: string
    deviceClass: string
}

export interface RefreshWave {
    agreementId: string
    customerId: string
    siteId: string
    assets: RefreshCandidate[]
}

/** An Asset's place in the read of those due: by refresh due date, then by sys_id. */
export interface DueKey {
    /** Its refresh due date (YYYY-MM-DD). */
    due: string
    /** Its sys_id. */
    id: string
}

/** The Asset field that holds its refresh due date (a date, compared as YYYY-MM-DD). */
export const REFRESH_DUE_FIELD = 'x_daas_ham_refresh_due'

/**
 * `query` narrowed to the Assets after `after` in (refresh due, sys_id) order: due later, or due the same day with a
 * later sys_id. Each half is ANDed into every ^NQ clause, so every clause keeps its own conditions (the fleet one too).
 */
export function dueAfter(query: string, after: DueKey | null): string {
    if (!after) return query
    const later = andEachClause(query, `${REFRESH_DUE_FIELD}>${after.due}`)
    const sameDay = andEachClause(query, `${REFRESH_DUE_FIELD}=${after.due}^sys_id>${after.id}`)
    return `${later}^NQ${sameDay}`
}

/** An Asset read among those due: its key, and its candidate, or null when it is already on an open replacing line. */
export interface DueRow {
    key: DueKey
    candidate: RefreshCandidate | null
}

/**
 * Up to `limit` candidates, earliest due first, read `limit` Assets at a time (`readPage`, after the last one read) past
 * those already on order: however many of the earliest due wait on open Orders, the later ones still come. Reading
 * stops at the end of the Assets due, or after a page once `outOfTime`.
 */
export function firstCandidatesDue(readPage: (after: DueKey | null, size: number) => DueRow[], limit: number, outOfTime: () => boolean): RefreshCandidate[] {
    const found: RefreshCandidate[] = []
    let after: DueKey | null = null
    for (;;) {
        const page = readPage(after, limit)
        for (const { key, candidate } of page) {
            if (candidate) found.push(candidate)
            if (found.length >= limit) return found
            after = key
        }
        if (page.length < limit || outOfTime()) return found
    }
}

/** One refresh Order per Agreement and Site, in first-seen order. */
export function refreshWaves(candidates: readonly RefreshCandidate[]): RefreshWave[] {
    const waves = new Map<string, RefreshWave>()
    for (const candidate of candidates) {
        const key = `${candidate.agreementId}|${candidate.siteId}`
        const wave = waves.get(key) ?? { agreementId: candidate.agreementId, customerId: candidate.customerId, siteId: candidate.siteId, assets: [] }
        wave.assets.push(candidate)
        waves.set(key, wave)
    }
    return [...waves.values()]
}

/**
 * The model to refresh to: the same one while the Customer may still order it and it is still sold,
 * otherwise the catalogued model of the same Device class with the latest end of support. A model whose end of
 * support is not known (not synced from its OEM yet, or with no date given) ranks after every model with one, in
 * catalog order: its support is unknown, not unlimited, so a model with known dates is preferred.
 */
export function replacementModel(
    current: { modelId: string; deviceClass: string },
    catalog: ReadonlyArray<{ modelId: string; deviceClass: string }>,
    lifecycle: ReadonlyMap<string, LifecycleDates>,
    today: string,
): string | null {
    const sellable = (modelId: string) => {
        const endOfSale = lifecycle.get(modelId)?.endOfSale
        return !endOfSale || endOfSale > today
    }
    if (catalog.some((c) => c.modelId === current.modelId) && sellable(current.modelId)) return current.modelId
    const endOfSupport = (modelId: string) => lifecycle.get(modelId)?.endOfSupport ?? ''
    const options = catalog.filter((c) => c.deviceClass === current.deviceClass && sellable(c.modelId))
    return firstBest(options, (a, b) => endOfSupport(a.modelId).localeCompare(endOfSupport(b.modelId)))?.modelId ?? null
}
