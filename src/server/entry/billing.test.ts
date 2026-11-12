import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
    exportBillingPeriod,
    generateBillingLines,
    getBillingLines,
    guardBillingPeriodMonth,
    listBillingPeriods,
    onAssetServiceChange,
    uiCloseBillingPeriod,
    uiExportBillingPeriod,
    uiRegenerateBillingPeriod,
    uiResetBillingGeneration,
} from './billing.ts'
import { generateNewPeriod, type BillingLinesPage } from '../platform/billing.ts'
import { waiveOpenFees } from '../platform/fees.ts'
import { PULL_PAGE } from '../domain/billing.ts'
import { EVENT } from '../domain/events.ts'
import { fieldsOf, type Stage } from '../domain/lifecycle.ts'
import { ROLE } from '../domain/roles.ts'
import { platform, recordOf, type Row } from '../test-support/fake-glide.ts'
import type { GlideRecord } from '@servicenow/glide'
import type { RESTAPIRequest, RESTAPIResponse } from '@servicenow/glide/sn_ws_int'

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

const PERIOD = 'x_daas_ham_billing_period'
const LINE = 'x_daas_ham_billing_line'
const FEE = 'x_daas_ham_fee_event'
const SUBSCRIPTION = 'x_daas_ham_subscription_line'
const CURSOR = 'x_daas_ham_job_cursor'
const ATTACHMENT = 'sys_attachment'

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

/** Create the period of `month` as finance does by hand: its first generation chunk is queued, not run. */
function create(month: string): void {
    const created = recordOf<GlideRecord>(PERIOD, { period: month, status: 'generating' }, { fresh: true })
    guardBillingPeriodMonth(created)
    created.insert()
    generateNewPeriod(created)
}

/** Create the period of `month` as finance does by hand, and run its generation. */
function generate(month: string): void {
    create(month)
    drainGeneration()
}

/** Run each CSV export queued, as its script action does; every other event is dropped. */
function drainExport(): void {
    for (let event = platform.events.shift(); event; event = platform.events.shift()) {
        if (event.name === EVENT.billingExport) exportBillingPeriod(recordOf('sysevent', { name: event.name, parm1: event.parm1 }))
    }
}

