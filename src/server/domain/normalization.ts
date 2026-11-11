import { inFleet, OEM_PID_FIELD } from './fleet.ts'
import { seenWithoutFleetAssetQuery } from './reconciliation.ts'
import { type MatchType, NORM_EXCEPTION_STATUS } from './vocabulary.ts'

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
    matchType: MatchType
    pattern: string
    modelId: string
    active: boolean
}

export type NormalizationResult =
    | { matched: true; manufacturerId: string; modelId: string; ruleId: string }
    | { matched: false; manufacturerId: string; reason: 'no_matching_rule' }
    | { matched: false; reason: 'unknown_manufacturer' }

/** ASCII punctuation and symbols, the typographic dashes (U+2010 to U+2015) and quotes (U+2018 to U+201F), and the ©, ® and ™ marks. */
const PUNCTUATION = /[!-/:-@[-`{-~\u00a9\u00ae\u2010-\u2015\u2018-\u201f\u2122]/g

/**
 * Lower-case, treat punctuation as a word break and collapse whitespace, so "Cisco Systems, Inc." matches "cisco systems inc"
 * and "Hewlett-Packard" matches "Hewlett Packard".
 */
export function manufacturerKey(raw: string): string {
    return raw.toLowerCase().replace(PUNCTUATION, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Whether resolving an exception for this raw manufacturer should teach a new alias: only a name that can ever match one
 * (not blank or only punctuation) and that no existing alias already covers.
 */
export function shouldLearnAlias(rawManufacturer: string, aliases: readonly ManufacturerAlias[]): boolean {
    const key = manufacturerKey(rawManufacturer)
    return key !== '' && !aliases.some((a) => manufacturerKey(a.alias) === key)
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
            return regexOf(rule.pattern)?.test(model.trim()) ?? false
    }
}

function regexOf(pattern: string): RegExp | null {
    try {
        return new RegExp(pattern, 'i')
    } catch {
        return null
    }
}

/**
 * The regex rules whose pattern is no regular expression. Normalization goes on without them, as if they were inactive,
 * so the raw models they were meant for stay unmapped until the pattern is corrected: the caller says so once.
 */
export function unusableRules(rules: readonly ModelMatchRule[]): ModelMatchRule[] {
    return rules.filter((rule) => rule.matchType === 'regex' && regexOf(rule.pattern) === null)
}

export function normalizeModel(
    raw: { manufacturer: string; model: string },
    aliases: readonly ManufacturerAlias[],
    rules: readonly ModelMatchRule[],
): NormalizationResult {
    const key = manufacturerKey(raw.manufacturer)
    const manufacturerId = key ? aliases.find((a) => manufacturerKey(a.alias) === key)?.manufacturerId : undefined
    if (!manufacturerId) return { matched: false, reason: 'unknown_manufacturer' }

    const rule = rules
        .filter((r) => r.active && r.manufacturerId === manufacturerId)
        .sort((a, b) => a.order - b.order)
        .find((r) => ruleMatches(r, raw.model))
    if (!rule) return { matched: false, manufacturerId, reason: 'no_matching_rule' }
    return { matched: true, manufacturerId, modelId: rule.modelId, ruleId: rule.id }
}

/** The table of raw hardware models, as Discovery and connectors create them, that normalization maps. */
export const RAW_MODEL_TABLE = 'cmdb_hardware_product_model'

/**
 * The Model table, which RAW_MODEL_TABLE extends. A canonical Model is found on it by its OEM PID, and a raw model is
 * marked normalized through it: both fields are this table's.
 */
export const MODEL_TABLE = 'cmdb_model'

/** The raw model field that records the canonical Model it was mapped to. */
export const NORMALIZED_TO = 'x_daas_ham_normalized_to'

/** The order a model match rule gets when none is entered: the default of its `order` column. */
export const DEFAULT_RULE_ORDER = 100

/**
 * The rule learned from a resolved exception: an exact match on its raw model, at the order a rule gets when none is
 * entered, so a rule given a lower order still wins.
 */
export const LEARNED_RULE = { order: DEFAULT_RULE_ORDER, matchType: 'exact' } as const satisfies Pick<ModelMatchRule, 'order' | 'matchType'>

/** Encoded condition: the Model in `field` has no OEM PID (it is a raw model, ADR 0016) and is not yet normalized. */
function onUnmappedRawModel(field: string): string {
    return `${field}ISNOTEMPTY^${field}.${OEM_PID_FIELD}ISEMPTY^${field}.${NORMALIZED_TO}ISEMPTY`
}

/**
 * Encoded alm_hardware query: fleet assets (ADR 0016) on a Model with no OEM PID that is not yet normalized. The
 * hourly normalization maps the raw models these are on, and those of `siteCiOnRawModelQuery`: the Provider IT's
 * laptops, printers and servers are on raw models too, and mapping those is not NaaS's business.
 */
export function fleetOnRawModelQuery(): string {
    return inFleet(onUnmappedRawModel('model'))
}

/**
 * Encoded cmdb_ci_netgear query: the network gear reconciliation reports *seen without asset* (at a customer Site,
 * pointing at no fleet asset: domain/reconciliation `seenWithoutFleetAssetQuery`) on a raw model not yet normalized.
 * Discovery puts such a device, and the Asset it creates for it, on its own raw model, which no fleet asset is on. The
 * hourly normalization maps those raw models too, or raises the exception that names the mapping missing, so the
 * Asset can join the fleet on its canonical NaaS Model.
 */
export function siteCiOnRawModelQuery(): string {
    return `${seenWithoutFleetAssetQuery()}^${onUnmappedRawModel('model_id')}`
}

/**
 * Encoded query on RAW_MODEL_TABLE: those of `rawModelIds` still to normalize (no OEM PID, not yet mapped). Null when
 * there are none, as an empty id list would not narrow the query at all.
 */
export function rawModelsToNormalizeQuery(rawModelIds: readonly string[]): string | null {
    const ids = [...new Set(rawModelIds.filter(Boolean))]
    if (ids.length === 0) return null
    return `${OEM_PID_FIELD}ISEMPTY^${NORMALIZED_TO}ISEMPTY^sys_idIN${ids.join(',')}`
}

/** The reason a normalization exception is closed with when its raw model is not NaaS's to map. */
export const NOT_NAAS_REASON = 'not_naas'

/** Encoded query on normalization exceptions: the open ones, which the navigator and the workspace list. */
export const OPEN_NORM_EXCEPTIONS_QUERY = `status=${NORM_EXCEPTION_STATUS.open}`

/**
 * Encoded query on normalization exceptions: the open ones the hourly normalization raised, whose source is a raw
 * model. Those an ASN row raised name the import row instead.
 */
export const RAW_MODEL_EXCEPTIONS_QUERY = `${OPEN_NORM_EXCEPTIONS_QUERY}^source_table=${RAW_MODEL_TABLE}`

/**
 * Encoded query on RAW_MODEL_TABLE: of the raw models open exceptions name (`exceptionModelIds`), those that are not
 * NaaS's: still raw and unmapped (no OEM PID, not normalized), and none of `naasRawModelIds` (the raw models the job
 * maps). Raised before the Fleet flag, when the job mapped every raw model, their exceptions name the Provider IT's
 * models, which the job neither maps nor raises again, so it closes them. A raw model mapped or given its OEM PID
 * since is NaaS's, and its exception is left as it is. Null when no exception names a raw model.
 */
export function notNaasRawModelsQuery(exceptionModelIds: readonly string[], naasRawModelIds: readonly string[]): string | null {
    const named = rawModelsToNormalizeQuery(exceptionModelIds)
    if (!named) return null
    const naas = [...new Set(naasRawModelIds.filter(Boolean))]
    return naas.length > 0 ? `${named}^sys_idNOT IN${naas.join(',')}` : named
}
