import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fieldsOf } from '../domain/lifecycle.ts'
import { LOCK } from '../domain/lock-names.ts'
import { raiseDueAttestations } from './attestations.ts'
import { withLock } from './locks.ts'
import { platform, type Row } from '../test-support/fake-glide.ts'

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

const ATTESTATIONS = 'x_daas_ham_attestation'
const ITEMS = 'x_daas_ham_attestation_item'
const LOCKS = 'x_daas_ham_job_lock'

const rows = (table: string): Row[] => platform.tables[table] ?? []

/** A fleet asset in service at a Site, under the attesting Agreement ag1. */
function installed(id: string, siteId: string): Row {
    const { installStatus, substatus } = fieldsOf('in_service')
    return { sys_id: id, x_daas_ham_fleet: 'true', x_daas_ham_agreement: 'ag1', x_daas_ham_site: siteId, install_status: installStatus, substatus: substatus ?? '' }
}

beforeEach(() => {
    platform.reset()
    platform.clock = Date.parse('2026-11-11T06:10:00Z')
    platform.uniqueKeys = { [LOCKS]: 'name' }
    // The platform sets a task active as it is inserted.
    platform.defaults = { [ATTESTATIONS]: () => ({ active: 'true' }) }
    platform.tables.x_daas_ham_agreement = [{ sys_id: 'ag1', state: 'active', attestation_interval_months: '12', customer: 'acme' }]
    platform.tables.alm_hardware = [installed('a1', 'site1')]
})

describe('the daily attestation run', () => {
    it('opens one attestation for a Site never attested, listing its installed Assets, and lets its run lock go', () => {
        raiseDueAttestations()
        raiseDueAttestations()

        expect(rows(ATTESTATIONS).map((attestation) => attestation.site)).toEqual(['site1'])
        expect(rows(ITEMS).map((item) => item.asset)).toEqual(['a1'])
        expect(rows(LOCKS)).toEqual([])
    })

    it('opens one attestation for a Site with several Assets, and none for an Asset at no Site', () => {
        rows('alm_hardware').push(installed('a2', 'site1'), installed('a3', ''))

        raiseDueAttestations()

        expect(rows(ATTESTATIONS).map((attestation) => attestation.site)).toEqual(['site1'])
        expect(rows(ITEMS).map((item) => item.asset)).toEqual(['a1', 'a2'])
    })

    it('opens an attestation for each Site of the Agreement, and none for a Site of an Agreement that attests nothing', () => {
        rows('x_daas_ham_agreement').push({ sys_id: 'ag2', state: 'active', attestation_interval_months: '0', customer: 'acme' })
        rows('alm_hardware').push(installed('a2', 'site2'), { ...installed('a3', 'site3'), x_daas_ham_agreement: 'ag2' })

        raiseDueAttestations()

        expect(rows(ATTESTATIONS).map((attestation) => attestation.site)).toEqual(['site1', 'site2'])
    })

    it('opens nothing while another run holds its lock, and says so', () => {
        const other = withLock(LOCK.attestationRun(), () => raiseDueAttestations())

        expect(other.ran).toBe(true)
        expect(rows(ATTESTATIONS)).toEqual([])
        expect(platform.logs).toContainEqual(expect.stringContaining(LOCK.attestationRun()))
    })

    it('opens no further attestation once it has lost its lock', () => {
        rows('alm_hardware').push(installed('a2', 'site2'))
        // The run's lock is taken as abandoned and cleared while its first attestation is saved.
        platform.onSave = (table, _row, operation) => {
            if (table === ATTESTATIONS && operation === 'insert') platform.tables[LOCKS] = []
        }

        raiseDueAttestations()

        expect(rows(ATTESTATIONS).map((attestation) => attestation.site)).toEqual(['site1'])
        expect(platform.warnings).toEqual([expect.stringContaining('Attestation run stopped')])
    })
})
