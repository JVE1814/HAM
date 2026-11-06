/**
 * Model normalization: map the raw manufacturer/model strings reported by Discovery, connectors and
 * ASNs to a canonical manufacturer and Model.
 */

export interface ManufacturerAlias {
    alias: string
    manufacturerId: string
}

export interface ModelMatchRule {
    id: string
    order: number
    manufacturerId: string
    matchType: 'exact' | 'prefix' | 'regex'
    pattern: string
    modelId: string
    active: boolean
}

export type NormalizationResult =
    | { matched: true; manufacturerId: string; modelId: string; ruleId: string }
    | { matched: false; manufacturerId: string; reason: 'no_matching_rule' }
    | { matched: false; reason: 'unknown_manufacturer' }

/** Lower-case, drop punctuation and collapse whitespace so "Cisco Systems, Inc." matches "cisco systems inc". */
export function manufacturerKey(raw: string): string {
    return raw.toLowerCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim()
}

function modelKey(raw: string): string {
    return raw.replace(/\s+/g, ' ').trim().toUpperCase()
}

function ruleMatches(rule: ModelMatchRule, model: string): boolean {
    switch (rule.matchType) {
        case 'exact':
            return modelKey(rule.pattern) === modelKey(model)
        case 'prefix':
            return modelKey(model).startsWith(modelKey(rule.pattern))
        case 'regex':
            try {
                return new RegExp(rule.pattern, 'i').test(model.trim())
            } catch {
                return false
            }
    }
}

export function normalizeModel(
    raw: { manufacturer: string; model: string },
    aliases: readonly ManufacturerAlias[],
    rules: readonly ModelMatchRule[],
): NormalizationResult {
    const key = manufacturerKey(raw.manufacturer)
    const manufacturerId = aliases.find((a) => manufacturerKey(a.alias) === key)?.manufacturerId
    if (!manufacturerId) return { matched: false, reason: 'unknown_manufacturer' }

    const rule = rules
        .filter((r) => r.active && r.manufacturerId === manufacturerId)
        .sort((a, b) => a.order - b.order)
        .find((r) => ruleMatches(r, raw.model))
    if (!rule) return { matched: false, manufacturerId, reason: 'no_matching_rule' }
    return { matched: true, manufacturerId, modelId: rule.modelId, ruleId: rule.id }
}
