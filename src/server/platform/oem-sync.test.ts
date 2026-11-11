import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCK } from '../domain/lock-names.ts'
import type { CoverageRoute } from '../domain/oem/adapters.ts'
import type { OemVendor } from '../domain/vocabulary.ts'
import { withLock } from './locks.ts'
import { syncCoverage } from './oem-sync.ts'
import { platform } from '../test-support/fake-glide.ts'

/*
 * The coverage job run against the in-memory stand-in for the platform, job locks included (ADR 0013), with each
 * vendor's coverage route stood in by one that records the serials it is asked about and fails every call.
 */

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

const asked: Array<{ vendor: OemVendor; serials: string[] }> = []
let routeVendors: OemVendor[] = []

vi.mock('../domain/oem/adapters.ts', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../domain/oem/adapters.ts')>()),
    enabledRoutes: () =>
        routeVendors.map((vendor) => {
            const route: CoverageRoute = {
                via: 'cisco',
                run: (serials) => {
                    asked.push({ vendor, serials: [...serials] })
                    return { facts: [], errors: serials.map((serial) => `${serial}: HTTP 500`), failed: [...serials], rejected: [] }
                },
            }
            return { vendor, route }
        }),
}))

vi.mock('./oem-http.ts', () => ({ oemEnabled: () => true, oemContext: () => ({ http: () => ({ status: 0, body: '' }), orgIds: [] }) }))

const LOCKS = 'x_daas_ham_job_lock'

function staleAsset(id: string, vendor: OemVendor): void {
    platform.tables.cmdb_model.push({ sys_id: `model_${id}`, x_daas_ham_oem_source: vendor })
    platform.tables.alm_hardware.push({
        sys_id: id,
        model: `model_${id}`,
        serial_number: id.toUpperCase(),
        x_daas_ham_fleet: 'true',
        install_status: '1',
        x_daas_ham_coverage_checked: '',
    })
}

beforeEach(() => {
    platform.reset()
    asked.length = 0
    routeVendors = ['cisco']
    platform.uniqueKeys = { [LOCKS]: 'name' }
    platform.references = { 'alm_hardware.model': 'cmdb_model' }
    platform.tables.cmdb_model = []
    platform.tables.alm_hardware = []
    staleAsset('foc1', 'cisco')
})

describe('the coverage job', () => {
    it('asks about the stale Assets and lets its run lock go', () => {
        syncCoverage()

        expect(asked).toEqual([{ vendor: 'cisco', serials: ['FOC1'] }])
        expect(platform.tables[LOCKS] ?? []).toEqual([])
    })

    it('asks nothing while another run holds its lock, and says so', () => {
        const other = withLock(LOCK.oemCoverageRun(), () => syncCoverage())

        expect(other.ran).toBe(true)
        expect(asked).toEqual([])
        expect(platform.logs).toContainEqual(expect.stringContaining(`another run holds the ${LOCK.oemCoverageRun()} lock`))
    })
})