/** Call a route of the pull API as the platform does, each query parameter an array, for a user holding `roles`. */
function pull(
    route: (request: RESTAPIRequest, response: RESTAPIResponse) => void,
    sent: { id?: string; query?: Record<string, string> } = {},
    roles: string[] = [ROLE.billingReader],
): { status: number; body: unknown } {
    platform.user = { ...platform.user, roles }
    const reply = { status: 0, body: null as unknown }
    const queryParams = Object.fromEntries(Object.entries(sent.query ?? {}).map(([name, value]) => [name, [value]]))
    const request = { pathParams: { id: sent.id }, queryParams } as unknown as RESTAPIRequest
    const response = {
        setStatus: (status: number) => void (reply.status = status),
        setBody: (body: unknown) => void (reply.body = body),
    } as unknown as RESTAPIResponse
    route(request, response)
    return reply
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

describe('a fee waived while its period is being closed', () => {
    it('stays open for the Close to mark billed, as its line is on the closed bill, and is logged to credit', () => {
        Object.assign(fee('fee1') ?? {}, { return_order: 'ret1' })
        generate('2026-09')
        let scanned = false
        platform.onSave = (table, row) => {
            if (table !== PERIOD || row.status !== 'closed' || scanned) return
            scanned = true
            // The missing unit is scanned in at the depot while the Close saves the period, after it took the waived fees off.
            waiveOpenFees({ type: 'lost', assetId: 'a1', returnOrderId: 'ret1' })
        }

        expect(close(period('2026-09'))).toEqual(closed('2026-09'))

        expect(scanned).toBe(true)
        expect(fee('fee1')).toMatchObject({ status: 'billed', billing_period: periodRow('2026-09')?.sys_id })
        expect(linesOf('2026-09').map((line) => line.fee_event).filter(Boolean)).toEqual(['fee1'])
        expect(platform.logs).toContainEqual(expect.stringContaining("lost fee fee1 not waived: its Billing period's lock is held"))
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

describe('the billing pull API', () => {
    const line = (sysId: string, customer: string, amount: string, currency = 'EUR'): Row => ({
        sys_id: sysId,
        billing_period: 'p9',
        kind: 'subscription',
        customer,
        agreement: 'ag1',
        subscription_line: 'sub1',
        site: 'site1',
        description: 'Site package',
        units: '30',
        monthly_rate: '300',
        amount,
        currency,
    })
    const page = (query: Record<string, string>) => pull(getBillingLines, { id: 'p9', query }).body as BillingLinesPage
    const ids = (lines: BillingLinesPage['lines']) => lines.map((sent) => sent.id)

    beforeEach(() => {
        platform.tables[PERIOD] = [
            { sys_id: 'p8', period: '2026-08', status: 'closed', line_count: '0' },
            { sys_id: 'p9', period: '2026-09', status: 'closed', line_count: '5' },
        ]
        // Stored in no order: a page is cut from the lines by customer, then by sys_id.
        platform.tables[LINE] = [
            line('l2', 'initech', '10', 'USD'),
            line('l4', 'globex', '40'),
            line('l3', 'acme', '100'),
            line('l1', 'globex', '30'),
            line('l5', 'acme', '200'),
        ]
    })

    it('lists the most recent periods, newest first, each with its totals per currency', () => {
        expect(pull(listBillingPeriods)).toEqual({
            status: 200,
            body: {
                periods: [
                    {
                        id: 'p9',
                        period: '2026-09',
                        status: 'closed',
                        lines: 5,
                        totals: [
                            { currency: 'EUR', lines: 4, amount: 370 },
                            { currency: 'USD', lines: 1, amount: 10 },
                        ],
                    },
                    { id: 'p8', period: '2026-08', status: 'closed', lines: 0, totals: [] },
                ],
            },
        })
        expect((pull(listBillingPeriods, { query: { limit: '1' } }).body as { periods: Array<{ id: string }> }).periods.map((period) => period.id)).toEqual(['p9'])
    })

    it("pages a period's lines by customer: two full pages, then the rest and no next page", () => {
        const first = page({ limit: '2' })
        expect(first).toMatchObject({ period: '2026-09', status: 'closed', final: true, offset: 0, nextOffset: 2 })
        expect(first.totals).toEqual([
            { currency: 'EUR', lines: 4, amount: 370 },
            { currency: 'USD', lines: 1, amount: 10 },
        ])
        expect(ids(first.lines)).toEqual(['l3', 'l5'])
        expect(first.lines[0]).toEqual({
            id: 'l3',
            kind: 'subscription',
            customerId: 'acme',
            customer: 'acme',
            agreement: 'ag1',
            subscriptionLine: 'sub1',
            siteId: 'site1',
            site: 'site1',
            feeEvent: '',
            description: 'Site package',
            units: 30,
            monthlyRate: 300,
            amount: 100,
            currency: 'EUR',
        })

        const second = page({ limit: '2', offset: '2' })
        expect([ids(second.lines), second.offset, second.nextOffset]).toEqual([['l1', 'l4'], 2, 4])

        const last = page({ limit: '2', offset: '4' })
        expect([ids(last.lines), last.offset, last.nextOffset]).toEqual([['l2'], 4, null])
    })

    it('names no next page on a last page that is full, and gives an empty page past the end', () => {
        rows(LINE).pop()
        const last = page({ limit: '2', offset: '2' })
        expect([ids(last.lines), last.nextOffset]).toEqual([['l4', 'l2'], null])
        expect(page({ limit: '4' }).nextOffset).toBeNull()
        expect(page({ limit: '2', offset: '4' })).toMatchObject({ lines: [], nextOffset: null })
    })

    it("gives every line by default, one for a limit of 0 and no more than the page's most", () => {
        expect(ids(page({}).lines)).toEqual(['l3', 'l5', 'l1', 'l4', 'l2'])
        expect(ids(page({ limit: '0' }).lines)).toEqual(['l3'])

        const most = PULL_PAGE.lines.most
        platform.tables[LINE] = Array.from({ length: most + 1 }, (_, at) => line(`l${String(at).padStart(5, '0')}`, 'acme', '1'))
        const capped = page({ limit: String(most * 2) })
        expect([capped.lines.length, capped.nextOffset]).toEqual([most, most])
    })

    it('says a period still open is not final', () => {
        Object.assign(periodRow('2026-09') ?? {}, { status: 'ready' })
        expect(page({})).toMatchObject({ status: 'ready', final: false })
    })

    it('answers 404 for a period it does not know, and 403 without the finance or billing reader role', () => {
        expect(pull(getBillingLines, { id: 'nosuch' })).toEqual({ status: 404, body: { error: 'Unknown billing period' } })
        const refused = { status: 403, body: { error: 'Requires the finance or billing reader role' } }
        expect(pull(getBillingLines, { id: 'p9' }, [ROLE.assetManager])).toEqual(refused)
        expect(pull(listBillingPeriods, {}, [])).toEqual(refused)
        expect(pull(listBillingPeriods, {}, [ROLE.finance]).status).toBe(200)
    })

    it("refuses the NMS's integration role on both routes", () => {
        const refused = { status: 403, body: { error: 'Requires the finance or billing reader role' } }
        expect(pull(listBillingPeriods, {}, [ROLE.integration])).toEqual(refused)
        expect(pull(getBillingLines, { id: 'p9' }, [ROLE.integration])).toEqual(refused)
    })
})

describe('Reset generation', () => {
    const MINUTE = 60000
    const reset = (current: GlideRecord) => told(uiResetBillingGeneration, current)
    const cursor = (): Row | undefined => rows(CURSOR)[0]

    beforeEach(() => {
        platform.user = { ...platform.user, name: 'Ada Admin', roles: [ROLE.admin] }
    })

    it('is refused while the generation showed activity in the last 30 minutes, which then finishes', () => {
        create('2026-09')
        platform.clock += 29 * MINUTE

        expect(reset(period('2026-09'))).toEqual([
            'error 2026-09 not reset: its generation was active 29 minute(s) ago and may still be running; it can be reset once it has shown no activity for 30 minutes',
        ])
        expect(periodRow('2026-09')?.status).toBe('generating')

        drainGeneration()
        expect(periodRow('2026-09')).toMatchObject({ status: 'ready', line_count: '2' })
    })

    it('holds an idle generation for review and retires its pass: Close refuses until a Regenerate, which bills each line once', () => {
        create('2026-09')
        platform.clock += 30 * MINUTE

        expect(reset(period('2026-09'))).toEqual(['info 2026-09 is ready for review, reset by hand: Regenerate it before closing'])
        expect(periodRow('2026-09')).toMatchObject({
            status: 'ready',
            line_count: '0',
            last_error: 'Generation reset by hand by Ada Admin after 30 minutes without activity; its lines may be incomplete: Regenerate before closing',
        })
        expect(cursor()).toMatchObject({ cursor: '', last_status: 'reset by hand' })
        expect(close(period('2026-09'))).toEqual([expect.stringMatching(/^error 2026-09 did not generate cleanly/)])

        // The chunk the reset pass had queued is still in the queue, ahead of the Regenerate's.
        expect(regenerate(period('2026-09'))).toEqual(regenerating('2026-09'))
        drainGeneration()
        expect(platform.warnings).toEqual([expect.stringContaining('dropped a generation chunk of a pass reset or replaced')])
        expect(linesOf('2026-09').map((line) => line.amount)).toEqual(['300', '50'])
        expect(close(period('2026-09'))).toEqual(closed('2026-09'))
    })

    it('leaves the period generating when a chunk of its pass starts as the pass is retired', () => {
        create('2026-09')
        platform.clock += 30 * MINUTE
        platform.onSave = (table, row) => {
            // A chunk records its activity on the job cursor while the Reset saves the cursor without its pass.
            if (table === CURSOR && row.cursor === '') Object.assign(cursor() ?? {}, { last_run: '2026-11-11 12:30:00' })
        }

        expect(reset(period('2026-09'))).toEqual([
            'error 2026-09 not reset: a chunk of its generation started as it was being reset. Its generation is stopped and the period stays Generating until that chunk is done: Reset generation again in 30 minutes',
        ])
        expect(periodRow('2026-09')?.status).toBe('generating')
        expect(cursor()?.cursor).toBe('')
    })

    it('resets only a period still generating, and only for an admin', () => {
        generate('2026-09')
        platform.clock += 30 * MINUTE
        expect(reset(period('2026-09'))).toEqual(['error 2026-09 not reset: only a period still generating can be reset'])

        platform.user = { ...platform.user, roles: [ROLE.finance] }
        expect(reset(period('2026-09'))).toEqual(['error Only an admin can reset a generation'])
        expect(periodRow('2026-09')?.status).toBe('ready')
    })
})

describe('the CSV export of a closed period', () => {
    const FILE = 'billing-2026-09.csv'
    const reexport = (current: GlideRecord) => told(uiExportBillingPeriod, current)
    const contents = () => rows(ATTACHMENT).map((attachment) => platform.attachments[attachment.sys_id ?? ''])
    const CSV =
        'period,kind,customer,agreement,subscription_line,site,description,units,monthly_rate,amount,currency\r\n' +
        '2026-09,subscription,acme,ag1,sub1,,Site package,30,300,300,EUR\r\n' +
        '2026-09,fee,acme,ag1,,,lost fee: a1 (2026-09-20),1,0,50,EUR\r\n'

    beforeEach(() => {
        generate('2026-09')
        expect(close(period('2026-09'))).toEqual(closed('2026-09'))
    })

    it('is attached to the period once, with a row for each of its lines', () => {
        drainExport()
        expect(rows(ATTACHMENT)).toEqual([
            expect.objectContaining({ table_name: PERIOD, table_sys_id: periodRow('2026-09')?.sys_id, file_name: FILE, content_type: 'text/csv' }),
        ])
        expect(contents()).toEqual([CSV])

        exportBillingPeriod(recordOf('sysevent', { parm1: periodRow('2026-09')?.sys_id ?? '' }))
        expect(rows(ATTACHMENT)).toHaveLength(1)
    })

    it('keeps one copy when two exports of the period run at once', () => {
        let raced = false
        platform.onSave = (table) => {
            if (table !== ATTACHMENT || raced) return
            raced = true
            // A second export finds no file yet while the first one writes its own.
            exportBillingPeriod(recordOf('sysevent', { parm1: periodRow('2026-09')?.sys_id ?? '' }))
        }

        drainExport()

        expect(raced).toBe(true)
        expect(contents()).toEqual([CSV])
    })

    it('logs an error naming the period when the platform refuses the file, and attaches it on a Re-export CSV after that', () => {
        platform.refuses = (table) => (table === ATTACHMENT ? 'no attachment' : '')
        drainExport()
        expect(rows(ATTACHMENT)).toEqual([])
        expect(platform.logs.filter((logged) => logged.startsWith('error '))).toEqual([
            `error [x_daas_ham] CSV export of billing period 2026-09 failed: the platform did not attach ${FILE}`,
        ])

        platform.refuses = () => ''
        expect(reexport(period('2026-09'))).toEqual(['info The CSV export of 2026-09 is being prepared'])
        drainExport()
        expect(contents()).toEqual([CSV])
    })

    it('is not attached to a period that is not closed', () => {
        Object.assign(periodRow('2026-09') ?? {}, { status: 'ready' })
        drainExport()
        expect(rows(ATTACHMENT)).toEqual([])
        expect(reexport(period('2026-09'))).toEqual(['error Only a closed period can be exported'])
    })

    it('is attached again by Re-export CSV only once the file is gone', () => {
        drainExport()
        expect(reexport(period('2026-09'))).toEqual([`info ${FILE} is already attached; delete it to export again`])
        expect(platform.events).toEqual([])

        platform.tables[ATTACHMENT] = []
        expect(reexport(period('2026-09'))).toEqual(['info The CSV export of 2026-09 is being prepared'])
        drainExport()
        expect(rows(ATTACHMENT).map((attachment) => attachment.file_name)).toEqual([FILE])
    })
})

describe('a save of a fleet asset', () => {
    const ASSETS = 'alm_hardware'
    const INTERVALS = 'x_daas_ham_service_interval'
    const TODAY = '2026-11-11'

    function unit(stage: Stage, fields: Row = {}): Row {
        const { installStatus, substatus } = fieldsOf(stage)
        return {
            sys_id: 'a1',
            serial_number: 'FOC111',
            company: 'acme',
            install_status: installStatus,
            substatus: substatus ?? '',
            x_daas_ham_subscription_line: 'sub1',
            x_daas_ham_site: 'site1',
            ...fields,
        }
    }

    /** Run the rule as the platform does after a save that took the Asset from `before` to `after`. */
    function saved(before: Row, after: Row): void {
        platform.tables[ASSETS] = [after]
        onAssetServiceChange(recordOf(ASSETS, after), recordOf(ASSETS, before))
    }

    /** Each interval as [Subscription line, Site, first day, last day], in the order stored. */
    const billed = () => rows(INTERVALS).map((row) => [row.subscription_line, row.site, row.start_date, row.end_date ?? ''])

    beforeEach(() => {
        platform.references = { ...platform.references, [`${INTERVALS}.asset`]: ASSETS }
        platform.tables[INTERVALS] = [{ sys_id: 'int1', asset: 'a1', subscription_line: 'sub1', site: 'site1', start_date: '2026-10-01', end_date: '' }]
    })

    it('moves the interval of a unit in service whose Subscription line was changed by hand', () => {
        saved(unit('in_service'), unit('in_service', { x_daas_ham_subscription_line: 'sub2' }))

        expect(billed()).toEqual([
            ['sub1', 'site1', '2026-10-01', TODAY],
            ['sub2', 'site1', '2026-11-12', ''],
        ])
    })

    it('moves it when only the Site changed, and when the stage changed between two stages in service too', () => {
        saved(unit('in_service'), unit('temporary_deployment', { x_daas_ham_site: 'site2' }))

        expect(billed()).toEqual([
            ['sub1', 'site1', '2026-10-01', TODAY],
            ['sub1', 'site2', '2026-11-12', ''],
        ])
    })

    it('starts billing a unit in service the day it is given a line', () => {
        platform.tables[INTERVALS] = []

        saved(unit('in_service', { x_daas_ham_subscription_line: '' }), unit('in_service'))

        expect(billed()).toEqual([['sub1', 'site1', TODAY, '']])
    })

    it('leaves the interval alone of a unit billed where it already is, and of one that is not in service', () => {
        saved(unit('in_service'), unit('in_service', { asset_tag: 'P-1' }))
        saved(unit('available'), unit('available', { x_daas_ham_subscription_line: 'sub2' }))

        expect(billed()).toEqual([['sub1', 'site1', '2026-10-01', '']])
    })

    it('opens one interval, from the in-service date, for a go-live that attaches the line in the same save', () => {
        platform.tables[INTERVALS] = []

        saved(unit('pending_in_service', { x_daas_ham_subscription_line: '' }), unit('in_service', { x_daas_ham_in_service_date: '2026-11-09 08:00:00' }))

        expect(billed()).toEqual([['sub1', 'site1', '2026-11-09', '']])
    })

    it('bills no day at the Site a unit came back to and left again on the day it first left service', () => {
        const elsewhere = { x_daas_ham_site: 'site2' }
        saved(unit('in_service'), unit('missing'))
        saved(unit('missing'), unit('in_service', elsewhere))
        expect(billed()).toEqual([
            ['sub1', 'site1', '2026-10-01', TODAY],
            ['sub1', 'site2', '2026-11-12', ''],
        ])

        saved(unit('in_service', elsewhere), unit('missing', elsewhere))

        expect(billed()).toEqual([['sub1', 'site1', '2026-10-01', TODAY]])
    })

    it('closes the interval, and opens none, for a save that takes the unit out of service and clears its line and Site', () => {
        saved(unit('in_service'), unit('pending_evaluation', { x_daas_ham_subscription_line: '', x_daas_ham_site: '' }))

        expect(billed()).toEqual([['sub1', 'site1', '2026-10-01', TODAY]])
    })
})
