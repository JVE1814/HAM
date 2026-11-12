import { GlideRecord } from '@servicenow/glide'
import { FLEET_CONDITION, OEM_PID_FIELD } from '../domain/fleet.ts'
import {
    aliasedManufacturer,
    DEFAULT_RULE_ORDER,
    fleetOnRawModelQuery,
    MODEL_TABLE,
    NORMALIZED_TO,
    normalizeModel,
    NOT_NAAS_REASON,
    notNaasRawModelsQuery,
    RAW_MODEL_EXCEPTIONS_QUERY,
    RAW_MODEL_TABLE,
    rawModelsToNormalizeQuery,
    shouldLearnAlias,
    siteCiOnRawModelQuery,
    type ManufacturerAlias,
    type ModelMatchRule,
    type NormalizationResult,
    unusableRules,
} from '../domain/normalization.ts'
import { runTableJob } from './chunked.ts'
import { countBy, num, pluck, str, warnRefused } from './records.ts'
import { NORM_EXCEPTION_STATUS } from '../domain/vocabulary.ts'
import { log } from './log.ts'

const ALIAS_TABLE = 'x_daas_ham_manufacturer_alias'
const RULE_TABLE = 'x_daas_ham_model_match_rule'
const EXCEPTION_TABLE = 'x_daas_ham_norm_exception'

interface NormalizationData {
    aliases: ManufacturerAlias[]
    rules: ModelMatchRule[]
}

/** Load aliases and active rules once per job run or transaction. */
export function loadNormalizationData(): NormalizationData {
    const aliases: ManufacturerAlias[] = []
    const alias = new GlideRecord(ALIAS_TABLE)
    alias.query()
    while (alias.next()) aliases.push({ alias: str(alias, 'alias'), manufacturerId: str(alias, 'manufacturer') })

    const rules: ModelMatchRule[] = []
    const rule = new GlideRecord(RULE_TABLE)
    rule.addQuery('active', true)
    rule.query()
    while (rule.next()) {
        rules.push({
            id: rule.getUniqueValue(),
            order: num(rule, 'order'),
            manufacturerId: str(rule, 'manufacturer'),
            matchType: str(rule, 'match_type') as ModelMatchRule['matchType'],
            pattern: str(rule, 'pattern'),
            modelId: str(rule, 'model'),
        })
    }
    return { aliases, rules }
}

function modelByPid(pid: string): string {
    if (!pid.trim()) return ''
    const model = new GlideRecord(MODEL_TABLE)
    model.addQuery(OEM_PID_FIELD, pid.trim())
    model.setLimit(1)
    model.query()
    return model.next() ? model.getUniqueValue() : ''
}

/** Why a raw pair maps to no Model: '' when the rule it matches names no Model (its Model was deleted, say). */
type NormalizationFailure = Extract<NormalizationResult, { matched: false }>['reason'] | ''

type Resolution = { matched: true; modelId: string } | { matched: false; reason: NormalizationFailure }

export function resolveModel(raw: { manufacturer: string; model: string }, data: NormalizationData): Resolution {
    const byPid = modelByPid(raw.model)
    if (byPid) return { matched: true, modelId: byPid }
    const result = normalizeModel(raw, data.aliases, data.rules)
    if (!result.matched) return { matched: false, reason: result.reason }
    return result.modelId ? { matched: true, modelId: result.modelId } : { matched: false, reason: '' }
}

/**
 * Remember a raw pair nobody could map (counted, so the worst offenders surface first). The open exception of the pair
 * is found and counted on, or raised, without a lock: two rows that raise the same pair at the same moment can each
 * raise one, and both are then counted on and resolved by hand like any other. Whether an open exception names the
 * pair: false when the platform refuses to raise it (logged), so nothing surfaces the pair until it is seen again. One
 * open already whose count the platform refuses is logged and still names it.
 */
