import type { LifecycleDates } from './model-lifecycle.ts'

/** Hardware refresh (P2.2, D48): which Assets go together and what replaces them. */

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
    // Latest end of support first; '' (unknown) sorts after every date. The sort is stable, so ties keep catalog order.
    const options = catalog
        .filter((c) => c.deviceClass === current.deviceClass && sellable(c.modelId))
        .sort((a, b) => endOfSupport(b.modelId).localeCompare(endOfSupport(a.modelId)))
    return options[0]?.modelId ?? null
}
