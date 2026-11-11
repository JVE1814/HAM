import { beforeEach, describe, expect, it, vi } from 'vitest'
import { completePass, findJobCursor, isCurrentPass, JOB_STATUS, openJobCursor, retirePass, startPass } from './job-cursor.ts'
import { JOB_ERROR_LENGTH, JOB_STATUS_LENGTH } from '../domain/chunked-job.ts'
import { platform, type Row } from '../test-support/fake-glide.ts'

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

const CURSORS = 'x_daas_ham_job_cursor'

const cursorRow = (job: string): Row | undefined => (platform.tables[CURSORS] ?? []).find((row) => row.job === job)

beforeEach(() => {
    platform.reset()
    platform.uniqueKeys = { [CURSORS]: 'job' }
    platform.clock = Date.parse('2025-11-09T12:00:00Z')
})

describe('the job cursor repository', () => {
    it('creates a job row on first use and finds it from then on', () => {
        expect(findJobCursor('job1')).toBeNull()
        expect(openJobCursor('job1').cursor).toBe('')
        expect(openJobCursor('job1').save({ cursor: 'k1', status: JOB_STATUS.paused, processed: 3, ranNow: true })).toBeNull()
        expect(platform.tables[CURSORS]).toEqual([
            expect.objectContaining({ job: 'job1', cursor: 'k1', last_status: 'paused (time budget)', processed_total: '3', last_run: '2025-11-09 12:00:00' }),
        ])
        expect(findJobCursor('job1')).toMatchObject({ cursor: 'k1', lastRun: '2025-11-09 12:00:00' })
    })

    it('goes on from the row another run inserted first', () => {
        // The other run's insert lands between this run's read and its own insert.
        platform.refuses = (table, row) => {
            if (table !== CURSORS || cursorRow(row.job ?? '')) return ''
            platform.tables[CURSORS] = [{ sys_id: 'theirs', job: row.job ?? '', cursor: 'k9' }]
            return 'Unique Key violation detected by database'
        }
        expect(openJobCursor('job1').cursor).toBe('k9')
        expect(platform.tables[CURSORS]).toHaveLength(1)
    })

    it('says why when a row can be neither created nor found', () => {
        platform.refuses = () => 'no rights'
        expect(() => openJobCursor('job1')).toThrow('job cursor job1 could not be created: no rights')
    })

    it('leaves what a save does not name as it is', () => {
        openJobCursor('job1').save({ cursor: '41', status: 'x', ranNow: true })
        platform.clock += 60000
        expect(openJobCursor('job1').save({ cursor: '42' })).toBeNull()
        expect(cursorRow('job1')).toMatchObject({ cursor: '42', last_status: 'x', last_run: '2025-11-09 12:00:00' })
    })

    it('cuts a status and an error to the lengths of their columns', () => {
        openJobCursor('job1').save({ status: 's'.repeat(JOB_STATUS_LENGTH + 1), lastError: 'e'.repeat(JOB_ERROR_LENGTH + 1) })
        expect(cursorRow('job1')).toMatchObject({ last_status: 's'.repeat(JOB_STATUS_LENGTH), last_error: 'e'.repeat(JOB_ERROR_LENGTH) })
    })

    it('reports a refused save with why', () => {
        const row = openJobCursor('job1')
        platform.refuses = () => 'read only'
        expect(row.save({ cursor: 'k1' })).toBe('read only')
    })
})

describe('passes on a job cursor', () => {
    it('makes each new pass the current one, and the one before it stale', () => {
        const first = startPass('job1', JOB_STATUS.running)
        expect(cursorRow('job1')).toMatchObject({ cursor: first, last_status: 'running', last_run: '2025-11-09 12:00:00' })
        expect(isCurrentPass('job1', first)).toBe(true)
        platform.clock += 1000
        const second = startPass('job1', JOB_STATUS.passStarted)
        expect(second).not.toBe(first)
        expect(isCurrentPass('job1', first)).toBe(false)
        expect(isCurrentPass('job1', second)).toBe(true)
        expect(cursorRow('job1')).toMatchObject({ last_status: 'pass started' })
    })

    it('has no current pass for a job without a row, or for an event that names none', () => {
        expect(isCurrentPass('job1', 'some-pass')).toBe(false)
        startPass('job1', JOB_STATUS.running)
        expect(isCurrentPass('job1', '')).toBe(false)
    })

    it('does not start a pass whose token is refused', () => {
        openJobCursor('job1')
        platform.refuses = () => 'read only'
        expect(() => startPass('job1', JOB_STATUS.running)).toThrow('job cursor job1 not saved: read only')
    })

    it('retires a pass by hand without touching its last run', () => {
        const token = startPass('job1', JOB_STATUS.passStarted)
        platform.clock += 60000
        const row = findJobCursor('job1')
        expect(row && retirePass(row)).toBeNull()
        expect(isCurrentPass('job1', token)).toBe(false)
        expect(cursorRow('job1')).toMatchObject({ cursor: '', last_status: 'reset by hand', last_run: '2025-11-09 12:00:00' })
    })

    it('marks a pass complete, keeping its token', () => {
        const token = startPass('job1', JOB_STATUS.running)
        platform.clock += 60000
        completePass('job1')
        expect(cursorRow('job1')).toMatchObject({ cursor: token, last_status: 'complete', last_run: '2025-11-09 12:01:00' })
    })

    it('logs a completion the platform refuses instead of throwing: the pass itself is complete', () => {
        const token = startPass('job1', JOB_STATUS.running)
        platform.refuses = () => 'read only'
        expect(() => completePass('job1')).not.toThrow()
        expect(cursorRow('job1')).toMatchObject({ cursor: token, last_status: 'running' })
        expect(platform.warnings).toEqual([expect.stringMatching(/\bjob1\b.*: read only$/)])
    })
})
