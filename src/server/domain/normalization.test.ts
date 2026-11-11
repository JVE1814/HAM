import { describe, expect, it } from 'vitest'
import {
    fleetOnRawModelQuery,
    manufacturerKey,
    normalizeModel,
    notNaasRawModelsQuery,
    RAW_MODEL_EXCEPTIONS_QUERY,
    rawModelsToNormalizeQuery,
    siteCiOnRawModelQuery,
    shouldLearnAlias,
    unusableRules,
    type ModelMatchRule,
} from './normalization'
import { seenWithoutFleetAssetQuery } from './reconciliation'
import { recordMatches as matches } from '../test-support/encoded-query'
import { through } from '../test-support/stored-asset'

const aliases = [
    { alias: 'Cisco Systems, Inc.', manufacturerId: 'cisco' },
    { alias: 'cisco', manufacturerId: 'cisco' },
    { alias: 'Fortinet', manufacturerId: 'fortinet' },
    { alias: 'Hewlett Packard Enterprise', manufacturerId: 'hpe' },
    { alias: '--', manufacturerId: 'placeholder' },
]

const rules: ModelMatchRule[] = [
    { id: 'r1', order: 100, manufacturerId: 'cisco', matchType: 'exact', pattern: 'C9300-48P-E', modelId: 'c9300-48p' },
    { id: 'r2', order: 200, manufacturerId: 'cisco', matchType: 'prefix', pattern: 'C9300', modelId: 'c9300-generic' },
    { id: 'r3', order: 50, manufacturerId: 'fortinet', matchType: 'regex', pattern: '^FortiGate[- ]?60F', modelId: 'fg60f' },
    { id: 'r4', order: 10, manufacturerId: 'cisco', matchType: 'regex', pattern: '([', modelId: 'broken' },
]

describe('normalizeModel', () => {
    it('resolves the manufacturer through aliases regardless of case and punctuation', () => {
        const result = normalizeModel({ manufacturer: '  CISCO SYSTEMS INC ', model: 'c9300-48p-e' }, aliases, rules)
        expect(result).toEqual({ matched: true, manufacturerId: 'cisco', modelId: 'c9300-48p', ruleId: 'r1' })
    })

    it('treats any punctuation as a word break when matching manufacturer aliases', () => {
        expect(manufacturerKey('Hewlett-Packard Enterprise')).toBe(manufacturerKey('Hewlett Packard Enterprise'))
        expect(manufacturerKey('Hewlett Packard (Enterprise)')).toBe('hewlett packard enterprise')
        expect(manufacturerKey('Hewlett/Packard_Enterprise')).toBe('hewlett packard enterprise')
        expect(manufacturerKey('Hewlett\u2013Packard Enterprise\u2122')).toBe('hewlett packard enterprise')
        expect(manufacturerKey('\u2018Dell\u2019 Technologies\u00ae')).toBe('dell technologies')
        expect(manufacturerKey('Cisco Systems,Inc.')).toBe('cisco systems inc')
        const result = normalizeModel({ manufacturer: 'Hewlett-Packard Enterprise', model: 'DL380' }, aliases, rules)
        expect(result).toEqual({ matched: false, manufacturerId: 'hpe', reason: 'no_matching_rule' })
    })

    it('never matches a manufacturer that is only punctuation or blank', () => {
        expect(normalizeModel({ manufacturer: '-', model: 'X1' }, aliases, rules)).toEqual({ matched: false, reason: 'unknown_manufacturer' })
        expect(normalizeModel({ manufacturer: '', model: 'X1' }, aliases, rules)).toEqual({ matched: false, reason: 'unknown_manufacturer' })
    })

    it('applies the first matching rule in rule order', () => {
        const result = normalizeModel({ manufacturer: 'cisco', model: 'C9300-24T' }, aliases, rules)
        expect(result).toMatchObject({ matched: true, modelId: 'c9300-generic', ruleId: 'r2' })
    })

    it('matches regular-expression rules case-insensitively', () => {
        const result = normalizeModel({ manufacturer: 'Fortinet', model: 'fortigate 60F' }, aliases, rules)
        expect(result).toMatchObject({ matched: true, modelId: 'fg60f' })
    })

    it('skips rules with an invalid pattern', () => {
        const result = normalizeModel({ manufacturer: 'cisco', model: 'ISR4331' }, aliases, rules)
        expect(result).toEqual({ matched: false, manufacturerId: 'cisco', reason: 'no_matching_rule' })
    })

    it('names the regex rules whose pattern is no regular expression, which it skipped', () => {
        expect(unusableRules(rules).map((rule) => rule.id)).toEqual(['r4'])
        expect(unusableRules(rules.filter((rule) => rule.id !== 'r4'))).toEqual([])
        expect(unusableRules([{ ...rules[0], pattern: '([' }])).toEqual([])
    })

    it('reports an unknown manufacturer', () => {
        expect(normalizeModel({ manufacturer: 'Acme', model: 'X1' }, aliases, rules)).toEqual({
            matched: false,
            reason: 'unknown_manufacturer',
        })
    })
})

