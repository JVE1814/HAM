import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generateBillingLines, guardBillingPeriodMonth, uiCloseBillingPeriod, uiRegenerateBillingPeriod } from './billing.ts'
import { generateNewPeriod } from '../platform/billing.ts'
import { EVENT } from '../domain/events.ts'
import { platform, recordOf, type Row } from '../test-support/fake-glide.ts'
import type { GlideRecord } from '@servicenow/glide'

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

/** Run each generation chunk queued, as its script action does; every other event is dropped. */
function drainGeneration(): void {
    for (let event = platform.events.shift(); event; event = platform.events.shift()) {
        if (event.name !== EVENT.billingGenerate) continue
        generateBillingLines(recordOf('sysevent', { name: event.name, parm1: event.parm1, parm2: event.parm2 }), recordOf(PERIOD, { sys_id: event.record }))
    }
}

/** What finance is told on running a UI action on the period `current`. */
function told(action: (current: GlideRecord) => void, current: GlideRecord): string[] {
    const before = platform.messages
    platform.messages = []
    action(current)
    const said = platform.messages
    platform.messages = before
    return said
}

const close = (current: GlideRecord) => told(uiCloseBillingPeriod, current)
const regenerate = (current: GlideRecord) => told(uiRegenerateBillingPeriod, current)
const closed = (month: string) => [`info ${month} closed and locked; the CSV export and margin are being prepared`]
const regenerating = (month: string) => [`info Regenerating ${month}`]

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
        expect(close(period('2026-08'))).toEqual([expect.stringMatching(/^error 2026-08 did not generate cleanly/)])
        expect(periodRow('2026-08')?.status).toBe('ready')
        expect(fee('fee1')?.status).toBe('open')

        expect(regenerate(period('2026-08'))).toEqual(regenerating('2026-08'))
        drainGeneration()
        expect(linesOf('2026-08').map((line) => [line.kind, line.amount])).toEqual([['subscription', '154.84']])
        expect(close(period('2026-08'))).toEqual(closed('2026-08'))
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

        expect(regenerate(period('2026-10'))).toEqual(regenerating('2026-10'))
        drainGeneration()
        expect(linesOf('2026-10').map((line) => line.fee_event ?? '')).toEqual(['', 'fee2'])
        expect(close(period('2026-10'))).toEqual(closed('2026-10'))
    })
})

describe('Close period', () => {
    it('queues the CSV export and the margin of a period it closes, and neither of one it does not', () => {
        generate('2026-09')
        const periodId = periodRow('2026-09')?.sys_id
        expect(close(period('2026-09'))).toEqual(closed('2026-09'))
        expect(platform.events.map((event) => [event.name, event.parm1])).toEqual([
            [EVENT.billingExport, periodId],
            [EVENT.marginCompute, periodId],
        ])

        platform.events.length = 0
        expect(close(period('2026-09'))).toEqual(['error Only a period ready for review can be closed'])
        expect(platform.events).toEqual([])
    })

    it('marks the open fees it bills billed, and takes a fee waived during review off the period with its line', () => {
        rows(FEE).push(
            { sys_id: 'fee2', fee_type: 'damaged', customer: 'acme', agreement: 'ag1', asset: 'a2', amount: '30', occurred_on: '2026-09-21', status: 'open' },
            { sys_id: 'fee3', fee_type: 'lost', customer: 'acme', agreement: 'ag1', asset: 'a3', amount: '50', occurred_on: '2026-10-02', status: 'open' },
        )
        generate('2026-09')
        Object.assign(fee('fee2') ?? {}, { status: 'waived' })

        expect(close(period('2026-09'))).toEqual(closed('2026-09'))

        const periodId = periodRow('2026-09')?.sys_id
        expect(fee('fee1')).toMatchObject({ status: 'billed', billing_period: periodId })
        expect(fee('fee2')).toMatchObject({ status: 'waived', billing_period: '' })
        expect(fee('fee3')).toMatchObject({ status: 'open' })
        expect(linesOf('2026-09').map((line) => line.fee_event).filter(Boolean)).toEqual(['fee1'])
    })
})

describe('Close and Regenerate of one period at once', () => {
    it('does not close a period a Regenerate has emptied since its form was read', () => {
        generate('2026-09')
        const closing = period('2026-09')
        expect(regenerate(period('2026-09'))).toEqual(regenerating('2026-09'))

        expect(close(closing)).toEqual(['error Only a period ready for review can be closed'])
        drainGeneration()
        expect(periodRow('2026-09')).toMatchObject({ status: 'ready', line_count: '2' })
        expect(fee('fee1')?.status).toBe('open')
    })

    it('does not regenerate a period closed since its form was read', () => {
        generate('2026-09')
        const regeneratingForm = period('2026-09')
        expect(close(period('2026-09'))).toEqual(closed('2026-09'))

        expect(regenerate(regeneratingForm)).toEqual(['error Only a period ready for review can be regenerated'])
        expect(periodRow('2026-09')?.status).toBe('closed')
        expect(linesOf('2026-09')).toHaveLength(2)
    })

    it('does not close a period on a clean generation its Regenerate has since found failing', () => {
        generate('2026-09')
        const closing = period('2026-09')
        platform.tables.x_daas_ham_agreement = [{ sys_id: 'ag1', number: 'NAG0001', currency: '' }]
        expect(regenerate(period('2026-09'))).toEqual(regenerating('2026-09'))
        drainGeneration()

        expect(close(closing)).toEqual([expect.stringMatching(/^error 2026-09 did not generate cleanly \(2 line\(s\) failed/)])
        expect(periodRow('2026-09')?.status).toBe('ready')
    })

    it('leaves the period to the Close running on it', () => {
        generate('2026-09')
        const meanwhile: string[][] = []
        platform.onSave = (table, row) => {
            if (table !== PERIOD || row.status !== 'closed' || meanwhile.length > 0) return
            // A Regenerate and a second Close come in while the first Close saves the period.
            meanwhile.push(regenerate(period('2026-09')), close(period('2026-09')))
        }

        expect(close(period('2026-09'))).toEqual(closed('2026-09'))
        expect(meanwhile).toEqual([
            ['error 2026-09 not regenerated: a Close or Regenerate of it is running; try again'],
            ['error 2026-09 not closed: a Close or Regenerate of it is running; try again'],
        ])
        expect(periodRow('2026-09')?.status).toBe('closed')
        expect(linesOf('2026-09')).toHaveLength(2)
    })
})

describe('a fee whose date is moved past its period during review', () => {
    it('leaves the period at its Regenerate, open for the month it now falls in', () => {
        generate('2026-09')
        const moved = recordOf<GlideRecord>(FEE, fee('fee1') ?? {})
        moved.setValue('occurred_on', '2026-10-02')
        moved.update()

        expect(regenerate(period('2026-09'))).toEqual(regenerating('2026-09'))
        drainGeneration()
        expect(linesOf('2026-09').map((line) => line.kind)).toEqual(['subscription'])
        expect(close(period('2026-09'))).toEqual(closed('2026-09'))
        expect(fee('fee1')).toMatchObject({ status: 'open', billing_period: '' })

        generate('2026-10')
        expect(linesOf('2026-10').map((line) => [line.kind, line.amount])).toEqual([
            ['subscription', '300'],
            ['fee', '50'],
        ])
    })
})
