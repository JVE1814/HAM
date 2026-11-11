import { GlideRecord } from '@servicenow/glide'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CoverageFact } from '../domain/oem/types.ts'
import { applyCoverage, importCoverageRow } from './coverage.ts'
import { platform } from '../test-support/fake-glide.ts'

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

const NOW = '2025-11-09 12:00:00'
const IMPORT = 'x_daas_ham_imp_oem_coverage'

const contract = (serial: string): CoverageFact => ({ serial, covered: true, contractNumber: 'C-1', serviceLevel: 'NBD', endDate: '2027-06-30' })

function asset(id: string, fields: Record<string, string> = {}): void {
    platform.tables.alm_hardware!.push({ sys_id: id, serial_number: 'CN12AB', x_daas_ham_fleet: 'true', x_daas_ham_coverage_checked: '', ...fields })
}

const assetRow = (id: string) => platform.tables.alm_hardware!.find((row) => row.sys_id === id)

function importRow(): GlideRecord {
    platform.tables[IMPORT] = [{ sys_id: 'row', vendor: 'aruba', serial_number: 'cn12ab', contract_number: 'C-1', service_level: 'NBD', start_date: '', end_date: '2027-06-30', annual_cost: '' }]
    const row = new GlideRecord(IMPORT)
    row.get('row')
    return row
}

beforeEach(() => {
    platform.reset()
    platform.tables.alm_hardware = []
    platform.tables.x_daas_ham_oem_coverage = []
})

describe('a coverage import row', () => {
    it('covers every fleet asset with its serial, its contract pointing at the one checked last', () => {
        asset('later', { x_daas_ham_coverage_checked: '2025-06-01 00:00:00' })
        asset('earlier', { x_daas_ham_coverage_checked: '2025-01-01 00:00:00' })
        asset('provider-it', { x_daas_ham_fleet: 'false' })

        expect(importCoverageRow(importRow())).toEqual({ state: 'inserted', comment: 'Coverage for CN12AB' })

        expect(platform.tables.x_daas_ham_oem_coverage!.map((row) => ({ serial: row.serial_number, asset: row.asset }))).toEqual([{ serial: 'CN12AB', asset: 'later' }])
        for (const id of ['earlier', 'later']) expect(assetRow(id)).toMatchObject({ x_daas_ham_coverage_end: '2027-06-30', x_daas_ham_coverage_checked: NOW })
        expect(assetRow('provider-it')).not.toHaveProperty('x_daas_ham_coverage_end')
    })
})

describe('applyCoverage', () => {
    it('summarises a serial given as stored, not normalised', () => {
        asset('a1')

        expect(applyCoverage('cisco', 'api', new Map([[' cn12ab ', { assetIds: ['a1'], answer: { kind: 'apply', facts: [contract('cn12ab')] } }]]))).toEqual([])

        expect(assetRow('a1')).toMatchObject({ x_daas_ham_coverage_end: '2027-06-30', x_daas_ham_coverage_checked: NOW })
    })

    it('only stamps a serial its vendor rejected, keeping its coverage', () => {
        asset('a1', { x_daas_ham_coverage_end: '2026-01-31' })

        expect(applyCoverage('cisco', 'api', new Map([['CN12AB', { assetIds: ['a1'], answer: { kind: 'stamp' } }]]))).toEqual([])

        expect(assetRow('a1')).toMatchObject({ x_daas_ham_coverage_end: '2026-01-31', x_daas_ham_coverage_checked: NOW })
        expect(platform.tables.x_daas_ham_oem_coverage).toEqual([])
    })

    it('leaves the Assets of a serial whose contract is refused unchecked, and says why', () => {
        asset('a1')
        platform.refuses = (table) => (table === 'x_daas_ham_oem_coverage' ? 'no' : '')

        const refused = applyCoverage('cisco', 'api', new Map([['CN12AB', { assetIds: ['a1'], answer: { kind: 'apply', facts: [contract('CN12AB')] } }]]))

        expect(refused).toEqual([expect.stringMatching(/^coverage of CN12AB not saved: contract C-1: /)])
        expect(assetRow('a1')).toMatchObject({ x_daas_ham_coverage_checked: '' })
    })
})
