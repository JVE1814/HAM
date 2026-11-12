import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FeeIdentity } from '../domain/fees.ts'
import { LOCK } from '../domain/lock-names.ts'
import { waiveOpenFees } from './fees.ts'
import { platform, type Row } from '../test-support/fake-glide.ts'

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

const FEES = 'x_daas_ham_fee_event'
const PERIODS = 'x_daas_ham_billing_period'
const LOCKS = 'x_daas_ham_job_lock'

const LOST: FeeIdentity = { type: 'lost', assetId: 'a1', returnOrderId: 'ret1' }

const rows = (table: string): Row[] => platform.tables[table] ?? []
const errors = () => platform.logs.filter((line) => line.startsWith('error '))

/** The open lost fee of a1 on ret1, on the Billing period `periodId` ('' for none). */
function charged(periodId = ''): void {
    platform.tables[FEES] = [{ sys_id: 'fee1', fee_type: 'lost', asset: 'a1', return_order: 'ret1', status: 'open', billing_period: periodId }]
}

/** Another transaction holds the lock `name`, taken just now. */
function held(name: string): void {
    rows(LOCKS).push({ sys_id: `lock${rows(LOCKS).length}`, name, sys_created_on: '2026-11-11 12:00:00' })
}

beforeEach(() => {
    platform.reset()
    platform.clock = Date.parse('2026-11-11T12:00:00Z')
    platform.uniqueKeys = { [LOCKS]: 'name' }
    platform.tables[LOCKS] = []
    platform.tables[PERIODS] = [
        { sys_id: 'p9', period: '2026-09', status: 'closed' },
        { sys_id: 'p10', period: '2026-10', status: 'ready' },
    ]
})

describe('waiving the lost fee of a unit that turned up', () => {
    it('waives an open charge on no Billing period, and lets its lock go', () => {
        charged()

        waiveOpenFees(LOST)

        expect(rows(FEES)[0]?.status).toBe('waived')
        expect(rows(LOCKS)).toEqual([])
        expect(platform.logs).toEqual([])
    })

    it('waives a charge on a period ready for review, and leaves it on the period for its Close to take off', () => {
        charged('p10')

        waiveOpenFees(LOST)

        expect(rows(FEES)[0]).toMatchObject({ status: 'waived', billing_period: 'p10' })
        expect(rows(LOCKS)).toEqual([])
    })

    it('leaves a charge on a closed period open, and says to credit it', () => {
        charged('p9')

        waiveOpenFees(LOST)

        expect(rows(FEES)[0]?.status).toBe('open')
        expect(errors()).toEqual([expect.stringContaining('Billing period 2026-09 bills it and is closed')])
        expect(rows(LOCKS)).toEqual([])
    })

    it('leaves the charge open while a generation holds its lock, and says so', () => {
        charged()
        held(LOCK.fee(LOST))

        waiveOpenFees(LOST)

        expect(rows(FEES)[0]?.status).toBe('open')
        expect(errors()).toEqual([expect.stringContaining('a run billing it holds its lock')])
    })

    it("leaves a charge open while its period's lock is held by a Close or Regenerate, and says so", () => {
        charged('p10')
        held(LOCK.billingPeriod('p10'))

        waiveOpenFees(LOST)

        expect(rows(FEES)[0]?.status).toBe('open')
        expect(errors()).toEqual([expect.stringContaining("its Billing period's lock is held")])
        expect(rows(LOCKS).map((lock) => lock.name)).toEqual([LOCK.billingPeriod('p10')])
    })
})
