import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlideRecord } from '@servicenow/glide'
import { EVENT } from '../domain/events.ts'
import { PROPERTY } from '../domain/properties.ts'
import { computeMarginChunk } from './margin.ts'
import { platform, recordOf, type Row } from '../test-support/fake-glide.ts'

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

const PERIOD = 'x_daas_ham_billing_period'
const INTERVAL = 'x_daas_ham_service_interval'
const FACT = 'x_daas_ham_cost_fact'
const MARGIN = 'x_daas_ham_margin'
const WORK_ORDER = 'wm_order'
const SHIPMENT = 'x_daas_ham_shipment'

const rows = (table: string): Row[] => platform.tables[table] ?? []
const periodRow = (): Row => rows(PERIOD)[0] ?? {}
const facts = () => rows(FACT).map((fact) => [fact.customer, fact.site, fact.cost_type, fact.currency, fact.amount])
const margins = () => rows(MARGIN).map((row) => [row.customer, row.site, row.currency, row.revenue, row.cost, row.margin, row.margin_pct])

/** Run a margin pass of the period to its end, a chunk per event, as the script action does. How many chunks ran. */
function computeMargin(): number {
    const period = recordOf<GlideRecord>(PERIOD, periodRow())
    computeMarginChunk({ name: EVENT.marginCompute, record: period, subject: 'p10', position: '' })
    let chunks = 1
    for (let event = platform.events.shift(); event; event = platform.events.shift()) {
        computeMarginChunk({ name: event.name, record: period, subject: event.parm1, position: event.parm2 })
        chunks++
    }
    return chunks
}

/** A provider-owned Asset bought for 6000: written off over 60 months, 100 for each full month in service. */
function asset(id: string): Row {
    return { sys_id: id, x_daas_ham_legal_owner: 'provider', cost: '6000', purchase_date: '2026-01-01', x_daas_ham_fleet: 'true' }
}

/** A Service interval of acme at Site s1, open through October 2026. */
function interval(id: string, assetId: string, fields: Row = {}): Row {
    return { sys_id: id, asset: assetId, subscription_line: 'sub1', customer: 'acme', site: 's1', start_date: '2026-09-01', end_date: '', ...fields }
}

/** A field work order of acme at Site s1, closed in October 2026. */
function workOrder(id: string, fields: Row = {}): Row {
    return { sys_id: id, number: id.toUpperCase(), x_daas_ham_purpose: 'install', closed_at: '2026-10-15 10:00:00', company: 'acme', location: 's1', initiated_from: '', x_daas_ham_labour_cost: '', ...fields }
}

/** A Shipment of acme to Site s1 whose label was bought in October 2026. */
function shipment(id: string, fields: Row = {}): Row {
    return { sys_id: id, number: id.toUpperCase(), status: 'delivered', cost: '40', currency: 'USD', customer: 'acme', site: 's1', sys_created_on: '2026-10-05 09:00:00', ...fields }
}

beforeEach(() => {
    platform.reset()
    platform.clock = Date.parse('2026-11-11T12:00:00Z')
    platform.uniqueKeys = { x_daas_ham_job_lock: 'name', x_daas_ham_job_cursor: 'job' }
    // No time to spare: each chunk pauses after one Service interval, so a pass of two takes several chunks.
    platform.properties = { [PROPERTY.jobBudgetSeconds.name]: '0' }
    platform.references = {
        'x_daas_ham_subscription_line.agreement': 'x_daas_ham_agreement',
        'x_daas_ham_order.agreement': 'x_daas_ham_agreement',
    }
    platform.tables[PERIOD] = [{ sys_id: 'p10', period: '2026-10', status: 'closed', margin_failed: '0', margin_error: '' }]
    platform.tables.x_daas_ham_agreement = [{ sys_id: 'ag1', number: 'NAG0001', currency: 'EUR', customer: 'acme' }]
    platform.tables.x_daas_ham_subscription_line = [{ sys_id: 'sub1', agreement: 'ag1', customer: 'acme' }]
    platform.tables.x_daas_ham_order = [{ sys_id: 'ord1', agreement: 'ag1' }]
    platform.tables.alm_hardware = [asset('a1'), asset('a2')]
    platform.tables[INTERVAL] = [interval('i1', 'a1'), interval('i2', 'a2')]
})

