import { GlideRecord } from '@servicenow/glide'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadNormalizationData, resolveModel, resolveNormalizationException } from './normalization.ts'
import { platform } from '../test-support/fake-glide.ts'

/*
 * Resolving a normalization exception against in-memory tables: the alias and rule it learns must map its raw pair on
 * the next run.
 */

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

const EXCEPTIONS = 'x_daas_ham_norm_exception'
const RAW = { manufacturer: 'Cisco', model: 'MR46 Cloud Managed AP' }

function resolvedException(): GlideRecord {
    platform.tables[EXCEPTIONS] = [
        { sys_id: 'exc1', raw_manufacturer: RAW.manufacturer, raw_model: RAW.model, resolved_model: 'mr46', status: 'open' },
    ]
    const exception = new GlideRecord(EXCEPTIONS)
    exception.get('exc1')
    return exception
}

beforeEach(() => {
    platform.reset()
    platform.references = { [`${EXCEPTIONS}.resolved_model`]: 'cmdb_model' }
    // What the platform fills in on insert: a rule's active flag.
    platform.defaults = { x_daas_ham_model_match_rule: () => ({ active: 'true' }) }
    platform.tables.cmdb_model = [{ sys_id: 'mr46', name: 'MR46', manufacturer: 'meraki' }]
})

describe('resolveNormalizationException', () => {
    it('learns a rule that maps the raw pair when an alias already points its manufacturer at another company', () => {
        platform.tables.x_daas_ham_manufacturer_alias = [{ sys_id: 'al1', alias: 'Cisco', manufacturer: 'cisco' }]
        expect(resolveNormalizationException(resolvedException())).toEqual({ learned: true })
        expect(platform.tables.x_daas_ham_manufacturer_alias).toHaveLength(1)
        expect(resolveModel(RAW, loadNormalizationData())).toEqual({ modelId: 'mr46' })
    })

    it('learns an alias to the resolved Model manufacturer for a manufacturer no alias covers, and the rule under it', () => {
        expect(resolveNormalizationException(resolvedException())).toEqual({ learned: true })
        expect(platform.tables.x_daas_ham_manufacturer_alias).toEqual([expect.objectContaining({ alias: 'Cisco', manufacturer: 'meraki' })])
        expect(resolveModel(RAW, loadNormalizationData())).toEqual({ modelId: 'mr46' })
    })
})
