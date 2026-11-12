import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCK } from '../domain/lock-names.ts'
import { runLeaseReview } from './leases.ts'
import { withLock } from './locks.ts'
import { platform, type Row } from '../test-support/fake-glide.ts'

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

const LEASES = 'x_daas_ham_lease_schedule'
const DECISIONS = 'x_daas_ham_lease_decision'
const LOCKS = 'x_daas_ham_job_lock'

const rows = (table: string): Row[] => platform.tables[table] ?? []

/** An undecided lease that ends within its decision lead time, with no decision open. */
function lease(id: string): Row {
    return { sys_id: id, number: id.toUpperCase(), end_action: 'undecided', ends: '2026-12-01', decision_lead_days: '90', mismatch: 'false' }
}

beforeEach(() => {
    platform.reset()
    platform.clock = Date.parse('2026-11-11T05:35:00Z')
    platform.uniqueKeys = { [LOCKS]: 'name' }
    // The platform sets a task active as it is inserted.
    platform.defaults = { [DECISIONS]: () => ({ active: 'true' }) }
    platform.references = { 'alm_hardware.x_daas_ham_lease': LEASES }
    platform.tables[LEASES] = [lease('ls1')]
})

describe('the daily lease review', () => {
    it('raises the decision of a lease that ends within its lead time, once, and lets its run lock go', () => {
        runLeaseReview()
        runLeaseReview()

        expect(rows(DECISIONS).map((decision) => decision.lease)).toEqual(['ls1'])
        expect(rows(LOCKS)).toEqual([])
    })

    it('raises nothing while another run holds its lock, and says so', () => {
        const other = withLock(LOCK.leaseReviewRun(), () => runLeaseReview())

        expect(other.ran).toBe(true)
        expect(rows(DECISIONS)).toEqual([])
        expect(platform.logs).toContainEqual(expect.stringContaining(LOCK.leaseReviewRun()))
    })

    it('raises no further decision once it has lost its lock', () => {
        rows(LEASES).push(lease('ls2'))
        // The run's lock is taken as abandoned and cleared while its first decision is saved.
        platform.onSave = (table) => {
            if (table === DECISIONS) platform.tables[LOCKS] = []
        }

        runLeaseReview()

        expect(rows(DECISIONS).map((decision) => decision.lease)).toEqual(['ls1'])
        expect(platform.warnings).toEqual([expect.stringContaining('Lease review stopped')])
    })
})