describe('the margin of a closed Billing period', () => {
    it('adds the costs of every chunk to one Cost fact per Customer, Site, type and currency, and sets them against the revenue', () => {
        platform.tables[WORK_ORDER] = [workOrder('wo1', { x_daas_ham_labour_cost: '80' }), workOrder('wo2')]
        platform.tables[SHIPMENT] = [shipment('sh1'), shipment('sh2', { status: 'voided', cost: '99' })]
        platform.tables.x_daas_ham_billing_line = [{ sys_id: 'bl1', billing_period: 'p10', customer: 'acme', site: 's1', currency: 'EUR', amount: '500' }]

        // A chunk per Service interval, and the last, empty one that completes the pass.
        expect(computeMargin()).toBe(3)

        expect(facts()).toEqual([
            ['acme', 's1', 'purchase', 'EUR', '200'],
            ['acme', 's1', 'field_labour', 'EUR', '330'],
            ['acme', 's1', 'shipping', 'USD', '40'],
        ])
        expect(margins()).toEqual([
            ['acme', 's1', 'EUR', '500', '530', '-30', '-6'],
            ['acme', 's1', 'USD', '0', '40', '-40', ''],
        ])
        expect(periodRow()).toMatchObject({ margin_failed: '0', margin_error: '' })
        expect(rows('x_daas_ham_job_lock')).toEqual([])
    })

    it('replaces the Cost facts and Margin of an earlier pass', () => {
        computeMargin()
        computeMargin()

        expect(facts()).toEqual([['acme', 's1', 'purchase', 'EUR', '200']])
        expect(margins()).toEqual([['acme', 's1', 'EUR', '0', '200', '-200', '']])
    })

    it('leaves out a Service interval whose Asset is gone and a shipment without a currency, and counts both on the period', () => {
        platform.tables.alm_hardware = [asset('a1')]
        platform.tables[SHIPMENT] = [shipment('sh1', { currency: '' })]

        computeMargin()

        expect(facts()).toEqual([['acme', 's1', 'purchase', 'EUR', '100']])
        expect(periodRow()).toMatchObject({ margin_failed: '2', margin_error: 'shipment SH1: its cost has no currency' })
        expect(platform.logs).toContainEqual(expect.stringContaining('i2: its Asset a2 is not found'))
    })

    it('computes nothing for a period that is not closed', () => {
        periodRow().status = 'ready'

        expect(computeMargin()).toBe(1)

        expect(rows(FACT)).toEqual([])
        expect(rows(MARGIN)).toEqual([])
    })
})

describe('a cost that names no Customer', () => {
    it("is counted on the period when it is a Service interval's, not left out without a word", () => {
        platform.tables[INTERVAL] = [interval('i1', 'a1'), interval('i2', 'a2', { customer: '' })]

        computeMargin()

        expect(facts()).toEqual([['acme', 's1', 'purchase', 'EUR', '100']])
        expect(periodRow()).toMatchObject({ margin_failed: '1', margin_error: 'i2: it names no Customer to cost it to' })
    })

    it("is counted on the period when it is a work order's", () => {
        platform.tables[WORK_ORDER] = [workOrder('wo1', { company: '', initiated_from: 'ord1' })]

        computeMargin()

        expect(facts()).toEqual([['acme', 's1', 'purchase', 'EUR', '200']])
        expect(periodRow()).toMatchObject({ margin_failed: '1', margin_error: 'work order WO1: it has no Customer to cost it to' })
    })
})
