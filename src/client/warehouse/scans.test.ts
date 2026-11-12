import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AssetSummary } from '../../server/domain/rest-contracts'
import { contextAfter, describe as describeScan, MODES, modesFor, perform, scanOf, type Mode } from './scans'

const CONTEXT = { stockroom: 'room1', pid: ' C9300-48P-E ', orderNumber: 'NORD1', auditNumber: 'NAUD1' }
const asset = (overrides: Partial<AssetSummary> = {}): AssetSummary => ({
    id: 'a1',
    serial: 'SN1',
    providerTag: 'P0001',
    model: 'Catalyst 9300',
    pid: 'C9300-48P-E',
    stage: 'available',
    stockroom: 'Oslo depot',
    customer: '',
    orderLine: '',
    ...overrides,
})

function answer(body: unknown): void {
    vi.stubGlobal('window', { g_ck: 'token' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ result: body }), { status: 200 })))
}

const sent = () => {
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit]
    return { url, method: init.method, body: init.body }
}

afterEach(() => vi.unstubAllGlobals())

describe('modesFor', () => {
    it('offers a field tech, who has no stockrooms to work in, only Audit and Look up', () => {
        expect(modesFor(null).map((mode) => mode.id)).toEqual(['audit', 'lookup'])
    })

    it('offers every mode otherwise, also while the stockrooms load', () => {
        expect(modesFor([])).toBe(MODES)
        expect(modesFor(undefined)).toBe(MODES)
    })
})

describe('scanOf and contextAfter', () => {
    it('queues a receive with its PID trimmed', () => {
        expect(scanOf(CONTEXT, 'receive', 'SN1')).toEqual({ ...CONTEXT, pid: 'C9300-48P-E', mode: 'receive', code: 'SN1' })
    })

    it('sends no PID with any other scan', () => {
        for (const mode of ['putaway', 'pick', 'audit', 'lookup'] satisfies Mode[]) expect(scanOf(CONTEXT, mode, 'SN1').pid).toBe('')
    })

    it('clears the PID once a receive is queued, so it never goes with the next serial', () => {
        expect(contextAfter(CONTEXT, 'receive')).toEqual({ ...CONTEXT, pid: '' })
    })

    it('keeps the context after any other scan', () => {
        expect(contextAfter(CONTEXT, 'pick')).toBe(CONTEXT)
    })
})

describe('perform', () => {
    const scan = (mode: Mode, overrides: Partial<typeof CONTEXT> = {}, code = 'SN1') => ({ ...CONTEXT, pid: 'C9300-48P-E', ...overrides, mode, code })

    it('receives into the stockroom, with the PID only when one was given', async () => {
        answer(asset())
        expect(await perform(scan('receive'))).toEqual({ mode: 'receive', asset: asset() })
        expect(sent()).toEqual({ url: '/api/x_daas_ham/naas/receive', method: 'POST', body: '{"code":"SN1","stockroom":"room1","pid":"C9300-48P-E"}' })
        answer(asset())
        await perform(scan('receive', { pid: '' }))
        expect(sent().body).toBe('{"code":"SN1","stockroom":"room1"}')
    })

    it('puts away to the stockroom', async () => {
        answer(asset())
        await perform(scan('putaway'))
        expect(sent()).toEqual({ url: '/api/x_daas_ham/naas/putaway', method: 'POST', body: '{"code":"SN1","stockroom":"room1"}' })
    })

    it('picks for the order', async () => {
        answer(asset())
        await perform(scan('pick'))
        expect(sent()).toEqual({ url: '/api/x_daas_ham/naas/pick', method: 'POST', body: '{"code":"SN1","order":"NORD1"}' })
    })

    it('refuses a pick with no order number, and an audit scan with no audit number, before any request', async () => {
        answer(asset())
        await expect(perform(scan('pick', { orderNumber: '' }))).rejects.toThrow('Enter the order number first')
        await expect(perform(scan('audit', { auditNumber: '' }))).rejects.toThrow('Enter the audit number first')
        expect(fetch).not.toHaveBeenCalled()
    })

    it('counts an audit scan blind', async () => {
        answer({})
        expect(await perform(scan('audit'))).toEqual({ mode: 'audit', code: 'SN1' })
        expect(sent()).toEqual({ url: '/api/x_daas_ham/naas/audits/NAUD1/scan', method: 'POST', body: '{"code":"SN1"}' })
    })

    it('looks up by the code, encoded', async () => {
        answer(asset())
        await perform(scan('lookup', {}, 'SN 1/2'))
        expect(sent()).toMatchObject({ url: '/api/x_daas_ham/naas/assets/SN%201%2F2', method: 'GET' })
    })
})

describe('describe', () => {
    it('names a received unit by its tag, and its order line when it was allocated', () => {
        expect(describeScan({ mode: 'receive', asset: asset() })).toBe('Received SN1 (C9300-48P-E) as P0001')
        expect(describeScan({ mode: 'receive', asset: asset({ orderLine: 'NORL1' }) })).toBe('Received SN1 (C9300-48P-E) as P0001, allocated to NORL1')
    })

    it('names a unit by its Model when it has no PID', () => {
        expect(describeScan({ mode: 'pick', asset: asset({ pid: '' }) })).toBe('SN1 (Catalyst 9300) picked')
    })

    it('says where a unit was put away', () => {
        expect(describeScan({ mode: 'putaway', asset: asset() })).toBe('SN1 (C9300-48P-E) put away in Oslo depot')
    })

    it('says a counted code only', () => {
        expect(describeScan({ mode: 'audit', code: 'SN1' })).toBe('SN1 counted')
    })

    it('describes a looked-up unit by stage and place', () => {
        const unit = (overrides: Partial<AssetSummary>) => asset({ stage: 'spare_pool', ...overrides })
        expect(describeScan({ mode: 'lookup', asset: unit({}) })).toBe('SN1 (C9300-48P-E): spare pool, Oslo depot, tag P0001')
        expect(describeScan({ mode: 'lookup', asset: unit({ stockroom: '', customer: 'Acme' }) })).toBe('SN1 (C9300-48P-E): spare pool, Acme, tag P0001')
        expect(describeScan({ mode: 'lookup', asset: unit({ stockroom: '', providerTag: '' }) })).toBe('SN1 (C9300-48P-E): spare pool, no location')
    })
})
