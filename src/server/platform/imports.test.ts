import { beforeEach, describe, expect, it, vi } from 'vitest'
import { importLifecycleRow } from './imports.ts'
import { readModelLifecycle, writeModelLifecycle } from './model-lifecycle.ts'
import { platform, recordOf, type Row } from '../test-support/fake-glide.ts'
import type { GlideRecord } from '@servicenow/glide'

/*
 * The lifecycle CSV import run against the in-memory platform: its rows are matched to a Model by OEM PID, and the
 * milestones are kept in the platform's Model lifecycle table (platform/model-lifecycle).
 */

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

const MODEL = 'model1'

function lifecycleRow(row: Row): GlideRecord {
    return recordOf<GlideRecord>('x_daas_ham_lifecycle_import', { sys_id: 'row1', manufacturer: 'Cisco', ...row })
}

beforeEach(() => {
    platform.reset()
    platform.parents = { cmdb_hardware_model_lifecycle: ['cmdb_model_lifecycle'] }
    platform.references = { 'cmdb_model_lifecycle.model': 'cmdb_model' }
    platform.tables.cmdb_model = [{ sys_id: MODEL, x_daas_ham_oem_pid: 'C9300-48P-E' }]
})

describe('importLifecycleRow', () => {
    it('refuses a milestone that goes backwards from the dates stored, and saves none of the row', () => {
        writeModelLifecycle(MODEL, { endOfSale: '2025-06-30', endOfSupport: '2030-06-30' }, { source: 'csv' })
        const outcome = importLifecycleRow(lifecycleRow({ pid: 'C9300-48P-E', end_of_support: '2024-01-31' }))
        expect(outcome).toEqual({ state: 'error', comment: expect.stringContaining('end of sale after end of support') })
        expect(readModelLifecycle(MODEL)).toEqual({ endOfSale: '2025-06-30', endOfSupport: '2030-06-30' })
    })

    it('keeps the milestones a row leaves blank and saves those it gives in order with them', () => {
        writeModelLifecycle(MODEL, { endOfSale: '2025-06-30' }, { source: 'csv' })
        expect(importLifecycleRow(lifecycleRow({ pid: 'C9300-48P-E', end_of_support: '2030-06-30' }))).toEqual({
            state: 'inserted',
            comment: 'Lifecycle for C9300-48P-E',
        })
        expect(readModelLifecycle(MODEL)).toEqual({ endOfSale: '2025-06-30', endOfSupport: '2030-06-30' })
    })

    it('still refuses a row with a date and no PID, or a PID no Model has', () => {
        expect(importLifecycleRow(lifecycleRow({ pid: ' ', end_of_sale: '2025-06-30' }))).toEqual({ state: 'error', comment: 'PID is required' })
        expect(importLifecycleRow(lifecycleRow({ pid: 'UNKNOWN-PID', end_of_sale: '2025-06-30' }))).toEqual({
            state: 'error',
            comment: 'PID UNKNOWN-PID does not map to a model',
        })
    })
})
