import { beforeEach, describe, expect, it, vi } from 'vitest'
import { guardBillingPeriodMonth } from './billing.ts'
import { closePeriod, generateChunk, generateNewPeriod, regeneratePeriod } from '../platform/billing.ts'
import { EVENT } from '../platform/events.ts'
import { platform, recordOf, type Row } from '../test-support/fake-glide.ts'
import type { GlideRecord } from '@servicenow/glide'

/* Billing periods generated, changed under review and closed, against the in-memory stand-in for the platform. */

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

const PERIOD = 'x_daas_ham_billing_period'
const LINE = 'x_daas_ham_billing_line'
const FEE = 'x_daas_ham_fee_event'
const SUBSCRIPTION = 'x_daas_ham_subscription_line'

const rows = (table: string): Row[] => platform.tables[table] ?? []
const periodRow = (month: string): Row | undefined => rows(PERIOD).find((row) => row.period === month)
const linesOf = (month: string): Row[] => rows(LINE).filter((line) => line.billing_period === periodRow(month)?.sys_id)
const fee = (id: string): Row | undefined => rows(FEE).find((row) => row.sys_id === id)

function period(month: string): GlideRecord {
    const row = periodRow(month)
    if (!row) throw new Error(`no period ${month}`)
    return recordOf<GlideRecord>(PERIOD, row)
}

/** Run every generation chunk queued, as the event queue would, until none is left. */
function drainGeneration(): void {
    for (let event = platform.events.shift(); event; event = platform.events.shift()) {
        if (event.name !== EVENT.billingGenerate) continue
        generateChunk({ name: event.name, record: recordOf(PERIOD, { sys_id: event.record }), subject: event.parm1, position: event.parm2 })
    }
}

/** Create the period of `month` as finance does by hand, and run its generation. */
function generate(month: string): void {
    const created = recordOf<GlideRecord>(PERIOD, { period: month, status: 'generating' }, { fresh: true })
    guardBillingPeriodMonth(created)
    created.insert()
    generateNewPeriod(created)
    drainGeneration()
}

/** Save the period with its month changed, as the form does: the month rule runs first. */
function changeMonth(from: string, to: string): void {
    const edited = period(from)
    edited.setValue('period', to)
    guardBillingPeriodMonth(edited)
    edited.update()
}

beforeEach(() => {
    platform.reset()
    platform.clock = Date.parse('2026-11-11T12:00:00Z')
    platform.uniqueKeys = { x_daas_ham_job_lock: 'name', x_daas_ham_job_cursor: 'job' }
    platform.references = { [`${SUBSCRIPTION}.agreement`]: 'x_daas_ham_agreement', [`${FEE}.agreement`]: 'x_daas_ham_agreement' }
    platform.tables.x_daas_ham_agreement = [{ sys_id: 'ag1', number: 'NAG0001', currency: 'EUR' }]
    platform.tables[SUBSCRIPTION] = [
        {
            sys_id: 'sub1',
            agreement: 'ag1',
            customer: 'acme',
            line_type: 'site_package',
            description: 'Site package',
            monthly_rate: '300',
            start_date: '2026-08-16',
            status: 'active',
        },
    ]
    platform.tables[FEE] = [
        { sys_id: 'fee1', fee_type: 'lost', customer: 'acme', agreement: 'ag1', asset: 'a1', amount: '50', occurred_on: '2026-09-20', status: 'open' },
    ]
})

describe('a period whose month is changed after it was generated', () => {
    it('is not closed until a Regenerate bills the new month', () => {
        generate('2026-09')
        expect(linesOf('2026-09').map((line) => line.amount)).toEqual(['300', '50'])

        changeMonth('2026-09', '2026-08')
        expect(closePeriod(period('2026-08'))).toEqual({ done: false, why: expect.stringContaining('2026-08 did not generate cleanly') })
        expect(fee('fee1')?.status).toBe('open')

        expect(regeneratePeriod(period('2026-08'))).toEqual({ done: true })
        drainGeneration()
        expect(linesOf('2026-08').map((line) => [line.kind, line.amount])).toEqual([['subscription', '154.84']])
        expect(closePeriod(period('2026-08'))).toEqual({ done: true })
        expect(fee('fee1')).toMatchObject({ status: 'open', billing_period: '' })
    })
})

describe('two months generating at once', () => {
    it('bill each open fee on one of them only', () => {
        platform.tables[FEE]?.push({ ...fee('fee1'), sys_id: 'fee2', asset: 'a2' })
        let overlapped = false
        platform.onSave = (table, row, operation) => {
            if (overlapped || table !== LINE || operation !== 'insert' || row.kind !== 'fee') return
            overlapped = true
            // October generates while September is adding its first fee line.
            generate('2026-10')
        }
        generate('2026-09')

        const feeLines = rows(LINE).filter((line) => line.kind === 'fee')
        expect(feeLines.map((line) => line.fee_event).sort()).toEqual(['fee1', 'fee2'])
        for (const billed of feeLines) expect(fee(billed.fee_event ?? '')?.billing_period).toBe(billed.billing_period)
        expect(fee('fee1')?.billing_period).toBe(periodRow('2026-09')?.sys_id)
        expect(periodRow('2026-10')).toMatchObject({ failed_lines: '1', last_error: 'fee1: another run held its lock through every try' })

        expect(regeneratePeriod(period('2026-10'))).toEqual({ done: true })
        drainGeneration()
        expect(linesOf('2026-10').map((line) => line.fee_event ?? '')).toEqual(['', 'fee2'])
        expect(closePeriod(period('2026-10'))).toEqual({ done: true })
    })
})

describe('a fee whose date is moved past its period during review', () => {
    it('leaves the period at its Regenerate, open for the month it now falls in', () => {
        generate('2026-09')
        const moved = recordOf<GlideRecord>(FEE, fee('fee1') ?? {})
        moved.setValue('occurred_on', '2026-10-02')
        moved.update()

        expect(regeneratePeriod(period('2026-09'))).toEqual({ done: true })
        drainGeneration()
        expect(linesOf('2026-09').map((line) => line.kind)).toEqual(['subscription'])
        expect(closePeriod(period('2026-09'))).toEqual({ done: true })
        expect(fee('fee1')).toMatchObject({ status: 'open', billing_period: '' })

        generate('2026-10')
        expect(linesOf('2026-10').map((line) => [line.kind, line.amount])).toEqual([
            ['subscription', '300'],
            ['fee', '50'],
        ])
    })
})