export function recordNormalizationException(
    raw: { manufacturer: string; model: string },
    reason: NormalizationFailure,
    source: { table: string; id: string },
): boolean {
    const rawPair = `${raw.manufacturer} / ${raw.model}`
    const exception = new GlideRecord(EXCEPTION_TABLE)
    exception.addQuery('raw_manufacturer', raw.manufacturer)
    exception.addQuery('raw_model', raw.model)
    exception.addQuery('status', NORM_EXCEPTION_STATUS.open)
    exception.setLimit(1)
    exception.query()
    if (exception.next()) {
        exception.setValue('occurrences', num(exception, 'occurrences') + 1)
        if (!exception.update()) warnRefused(exception, `Normalization exception ${rawPair} not counted again`)
        return true
    }
    exception.initialize()
    exception.setValue('raw_manufacturer', raw.manufacturer)
    exception.setValue('raw_model', raw.model)
    exception.setValue('reason', reason)
    exception.setValue('source_table', source.table)
    exception.setValue('source_record', source.id)
    if (exception.insert()) return true
    warnRefused(exception, `No normalization exception for ${rawPair}`)
    return false
}

/**
 * Map onto canonical Models the raw hardware models that are NaaS's (ADR 0016): those Discovery and connectors put
 * fleet assets on, and those of the network gear reconciliation reports *seen without asset* at a customer Site, whose
 * Asset joins the fleet on the canonical Model. A raw model only the Provider IT's equipment is on (its laptops,
 * printers, servers) is not NaaS's to map, so it is neither mapped nor raised as a normalization exception, and an
 * exception an earlier run raised for one is closed.
 */
export function normalizeNaasRawModels(): void {
    const naas = [
        ...countBy('alm_hardware', fleetOnRawModelQuery(), 'model').keys(),
        ...countBy('cmdb_ci_netgear', siteCiOnRawModelQuery(), 'model_id').keys(),
    ]
    closeNonNaasExceptions(naas)
    const query = rawModelsToNormalizeQuery(naas)
    // No raw model is NaaS's: nothing to map.
    if (!query) return
    const data = loadNormalizationData()
    for (const rule of unusableRules(data.rules)) log.warn(`Model match rule skipped: its pattern ${rule.pattern} is not a regular expression`)
    runTableJob({
        job: 'normalize_raw_models',
        table: RAW_MODEL_TABLE,
        query,
        read: (model) => ({ manufacturer: str(model, 'manufacturer.name'), model: str(model, 'name') }),
        handle: (raw, rawModelId) => {
            const resolution = resolveModel(raw, data)
            if (!resolution.matched) {
                recordNormalizationException(raw, resolution.reason, { table: RAW_MODEL_TABLE, id: rawModelId })
                return
            }
            repointModel(rawModelId, resolution.modelId)
        },
    })
}

/**
 * Point the raw model's fleet assets at the canonical Model, then mark the raw model normalized. Marked, it leaves the
 * job's query, so an Asset whose save is refused leaves it unmarked for the next run to repoint, as does a refused
 * mark. The Provider IT's Assets on the raw model are left on it (ADR 0016).
 */
function repointModel(rawModelId: string, canonicalModelId: string): void {
    const raw = new GlideRecord(MODEL_TABLE)
    if (!raw.get(rawModelId)) return
    let refused = 0
    const asset = new GlideRecord('alm_hardware')
    asset.addQuery('model', rawModelId)
    asset.addEncodedQuery(FLEET_CONDITION)
    asset.query()
    while (asset.next()) {
        asset.setValue('model', canonicalModelId)
        if (asset.update()) continue
        refused++
        warnRefused(asset, `Model normalization: ${str(asset, 'serial_number')} left on its raw model`)
    }
    if (refused > 0) return
    raw.setValue(NORMALIZED_TO, canonicalModelId)
    if (!raw.update()) warnRefused(raw, `Model normalization: raw model ${str(raw, 'name')} not marked normalized`)
}

/**
 * Close the open exceptions the hourly normalization raised for raw models that are not NaaS's to map: unmapped and
 * none of `naasRawModelIds`. Each is resolved with no Model, its reason
 * `not_naas`. One the platform refuses to close is logged and stays open for the next run.
 */
