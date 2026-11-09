import { GlideRecord, gs } from '@servicenow/glide'
import { normalizeModel, shouldLearnAlias, type ManufacturerAlias, type ModelMatchRule } from '../domain/normalization.ts'
import { bool, num, refusal, str } from './records.ts'

/** Resolving raw manufacturer/model strings to canonical Models (domain/normalization). */

export interface NormalizationData {
    aliases: ManufacturerAlias[]
    rules: ModelMatchRule[]
}

/** Load aliases and active rules once per job run or transaction (no module-level cache: modules outlive transactions). */
export function loadNormalizationData(): NormalizationData {
    const aliases: ManufacturerAlias[] = []
    const alias = new GlideRecord('x_daas_ham_manufacturer_alias')
    alias.query()
    while (alias.next()) aliases.push({ alias: str(alias, 'alias'), manufacturerId: str(alias, 'manufacturer') })

    const rules: ModelMatchRule[] = []
    const rule = new GlideRecord('x_daas_ham_model_match_rule')
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
            active: bool(rule, 'active'),
        })
    }
    return { aliases, rules }
}

/** A canonical Model with exactly this OEM PID. */
export function modelByPid(pid: string): string {
    if (!pid.trim()) return ''
    const model = new GlideRecord('cmdb_model')
    model.addQuery('x_daas_ham_oem_pid', pid.trim())
    model.setLimit(1)
    model.query()
    return model.next() ? model.getUniqueValue() : ''
}

export type Resolution = { modelId: string } | { modelId: ''; reason: string }

/** PID first, then aliases + match rules. */
export function resolveModel(raw: { manufacturer: string; model: string }, data: NormalizationData): Resolution {
    const byPid = modelByPid(raw.model)
    if (byPid) return { modelId: byPid }
    const result = normalizeModel(raw, data.aliases, data.rules)
    return result.matched ? { modelId: result.modelId } : { modelId: '', reason: result.reason }
}

/** Remember a raw pair nobody could map (counted, so the worst offenders surface first). */
export function recordNormalizationException(
    raw: { manufacturer: string; model: string },
    reason: string,
    source: { table: string; id: string },
): void {
    const exception = new GlideRecord('x_daas_ham_norm_exception')
    exception.addQuery('raw_manufacturer', raw.manufacturer)
    exception.addQuery('raw_model', raw.model)
    exception.addQuery('status', 'open')
    exception.setLimit(1)
    exception.query()
    if (exception.next()) {
        exception.setValue('occurrences', num(exception, 'occurrences') + 1)
        exception.update()
        return
    }
    exception.initialize()
    exception.setValue('raw_manufacturer', raw.manufacturer)
    exception.setValue('raw_model', raw.model)
    exception.setValue('reason', reason)
    exception.setValue('source_table', source.table)
    exception.setValue('source_record', source.id)
    exception.insert()
}

/**
 * Teach the rules: an exact rule for a resolved exception, and an alias when its manufacturer name was unknown. A blank
 * or punctuation-only name gets no alias, since none could ever match it; the exact rule still serves rows that name a
 * known manufacturer. False (and a warning) when the platform refuses the alias or the rule, so the caller does not
 * take the raw pair as mapped; a refused alias stops before the rule, so a retry learns each once.
 */
export function learnFromResolution(exception: GlideRecord, data: NormalizationData): boolean {
    const modelId = str(exception, 'resolved_model')
    const manufacturerId = str(exception, 'resolved_model.manufacturer')
    if (!modelId || !manufacturerId) return true
    const rawManufacturer = str(exception, 'raw_manufacturer')
    const rawPair = `${rawManufacturer} / ${str(exception, 'raw_model')}`
    if (shouldLearnAlias(rawManufacturer, data.aliases)) {
        const alias = new GlideRecord('x_daas_ham_manufacturer_alias')
        alias.initialize()
        alias.setValue('alias', rawManufacturer)
        alias.setValue('manufacturer', manufacturerId)
        if (!learned(alias, 'alias', rawPair)) return false
    }
    const rule = new GlideRecord('x_daas_ham_model_match_rule')
    rule.initialize()
    rule.setValue('order', 100)
    rule.setValue('manufacturer', manufacturerId)
    rule.setValue('match_type', 'exact')
    rule.setValue('pattern', str(exception, 'raw_model'))
    rule.setValue('model', modelId)
    return learned(rule, 'match rule', rawPair)
}

function learned(record: GlideRecord, what: string, rawPair: string): boolean {
    if (record.insert()) return true
    gs.warn(`[x_daas_ham] No ${what} learned for ${rawPair}: ${refusal(record)}`)
    return false
}