describe('shouldLearnAlias', () => {
    it('learns a manufacturer name that no alias covers yet', () => {
        expect(shouldLearnAlias('Arista Networks', aliases)).toBe(true)
    })

    it('does not learn a name an existing alias already covers once case and punctuation are ignored', () => {
        expect(shouldLearnAlias('CISCO SYSTEMS INC', aliases)).toBe(false)
        expect(shouldLearnAlias('Hewlett-Packard Enterprise', aliases)).toBe(false)
    })

    it('never learns a blank or punctuation-only name, because no alias could ever match it', () => {
        expect(shouldLearnAlias('', aliases)).toBe(false)
        expect(shouldLearnAlias('   ', aliases)).toBe(false)
        expect(shouldLearnAlias('-', [])).toBe(false)
        expect(shouldLearnAlias('?*', [])).toBe(false)
    })
})

const RAW = { x_daas_ham_oem_pid: '', x_daas_ham_normalized_to: '' }
const CANONICAL = { x_daas_ham_oem_pid: 'C9300-48P-E', x_daas_ham_normalized_to: '' }
const MAPPED = { x_daas_ham_oem_pid: '', x_daas_ham_normalized_to: 'c9300-48p' }

describe('fleetOnRawModelQuery', () => {
    const asset = (fleet: string, model: Record<string, string>, modelId = 'raw1') => through('model.', model, { x_daas_ham_fleet: fleet, model: modelId })
    const found = (record: Record<string, string>) => matches(fleetOnRawModelQuery(), record)

    it('finds a fleet asset on a Model with no OEM PID that is not yet normalized', () => {
        expect(found(asset('true', RAW))).toBe(true)
    })

    it('leaves out a fleet asset whose Model has its OEM PID or is mapped already, and one on no Model', () => {
        expect(found(asset('true', CANONICAL))).toBe(false)
        expect(found(asset('true', MAPPED))).toBe(false)
        expect(found(asset('true', RAW, ''))).toBe(false)
    })

    it("leaves out the Provider IT's equipment, whose raw models are not NaaS's to map (ADR 0016)", () => {
        expect(found(asset('false', RAW))).toBe(false)
        expect(found(asset('', RAW))).toBe(false)
    })
})

describe('rawModelsToNormalizeQuery', () => {
    const found = (query: string | null, model: Record<string, string>) => matches(query ?? 'sys_id=-1', model)

    it('finds, of the raw models named, those still to normalize', () => {
        const query = rawModelsToNormalizeQuery(['m1', 'm2', 'm1', ''])
        expect(found(query, { sys_id: 'm1', ...RAW })).toBe(true)
        expect(found(query, { sys_id: 'm2', ...RAW })).toBe(true)
        expect(found(query, { sys_id: 'm3', ...RAW })).toBe(false)
        expect(found(query, { sys_id: 'm1', ...CANONICAL })).toBe(false)
        expect(found(query, { sys_id: 'm1', ...MAPPED })).toBe(false)
    })

    it('gives no query without one, which would map every raw model', () => {
        expect(rawModelsToNormalizeQuery([])).toBeNull()
        expect(rawModelsToNormalizeQuery([''])).toBeNull()
    })
})

