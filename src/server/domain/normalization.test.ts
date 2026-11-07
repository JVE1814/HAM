import { describe, expect, it } from 'vitest'
import { manufacturerKey, normalizeModel, shouldLearnAlias, type ModelMatchRule } from './normalization'

const aliases = [
    { alias: 'Cisco Systems, Inc.', manufacturerId: 'cisco' },
    { alias: 'cisco', manufacturerId: 'cisco' },
    { alias: 'Fortinet', manufacturerId: 'fortinet' },
    { alias: 'Hewlett Packard Enterprise', manufacturerId: 'hpe' },
    { alias: '--', manufacturerId: 'placeholder' },
]

const rules: ModelMatchRule[] = [
    { id: 'r1', order: 100, manufacturerId: 'cisco', matchType: 'exact', pattern: 'C9300-48P-E', modelId: 'c9300-48p', active: true },
    { id: 'r2', order: 200, manufacturerId: 'cisco', matchType: 'prefix', pattern: 'C9300', modelId: 'c9300-generic', active: true },
    { id: 'r3', order: 50, manufacturerId: 'fortinet', matchType: 'regex', pattern: '^FortiGate[- ]?60F', modelId: 'fg60f', active: true },
    { id: 'r4', order: 10, manufacturerId: 'cisco', matchType: 'regex', pattern: '([', modelId: 'broken', active: true },
    { id: 'r5', order: 1, manufacturerId: 'cisco', matchType: 'prefix', pattern: 'C', modelId: 'inactive', active: false },
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

    it('skips inactive rules and rules with an invalid pattern', () => {
        const result = normalizeModel({ manufacturer: 'cisco', model: 'ISR4331' }, aliases, rules)
        expect(result).toEqual({ matched: false, manufacturerId: 'cisco', reason: 'no_matching_rule' })
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
