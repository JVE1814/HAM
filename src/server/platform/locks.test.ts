import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ABANDONED_AFTER_MINUTES } from '../domain/job-lock.ts'
import { withLock } from './locks.ts'
import { platform } from '../test-support/fake-glide.ts'

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

const LOCKS = 'x_daas_ham_job_lock'
const MINUTE_MS = 60_000

beforeEach(() => {
    platform.reset()
    platform.uniqueKeys = { [LOCKS]: 'name' }
})

describe('a job lock the platform refuses to delete', () => {
    it('is logged when it is released, and stays held until it is taken as abandoned', () => {
        platform.refuses = (table, _row, operation) => (table === LOCKS && operation === 'delete' ? 'no rights' : '')
        expect(withLock('lock1', () => 'done')).toEqual({ ran: true, value: 'done' })
        expect(platform.warnings).toEqual([expect.stringMatching(/\block1\b.*not released: no rights\b/)])

        platform.refuses = () => ''
        platform.clock += (ABANDONED_AFTER_MINUTES - 1) * MINUTE_MS
        expect(withLock('lock1', () => 'taken')).toMatchObject({ ran: false })
        platform.clock += 2 * MINUTE_MS
        expect(withLock('lock1', () => 'taken')).toEqual({ ran: true, value: 'taken' })
        expect(platform.tables[LOCKS]).toEqual([])
    })
})