function closeNonNaasExceptions(naasRawModelIds: readonly string[]): void {
    const query = notNaasRawModelsQuery(pluck(EXCEPTION_TABLE, RAW_MODEL_EXCEPTIONS_QUERY, 'source_record'), naasRawModelIds)
    const notNaas = query ? pluck(RAW_MODEL_TABLE, query, 'sys_id') : []
    if (notNaas.length === 0) return
    const exception = new GlideRecord(EXCEPTION_TABLE)
    exception.addEncodedQuery(RAW_MODEL_EXCEPTIONS_QUERY)
    exception.addQuery('source_record', 'IN', notNaas.join(','))
    exception.query()
    while (exception.next()) {
        exception.setValue('status', NORM_EXCEPTION_STATUS.resolved)
        exception.setValue('reason', NOT_NAAS_REASON)
        if (exception.update()) continue
        const rawPair = `${str(exception, 'raw_manufacturer')} / ${str(exception, 'raw_model')}`
        warnRefused(exception, `Normalization exception ${rawPair} not closed as not NaaS`)
    }
}

/**
 * Teach the rules: an exact rule for a resolved exception, and an alias when its manufacturer name was unknown. The
 * rule is kept under the manufacturer the raw name's alias names, which normalization looks its rules up by, and
 * under the resolved Model's when no alias covers the name. A blank or punctuation-only name gets no alias, since none
 * could ever match it; the exact rule still serves rows that name a known manufacturer. False (and a warning) when the
 * platform refuses the alias or the rule, so the caller does not take the raw pair as mapped; a refused alias stops
 * before the rule, so a retry learns each once.
 */
function learnFromResolution(exception: GlideRecord, data: NormalizationData): boolean {
    const modelId = str(exception, 'resolved_model')
    const manufacturerId = str(exception, 'resolved_model.manufacturer')
    if (!modelId || !manufacturerId) return true
    const rawManufacturer = str(exception, 'raw_manufacturer')
    const rawPair = `${rawManufacturer} / ${str(exception, 'raw_model')}`
    if (shouldLearnAlias(rawManufacturer, data.aliases)) {
        const alias = new GlideRecord(ALIAS_TABLE)
        alias.initialize()
        alias.setValue('alias', rawManufacturer)
        alias.setValue('manufacturer', manufacturerId)
        if (!learned(alias, 'alias', rawPair)) return false
    }
    // An exact match at the order a rule gets when none is entered, so a rule given a lower order still wins.
    const exact: ModelMatchRule['matchType'] = 'exact'
    const rule = new GlideRecord(RULE_TABLE)
    rule.initialize()
    rule.setValue('order', DEFAULT_RULE_ORDER)
    rule.setValue('manufacturer', aliasedManufacturer(rawManufacturer, data.aliases) ?? manufacturerId)
    rule.setValue('match_type', exact)
    rule.setValue('pattern', str(exception, 'raw_model'))
    rule.setValue('model', modelId)
    return learned(rule, 'match rule', rawPair)
}

function learned(record: GlideRecord, what: string, rawPair: string): boolean {
    if (record.insert()) return true
    warnRefused(record, `No ${what} learned for ${rawPair}`)
    return false
}

/**
 * What came of resolving a normalization exception: no rule was learned; or one was, with why the platform refused to
 * save the exception as resolved (`unresolved`) when it did.
 */
export type NormalizationResolution = { learned: false } | { learned: true; unresolved?: string }

/**
 * A normalization exception was given its resolved Model: learn a rule from it and resolve it.
 * When no rule was learned the exception stays open, as nothing maps its raw pair yet. One learned whose resolution
 * the platform refuses stays open too (logged): the user sets it resolved by hand, which learns nothing twice, as the
 * rule runs only on a new resolved model.
 */
export function resolveNormalizationException(exception: GlideRecord): NormalizationResolution {
    if (!learnFromResolution(exception, loadNormalizationData())) return { learned: false }
    exception.setValue('status', NORM_EXCEPTION_STATUS.resolved)
    if (exception.update()) return { learned: true }
    const rawPair = `${str(exception, 'raw_manufacturer')} / ${str(exception, 'raw_model')}`
    return { learned: true, unresolved: warnRefused(exception, `Normalization exception ${rawPair}: rule learned, but not saved as resolved`) }
}
