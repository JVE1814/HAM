import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fieldsOf } from '../domain/lifecycle.ts'
import { LOCK } from '../domain/lock-names.ts'
import { PROPERTY } from '../domain/properties.ts'
import { REST_MESSAGE } from '../domain/rest-message-names.ts'
import type { OemVendor } from '../domain/vocabulary.ts'
import { withLock } from './locks.ts'
import { syncCoverage } from './oem-sync.ts'
import { platform } from '../test-support/fake-glide.ts'

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

/** Every call the vendors are sent, by REST message and the values set on it; each is answered HTTP 500. */
const sent: Array<{ message: string; values: string[] }> = []

vi.mock('@servicenow/glide/sn_ws', () => ({
    RESTMessageV2: class {
        private readonly values: string[] = []
        constructor(private readonly message: string) {}
        setStringParameterNoEscape(_name: string, value: string): void {
            this.values.push(decodeURIComponent(value))
        }
        setRequestHeader(): void {}
        setRequestBody(): void {}
        execute() {
            sent.push({ message: this.message, values: this.values })
            return { getStatusCode: () => 500, getBody: () => '', getErrorMessage: () => '' }
        }
    },
}))

const LOCKS = 'x_daas_ham_job_lock'

function staleAsset(id: string, vendor: OemVendor): void {
    const { installStatus, substatus } = fieldsOf('in_service')
    platform.tables.cmdb_model.push({ sys_id: `model_${id}`, x_daas_ham_oem_source: vendor })
    platform.tables.alm_hardware.push({
        sys_id: id,
        model: `model_${id}`,
        serial_number: id.toUpperCase(),
        x_daas_ham_fleet: 'true',
        install_status: installStatus,
        substatus: substatus ?? '',
        x_daas_ham_coverage_checked: '',
    })
}

function enable(...vendors: Array<'cisco' | 'fortinet' | 'mist'>): void {
    for (const vendor of vendors) platform.properties[PROPERTY.oemEnabled[vendor].name] = 'true'
}

beforeEach(() => {
    platform.reset()
    sent.length = 0
    platform.uniqueKeys = { [LOCKS]: 'name' }
    platform.references = { 'alm_hardware.model': 'cmdb_model' }
    platform.properties = { [PROPERTY.oemOrgIds.mist.name]: 'org1' }
    platform.tables.cmdb_model = []
    platform.tables.alm_hardware = []
})

describe('the coverage job', () => {
    it('asks the vendor about the stale Assets and lets its run lock go', () => {
        enable('cisco')
        staleAsset('foc1', 'cisco')

        syncCoverage()

        expect(sent).toEqual([{ message: REST_MESSAGE.ciscoSupport.name, values: ['FOC1'] }])
        expect(platform.tables[LOCKS] ?? []).toEqual([])
    })

    it('logs its first 20 errors of the run, whichever vendor they are of, and counts the rest in one line', () => {
        enable('fortinet', 'mist')
        for (let i = 1; i <= 15; i++) staleAsset(`fgt${i}`, 'fortinet')
        for (let i = 1; i <= 15; i++) staleAsset(`mist${i}`, 'mist')

        syncCoverage()

        expect(platform.warnings).toHaveLength(21)
        expect(platform.warnings.slice(0, 20)).toEqual(expect.arrayContaining([expect.stringContaining('fortinet'), expect.stringContaining('mist')]))
        expect(platform.warnings[20]).toContain('10 more')
    })

    it('asks nothing while another run holds its lock, and says so', () => {
        enable('cisco')
        staleAsset('foc1', 'cisco')

        const other = withLock(LOCK.oemCoverageRun(), () => syncCoverage())

        expect(other.ran).toBe(true)
        expect(sent).toEqual([])
        expect(platform.logs).toContainEqual(expect.stringContaining(LOCK.oemCoverageRun()))
    })
})
