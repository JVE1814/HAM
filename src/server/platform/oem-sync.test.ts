import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCK } from '../domain/lock-names.ts'
import type { CoverageRoute } from '../domain/oem/adapters.ts'
import type { OemVendor } from '../domain/vocabulary.ts'
import { withLock } from './locks.ts'
import { syncCoverage } from './oem-sync.ts'
import { platform } from '../test-support/fake-glide.ts'

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

const asked: Array<{ vendor: OemVendor; serials: string[] }> = []
let routeVendors: OemVendor[] = []

vi.mock('../domain/oem/adapters.ts', async (importOriginal) => {
    const adapters = await importOriginal<typeof import('../domain/oem/adapters.ts')>()
    return {
        ...adapters,
        enabledRoutes: () =>
            routeVendors.map((vendor) => {
                const route: CoverageRoute = {
                    api: adapters.OEM_ADAPTERS.cisco.api!,
                    run: (serials) => {
                        asked.push({ vendor, serials: [...serials] })
                        return { facts: [], errors: serials.map((serial) => `${serial}: HTTP 500`), failed: [...serials], rejected: [] }
                    },
                }
                return { vendor, route }
            }),
    }
})

vi.mock('./oem-http.ts', () => ({ apiEnabled: () => true, oemContext: () => ({ http: () => ({ status: 0, body: '' }), orgIds: [] }) }))

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

    it('logs its first 20 errors of the run, whichever vendor they are of, and counts the rest in one line', () => {
        routeVendors = ['cisco', 'mist']
        for (let i = 2; i <= 15; i++) staleAsset(`foc${i}`, 'cisco')
        for (let i = 1; i <= 15; i++) staleAsset(`mist${i}`, 'mist')

        syncCoverage()

        expect(asked.map(({ vendor, serials }) => `${vendor} ${serials.length}`)).toEqual(['cisco 15', 'mist 15'])
        expect(platform.warnings).toHaveLength(21)
        expect(platform.warnings.slice(0, 20)).toEqual(expect.arrayContaining([expect.stringMatching(/coverage: cisco: FOC\d+: HTTP 500/), expect.stringMatching(/coverage: mist: MIST\d+: HTTP 500/)]))
        expect(platform.warnings[20]).toBe('[x_daas_ham] coverage: and 10 more error(s) not logged')
    })

    it('asks nothing while another run holds its lock, and says so', () => {
        const other = withLock(LOCK.oemCoverageRun(), () => syncCoverage())

        expect(other.ran).toBe(true)
        expect(asked).toEqual([])
        expect(platform.logs).toContainEqual(expect.stringContaining(`another run holds the ${LOCK.oemCoverageRun()} lock`))
    })
})