describe('siteCiOnRawModelQuery', () => {
    /** A network-gear CI at a customer Site that points at no Asset: one reconciliation reports seen without asset. */
    const seenWithoutAsset = { asset: '', 'location.x_daas_ham_is_site': 'true' }
    const ci = (model: Record<string, string>, own: Record<string, string> = {}) => through('model_id.', model, { ...seenWithoutAsset, model_id: 'raw1', ...own })
    const found = (record: Record<string, string>) => matches(siteCiOnRawModelQuery(), record)

    it('finds the devices reported seen without a fleet asset, on a raw model not yet normalized', () => {
        expect(found(ci(RAW))).toBe(true)
        expect(found(ci(CANONICAL))).toBe(false)
        expect(found(ci(MAPPED))).toBe(false)
        expect(found(ci(RAW, { model_id: '' }))).toBe(false)
    })

    it('leaves out a device on a raw model that is not reported: on a fleet asset, or not at a customer Site', () => {
        expect(matches(seenWithoutFleetAssetQuery(), seenWithoutAsset)).toBe(true)
        expect(found(ci(RAW, { asset: 'a1', 'asset.ref_alm_hardware.x_daas_ham_fleet': 'true' }))).toBe(false)
        expect(found(ci(RAW, { 'location.x_daas_ham_is_site': 'false' }))).toBe(false)
    })
})

describe('notNaasRawModelsQuery', () => {
    const found = (query: string | null, model: Record<string, string>) => matches(query ?? 'sys_id=-1', model)

    it('finds the raw models open exceptions name that are still unmapped and that the job does not map', () => {
        const query = notNaasRawModelsQuery(['it1', 'naas1', 'it1', ''], ['naas1', 'naas2', 'naas1'])
        expect(found(query, { sys_id: 'it1', ...RAW })).toBe(true)
        expect(found(query, { sys_id: 'naas1', ...RAW })).toBe(false)
        expect(found(query, { sys_id: 'it1', ...CANONICAL })).toBe(false)
        expect(found(query, { sys_id: 'it1', ...MAPPED })).toBe(false)
        expect(found(query, { sys_id: 'it2', ...RAW })).toBe(false)
    })

    it('takes every unmapped raw model named when no raw model is NaaS, with no empty list left for the platform to read', () => {
        const query = notNaasRawModelsQuery(['it1'], [])
        expect(found(query, { sys_id: 'it1', ...RAW })).toBe(true)
        expect(found(query, { sys_id: 'it2', ...RAW })).toBe(false)
        expect(query).not.toMatch(/(IN|=)(\^|$)/)
    })

    it('gives no query when no open exception names a raw model, which would match every raw model', () => {
        expect(notNaasRawModelsQuery([], ['naas1'])).toBeNull()
        expect(notNaasRawModelsQuery([''], [])).toBeNull()
    })
})

describe('RAW_MODEL_EXCEPTIONS_QUERY', () => {
    it('finds the open exceptions the hourly job raised on a raw model, not those of ASN rows nor a resolved one', () => {
        const raised = { status: 'open', source_table: 'cmdb_hardware_product_model' }
        expect(matches(RAW_MODEL_EXCEPTIONS_QUERY, raised)).toBe(true)
        expect(matches(RAW_MODEL_EXCEPTIONS_QUERY, { ...raised, source_table: 'x_daas_ham_asn_import' })).toBe(false)
        expect(matches(RAW_MODEL_EXCEPTIONS_QUERY, { ...raised, source_table: '' })).toBe(false)
        expect(matches(RAW_MODEL_EXCEPTIONS_QUERY, { ...raised, status: 'resolved' })).toBe(false)
    })
})
