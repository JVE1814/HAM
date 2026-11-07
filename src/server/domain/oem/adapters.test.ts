import { describe, expect, it } from 'vitest'
import { OEM_ADAPTERS, type OemContext } from './adapters'
import type { HttpRequest, HttpResponse } from '../http'

function fakeHttp(routes: Record<string, (params: Record<string, string>) => unknown>) {
    const calls: HttpRequest[] = []
    const http = (request: HttpRequest): HttpResponse => {
        calls.push(request)
        const handler = routes[request.fn]
        if (!handler) return { status: 404, body: '{}' }
        const body = handler(request.params)
        return body === undefined ? { status: 500, body: '' } : { status: 200, body: JSON.stringify(body) }
    }
    return { http, calls }
}

describe('Cisco', () => {
    it('maps EoX records, batching 20 product IDs per call and skipping products without a bulletin', () => {
        const pids = Array.from({ length: 21 }, (_, i) => `PID-${i}`)
        const { http, calls } = fakeHttp({
            eox_by_pid: (params) => ({
                EOXRecord: params.pids.split(',').map((pid) =>
                    pid === 'PID-1'
                        ? { EOLProductID: pid, EOXError: { ErrorID: 'SSA_ERR_026' } }
                        : {
                              EOLProductID: pid,
                              EndOfSaleDate: { value: '2024-04-30', dateFormat: 'YYYY-MM-DD' },
                              LastDateOfSupport: { value: '2029-04-30', dateFormat: 'YYYY-MM-DD' },
                              LinkToProductBulletinURL: 'https://cisco.example/eol',
                          },
                ),
            }),
        })
        const context: OemContext = { http, orgIds: [] }
        const result = OEM_ADAPTERS.cisco.lifecycle!.run(pids, context)
        expect(calls).toHaveLength(2)
        expect(result.facts).toHaveLength(20)
        expect(result.facts[0]).toEqual({
            pid: 'PID-0',
            dates: { endOfSale: '2024-04-30', endOfSupport: '2029-04-30', endOfLife: '2029-04-30' },
            reference: 'https://cisco.example/eol',
        })
    })

    it('maps coverage summaries by serial', () => {
        const { http } = fakeHttp({
            coverage_by_serial: () => ({
                serial_numbers: [
                    { sr_no: 'FOC1', is_covered: 'YES', coverage_end_date: '2027-06-30', service_contract_number: '9123', service_line_descr: 'SNTC 24X7X4' },
                    { sr_no: 'FOC2', is_covered: 'NO', warranty_end_date: '2025-01-31' },
                ],
            }),
        })
        const result = OEM_ADAPTERS.cisco.coverage!.run(['FOC1', 'FOC2'], { http, orgIds: [] })
        expect(result.facts).toEqual([
            { serial: 'FOC1', covered: true, contractNumber: '9123', serviceLevel: 'SNTC 24X7X4', startDate: undefined, endDate: '2027-06-30' },
            { serial: 'FOC2', covered: false, contractNumber: '', serviceLevel: '', startDate: undefined, endDate: '2025-01-31' },
        ])
    })

    it('reads RMA status and reports HTTP failures as errors', () => {
        const { http } = fakeHttp({
            rma_status: (params) => (params.rma === '8000000001' ? { returns: { RmaRecord: [{ rmaNo: '8000000001', status: 'Shipped' }] } } : undefined),
        })
        const result = OEM_ADAPTERS.cisco.rmaStatus!.run(['8000000001', '8000000002'], { http, orgIds: [] })
        expect(result.facts).toEqual([{ rmaNumber: '8000000001', status: 'Shipped' }])
        expect(result.errors).toEqual(['rma_status {"rma":"8000000002"}: HTTP 500'])
    })
})

describe('Meraki', () => {
    it('looks the bare model up in each organisation until a device with EoX data is found', () => {
        const { http, calls } = fakeHttp({
            inventory_by_model: (params) =>
                params.org_id === 'org2'
                    ? [{ serial: 'Q2XX', model: 'MR46', eox: { status: 'endOfSale', endOfSaleAt: '2026-06-30T00:00:00Z', endOfSupportAt: '2031-06-30T00:00:00Z' } }]
                    : [],
        })
        const result = OEM_ADAPTERS.meraki.lifecycle!.run(['MR46-HW'], { http, orgIds: ['org1', 'org2'] })
        expect(calls.map((c) => c.params)).toEqual([
            { org_id: 'org1', model: 'MR46' },
            { org_id: 'org2', model: 'MR46' },
        ])
        expect(result.facts).toEqual([{ pid: 'MR46-HW', dates: { endOfSale: '2026-06-30', endOfSupport: '2031-06-30' }, reference: 'meraki:org2' }])
    })

    it('gets hardware coverage from Cisco', () => {
        expect(OEM_ADAPTERS.meraki.coverage?.via).toBe('cisco')
    })
})

describe('Fortinet', () => {
    it('takes the entitlement that ends last', () => {
        const { http } = fakeHttp({
            products_list: () => ({
                assets: [
                    {
                        serialNumber: 'FGT60F000001',
                        entitlements: [
                            { levelDesc: '8x5 FortiCare', startDate: '2024-01-01T00:00:00', endDate: '2025-01-01T00:00:00' },
                            { levelDesc: '24x7 FortiCare', startDate: '2025-01-01T00:00:00', endDate: '2028-01-01T00:00:00' },
                        ],
                    },
                ],
            }),
        })
        const result = OEM_ADAPTERS.fortinet.coverage!.run(['FGT60F000001'], { http, orgIds: [] })
        expect(result.facts).toEqual([
            { serial: 'FGT60F000001', covered: true, contractNumber: '', serviceLevel: '24x7 FortiCare', startDate: '2025-01-01', endDate: '2028-01-01' },
        ])
    })
})

describe('HPE Mist', () => {
    it('maps lifecycle by model and warranty by serial from JSI inventory (epoch seconds)', () => {
        const { http } = fakeHttp({
            jsi_by_model: () => [{ model: 'AP45', eos_time: 1782777600, eol_time: 1940544000 }],
            jsi_by_serial: () => [{ serial: 'A1', warranty_type: 'Standard', warranty_start_time: 1704067200, warranty_end_time: 1830297600 }],
        })
        const context = { http, orgIds: ['org1'] }
        expect(OEM_ADAPTERS.mist.lifecycle!.run(['AP45'], context).facts).toEqual([
            { pid: 'AP45', dates: { endOfSale: '2026-06-30', endOfLife: '2031-06-30' }, reference: 'mist:jsi' },
        ])
        expect(OEM_ADAPTERS.mist.coverage!.run(['A1'], context).facts).toEqual([
            { serial: 'A1', covered: true, contractNumber: '', serviceLevel: 'Standard', startDate: '2024-01-01', endDate: '2028-01-01' },
        ])
    })
})

describe('vendors without APIs', () => {
    it('have no adapters, so CSV import is used', () => {
        expect(OEM_ADAPTERS.aruba).toEqual({})
        expect(OEM_ADAPTERS.checkpoint).toEqual({})
    })
})
