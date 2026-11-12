import { describe, expect, it } from 'vitest'
import { matchesQuery, recordMatches } from './encoded-query'

const unit = { install_status: '1', substatus: 'in_service', site: 'site1', lease: '', serial_number: 'FDO-1234', cost: '90' }
const matches = (query: string) => recordMatches(query, unit)

describe('matchesQuery', () => {
    it('matches every record with the empty query', () => {
        expect(matches('')).toBe(true)
    })

    it('joins terms with ^ as AND', () => {
        expect(matches('install_status=1^substatus=in_service')).toBe(true)
        expect(matches('install_status=1^substatus=retired')).toBe(false)
    })

    it('binds ^OR tighter than ^', () => {
        expect(matches('install_status=7^ORinstall_status=1^site=site1')).toBe(true)
        expect(matches('install_status=7^ORinstall_status=1^site=site9')).toBe(false)
        expect(matches('site=site9^install_status=7^ORinstall_status=1')).toBe(false)
    })

    it('matches when any ^NQ query does', () => {
        expect(matches('install_status=7^site=site1^NQsubstatus=in_service')).toBe(true)
        expect(matches('install_status=7^NQsubstatus=retired^ORsubstatus=in_service^site=site9')).toBe(false)
    })

    it('compares with = and !=', () => {
        expect(matches('site=site1')).toBe(true)
        expect(matches('site=SITE1')).toBe(false)
        expect(matches('site!=site9')).toBe(true)
        expect(matches('site!=site1')).toBe(false)
    })

    it('reads IN and NOT IN as a comma-separated list', () => {
        expect(matches('substatusINstaging,in_service')).toBe(true)
        expect(matches('substatusINstaging,in')).toBe(false)
        expect(matches('substatusNOT INstaging,retired')).toBe(true)
        expect(matches('substatusNOT INstaging,in_service')).toBe(false)
    })

    it('orders numbers as numbers and everything else as text', () => {
        expect(matches('cost>100')).toBe(false)
        expect(matches('cost<100')).toBe(true)
        expect(matches('cost>=90^cost<=90')).toBe(true)
        expect(recordMatches('ends<2026-05-01', { ends: '2026-04-30' })).toBe(true)
        expect(recordMatches('ends>=2026-05-01 00:00:00', { ends: '2026-04-30 23:59:59' })).toBe(false)
        expect(recordMatches('sys_id>a9', { sys_id: 'b1' })).toBe(true)
    })

    it('finds text with LIKE and STARTSWITH whatever its case', () => {
        expect(matches('serial_numberLIKE-12')).toBe(true)
        expect(matches('serial_numberLIKEfdo')).toBe(true)
        expect(matches('serial_numberSTARTSWITHFDO')).toBe(true)
        expect(matches('serial_numberSTARTSWITH1234')).toBe(false)
    })

    it('lets a blank value match only ISEMPTY and a blank operand', () => {
        expect(matches('leaseISEMPTY')).toBe(true)
        expect(matches('lease=')).toBe(true)
        expect(matches('leaseISNOTEMPTY')).toBe(false)
        expect(matches('siteISNOTEMPTY')).toBe(true)
        expect(matches('siteISEMPTY')).toBe(false)
        for (const term of ['lease!=l1', 'leaseNOT INl1,l2', 'leaseINl1,', 'lease<l1', 'lease>=', 'leaseLIKE']) expect(matches(term), term).toBe(false)
        expect(matches('lease!=l1^ORleaseISEMPTY')).toBe(true)
    })

    it('reads a field the record does not name as blank', () => {
        expect(matches('modelISEMPTY')).toBe(true)
    })

    it('hands a dot-walked field name to the record as written', () => {
        const asked: string[] = []
        const valueOf = (field: string) => (asked.push(field), field === 'order.agreement' ? 'agr1' : '')
        expect(matchesQuery('order.agreement=agr1^order.stageNOT INcomplete', valueOf)).toBe(false)
        expect(asked).toEqual(['order.agreement', 'order.stage'])
    })

    it('takes the value of a javascript: operand from the test and refuses one it was not given', () => {
        const today = (expression: string) => {
            if (expression !== 'gs.beginningOfToday()') throw new Error(expression)
            return '2026-05-01 00:00:00'
        }
        expect(recordMatches('ends<javascript:gs.beginningOfToday()', { ends: '2026-04-30 10:00:00' }, today)).toBe(true)
        expect(recordMatches('ends<javascript:gs.beginningOfToday()', { ends: '2026-05-01 10:00:00' }, today)).toBe(false)
        expect(() => recordMatches('ends<javascript:gs.beginningOfToday()', { ends: '2026-04-30 10:00:00' })).toThrow('gs.beginningOfToday()')
    })

    it('throws on an operator or a term it does not know, even when the other terms already decide', () => {
        for (const query of [
            'siteENDSWITH1',
            'siteNOT LIKEsite',
            'siteBETWEENa@b',
            'siteSAMEASlease',
            'siteINSTANCEOFcmn_location',
            'siteISEMPTYsite1',
            'site',
            'ORDERBYsite',
            'site=site1^ORDERBYDESCsite',
            'site=site1^EQ',
            'site=site1^',
            '^site=site1',
            'site=site1^^lease=',
            '^ORsite=site1',
            '^NQsite=site1',
            'site=site1^NQ',
            'Site=site1',
        ]) {
            expect(() => matches(query), query).toThrow('encoded query')
        }
        expect(() => matches('site=site9^siteENDSWITH1')).toThrow('unknown term "siteENDSWITH1"')
        expect(() => matches('site=site1^ORsiteENDSWITH1')).toThrow('unknown term "siteENDSWITH1"')
        expect(() => matches('site=site1^NQsiteENDSWITH1')).toThrow('unknown term "siteENDSWITH1"')
    })
})
