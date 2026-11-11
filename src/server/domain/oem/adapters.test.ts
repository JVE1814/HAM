import { describe, expect, it } from 'vitest'
import { enabledRoutes, OEM_ADAPTERS, parseCoverageRow, type SyncApi } from './adapters'
import type { OemContext } from './sync-adapters'
import type { HttpRequest, HttpResponse } from '../http'
import type { OemVendor } from '../vocabulary'

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

/** EoX v5 by product ID: one EOXRecordType per PID, dates as {value, dateFormat}, SSA_ERR_026 for unknown PIDs. */
function eoxResponse(params: Record<string, string>) {
    const pids = params.pids.split(',')
    return {
        PaginationResponseRecord: { PageIndex: 1, LastIndex: 1, TotalRecords: pids.length, PageRecords: pids.length },
        EOXRecord: pids.map((pid) =>
            pid === 'PID-1'
                ? {
                      EOLProductID: '',
                      EOXInputType: 'ShowEOXByPids',
                      EOXInputValue: pid,
                      EOXError: { ErrorID: 'SSA_ERR_026', ErrorDescription: 'EoX information does not exist for the following product ID(s): PID-1', ErrorDataType: 'PRODUCT_ID', ErrorDataValue: pid },
                  }
                : {
                      EOLProductID: pid,
                      EOXExternalAnnouncementDate: { value: '2023-04-30', dateFormat: 'YYYY-MM-DD' },
                      EndOfSaleDate: { value: '2024-04-30', dateFormat: 'YYYY-MM-DD' },
                      LastDateOfSupport: { value: '2029-04-30', dateFormat: 'YYYY-MM-DD' },
                      LinkToProductBulletinURL: 'https://cisco.example/eol',
                      EOXInputType: 'ShowEOXByPids',
                      EOXInputValue: pid,
                  },
        ),
    }
}

describe('Cisco', () => {
    it('maps EoX records, batching 20 product IDs per call and skipping products without a bulletin', () => {
        const pids = Array.from({ length: 21 }, (_, i) => `PID-${i}`)
        const { http, calls } = fakeHttp({ eox_by_pid: eoxResponse })
        const context: OemContext = { http, orgIds: [] }
        const result = OEM_ADAPTERS.cisco.lifecycle!.run(pids, context)
        expect(calls).toEqual([
            { fn: 'eox_by_pid', params: { pids: pids.slice(0, 20).join(',') } },
            { fn: 'eox_by_pid', params: { pids: 'PID-20' } },
        ])
        expect(result.facts).toHaveLength(20)
        expect(result.facts[0]).toEqual({
            pid: 'PID-0',
            dates: { endOfSale: '2024-04-30', endOfSupport: '2029-04-30', endOfLife: '2029-04-30' },
            reference: 'https://cisco.example/eol',
        })
    })

    it('keeps the comma-joined product IDs of an EoX call within 250 characters', () => {
        // 14-character PIDs: 16 fit in 239 characters, 17 would take 254.
        const pids = Array.from({ length: 20 }, (_, i) => `WS-C3850-${String(i).padStart(2, '0')}P-L`)
        const { http, calls } = fakeHttp({ eox_by_pid: eoxResponse })
        const result = OEM_ADAPTERS.cisco.lifecycle!.run(pids, { http, orgIds: [] })
        expect(calls.map((c) => c.params.pids)).toEqual([pids.slice(0, 16).join(','), pids.slice(16).join(',')])
        expect(calls.every((c) => c.params.pids.length <= 250)).toBe(true)
        expect(result.facts.map((f) => f.pid)).toEqual(pids)
    })

    it('keys each EoX fact by the product ID as it was asked, whatever case Cisco answers in', () => {
        // Cisco answers EOLProductID in its own case: a Model stored as ws-c3850-24t must still get its dates.
        const { http } = fakeHttp({
            eox_by_pid: (params) => {
                const answer = eoxResponse(params)
                return { ...answer, EOXRecord: answer.EOXRecord.map((record) => ({ ...record, EOLProductID: record.EOLProductID.toUpperCase() })) }
            },
        })
        const result = OEM_ADAPTERS.cisco.lifecycle!.run(['ws-c3850-24t', 'C9300-48P'], { http, orgIds: [] })
        expect(result.facts.map((f) => f.pid)).toEqual(['ws-c3850-24t', 'C9300-48P'])
        expect(result.errors).toEqual([])
    })

    it('matches an EoX record by its product when it carries no input value, and reports one that answers no PID asked', () => {
        const record = (pid: string) => ({ EOLProductID: pid, LastDateOfSupport: { value: '2029-04-30', dateFormat: 'YYYY-MM-DD' } })
        const http = () => ({ status: 200, body: JSON.stringify({ EOXRecord: [record('WS-C3850-24T'), record('WS-C3850-48T')] }) })
        const result = OEM_ADAPTERS.cisco.lifecycle!.run(['ws-c3850-24t'], { http, orgIds: [] })
        expect(result.facts.map((f) => f.pid)).toEqual(['ws-c3850-24t'])
        expect(result.errors).toEqual(['eox_by_pid: the EoX record of WS-C3850-48T answers none of the product IDs asked'])
    })

    it('maps SN2INFO v2 coverage summaries: contract end from covered_product_line_end_date, no start date', () => {
        const { http, calls } = fakeHttp({
            coverage_by_serial: () => ({
                pagination_response_record: { last_index: 1, page_index: 1, page_records: 3, self_link: 'https://apix.cisco.com/sn2info/v2/coverage/summary/serial_numbers/FOC1,FOC2,FOC3', title: 'Cisco Serial Number to Information', total_records: 3 },
                serial_numbers: [
                    {
                        id: '1',
                        sr_no: 'FOC1',
                        is_covered: 'YES',
                        base_pid: 'C9300-48P',
                        orderable_pid: 'C9300-48P-E',
                        service_contract_number: '9123',
                        service_line_descr: 'SNTC 24X7X4',
                        covered_product_line_end_date: '2027-06-30',
                        warranty_end_date: '2025-01-31',
                        warranty_type: 'WARR-LTD-LIFE-HW',
                        contract_site_customer_name: 'NaaS Customer',
                    },
                    { id: '2', sr_no: 'FOC2', is_covered: 'NO', service_contract_number: '', warranty_end_date: '2025-01-31', warranty_type: 'WARR-1YR' },
                    // v1.0 summary name, still read as a fallback.
                    { id: '3', sr_no: 'FOC3', is_covered: 'YES', service_contract_number: '9124', coverage_end_date: '2026-12-31' },
                ],
            }),
        })
        const result = OEM_ADAPTERS.cisco.coverage!.run(['FOC1', 'FOC2', 'FOC3'], { http, orgIds: [] })
        expect(calls).toEqual([{ fn: 'coverage_by_serial', params: { serials: 'FOC1,FOC2,FOC3' } }])
        expect(result.facts).toEqual([
            { serial: 'FOC1', covered: true, contractNumber: '9123', serviceLevel: 'SNTC 24X7X4', startDate: undefined, endDate: '2027-06-30' },
            { serial: 'FOC2', covered: false, contractNumber: '', serviceLevel: '', startDate: undefined, endDate: '2025-01-31' },
            { serial: 'FOC3', covered: true, contractNumber: '9124', serviceLevel: '', startDate: undefined, endDate: '2026-12-31' },
        ])
        expect(result.errors).toEqual([])
    })

    it('writes no fact for an SN2INFO record without is_covered, so the stored coverage stands (missing means unknown)', () => {
        const http = () => ({
            status: 200,
            body: JSON.stringify({ serial_numbers: [{ sr_no: 'FOC1', service_contract_number: '9123', covered_product_line_end_date: '2027-06-30' }, { sr_no: 'FOC2', is_covered: 'no' }] }),
        })
        const result = OEM_ADAPTERS.cisco.coverage!.run(['FOC1', 'FOC2'], { http, orgIds: [] })
        expect(result.facts).toEqual([{ serial: 'FOC2', covered: false, contractNumber: '', serviceLevel: '', startDate: undefined, endDate: undefined }])
        expect(result.errors).toEqual(['coverage_by_serial FOC1: no is_covered in the answer, so its stored coverage is kept'])
        expect(result).toMatchObject({ failed: [], rejected: [] })
    })

    it('reads RMA status and reports HTTP failures as errors', () => {
        const { http } = fakeHttp({
            rma_status: (params) => (params.rma === '8000000001' ? { returns: { RmaRecord: [{ rmaNo: '8000000001', status: 'Shipped' }] } } : undefined),
        })
        const result = OEM_ADAPTERS.cisco.rmaStatus!.run(['8000000001', '8000000002'], { http, orgIds: [] })
        expect(result.facts).toEqual([{ rmaNumber: '8000000001', status: 'Shipped' }])
        expect(result.errors).toEqual(['rma_status {"rma":"8000000002"}: HTTP 500'])
    })

    it("names the transport's reason for a call that got no answer", () => {
        const http = () => ({ status: 0, body: '', error: 'Read timed out' })
        const result = OEM_ADAPTERS.cisco.coverage!.run(['FOC1'], { http, orgIds: [] })
        expect(result.errors).toEqual(['coverage_by_serial {"serials":"FOC1"}: no response: Read timed out'])
        expect(result.failed).toEqual(['FOC1'])
    })

    it("adds the vendor's own error text to a failed call's error", () => {
        const http = () => ({ status: 401, body: JSON.stringify({ error: 'invalid_token', error_description: 'Token expired' }) })
        expect(OEM_ADAPTERS.cisco.rmaStatus!.run(['8000000001'], { http, orgIds: [] }).errors).toEqual(['rma_status {"rma":"8000000001"}: HTTP 401: Token expired'])
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

    it('keeps searching later organisations past a device whose eox has a null status and no dates', () => {
        const { http, calls } = fakeHttp({
            inventory_by_model: (params) =>
                params.org_id === 'org1'
                    ? [{ serial: 'Q2XX-1', model: 'MR46', eox: { status: null, endOfSaleAt: null, endOfSupportAt: null } }]
                    : [{ serial: 'Q2XX-2', model: 'MR46', eox: { status: 'endOfSale', endOfSaleAt: '2026-06-30T00:00:00Z', endOfSupportAt: null } }],
        })
        const result = OEM_ADAPTERS.meraki.lifecycle!.run(['MR46-HW'], { http, orgIds: ['org1', 'org2'] })
        expect(calls).toHaveLength(2)
        expect(result.facts).toEqual([{ pid: 'MR46-HW', dates: { endOfSale: '2026-06-30', endOfSupport: undefined }, reference: 'meraki:org2' }])
    })

    it('gives no fact for a model no organisation has EoX dates for', () => {
        const { http } = fakeHttp({ inventory_by_model: () => [{ serial: 'Q2XX', model: 'MR46', eox: { status: null } }] })
        expect(OEM_ADAPTERS.meraki.lifecycle!.run(['MR46-HW'], { http, orgIds: ['org1'] }).facts).toEqual([])
    })
})

/** The FortiCloud Asset Management v3 envelope: status 0 means success. */
function fortiEnvelope(fields: Record<string, unknown>) {
    return { build: '1.0.0', error: null, message: 'Request processed successfully', status: 0, token: 'token', version: '3.0', ...fields }
}

describe('Fortinet', () => {
    it('takes the entitlement that ends last and the contract with a term ending then', () => {
        const { http, calls } = fakeHttp({
            products_list: () =>
                fortiEnvelope({
                    assets: [
                        {
                            description: 'Branch firewall',
                            serialNumber: 'FGT60F000001',
                            productModel: 'FortiGate 60F',
                            registrationDate: '2024-01-01T00:00:00',
                            isDecommissioned: false,
                            entitlements: [
                                { level: 6, levelDesc: '8x5 FortiCare', type: 2, typeDesc: 'Firmware & General Updates', startDate: '2024-01-01T00:00:00', endDate: '2025-01-01T00:00:00' },
                                { level: 20, levelDesc: '24x7 FortiCare', type: 11, typeDesc: 'Telephone Support', startDate: '2025-01-01T00:00:00', endDate: '2028-01-01T00:00:00' },
                            ],
                            warrantySupports: [],
                            assetGroups: [],
                            contracts: [
                                { contractNumber: 'FC-OLD', sku: 'FC-10-0060F-247-02-12', terms: [{ supportType: 'Telephone Support', startDate: '2024-01-01T00:00:00', endDate: '2025-01-01T00:00:00' }] },
                                { contractNumber: 'FC-NEW', sku: 'FC-10-0060F-247-02-36', terms: [{ supportType: 'Telephone Support', startDate: '2025-01-01T00:00:00', endDate: '2028-01-01T00:00:00' }] },
                            ],
                            productModelEoR: null,
                            productModelEoS: null,
                        },
                    ],
                }),
        })
        const result = OEM_ADAPTERS.fortinet.coverage!.run(['FGT60F000001'], { http, orgIds: [] })
        expect(calls).toEqual([{ fn: 'products_list', params: { serial: 'FGT60F000001' } }])
        expect(result.facts).toEqual([
            { serial: 'FGT60F000001', covered: true, contractNumber: 'FC-NEW', serviceLevel: '24x7 FortiCare', startDate: '2025-01-01', endDate: '2028-01-01' },
        ])
        expect(result.errors).toEqual([])
    })

    it('falls back to the first contract and reports an HTTP-200 API error (status not 0) as an error', () => {
        const { http } = fakeHttp({
            products_list: (params) =>
                params.serial === 'FGT60F000002'
                    ? fortiEnvelope({
                          assets: [
                              {
                                  serialNumber: 'FGT60F000002',
                                  entitlements: [{ levelDesc: '24x7 FortiCare', startDate: '2025-01-01T00:00:00', endDate: '2027-01-01T00:00:00' }],
                                  contracts: [{ contractNumber: 'FC-ONLY', terms: [] }],
                              },
                          ],
                      })
                    : params.serial === 'FGT60F000003'
                      ? fortiEnvelope({ status: 1, message: 'Unit not found in this account', assets: null })
                      : fortiEnvelope({ status: -1, message: '', error: 'Invalid serial number' }),
        })
        const result = OEM_ADAPTERS.fortinet.coverage!.run(['FGT60F000002', 'FGT60F000003', 'BAD'], { http, orgIds: [] })
        expect(result.facts).toEqual([
            { serial: 'FGT60F000002', covered: true, contractNumber: 'FC-ONLY', serviceLevel: '24x7 FortiCare', startDate: '2025-01-01', endDate: '2027-01-01' },
        ])
        expect(result.errors).toEqual(['products_list FGT60F000003: Unit not found in this account', 'products_list BAD: Invalid serial number'])
        // API errors in the envelope are answers: those serials are rejected (asked again after the
        // refresh interval), not failed, so permanent rejections do not block the queue.
        expect(result.failed).toEqual([])
        expect(result.rejected).toEqual(['FGT60F000003', 'BAD'])
    })

    it('reports an HTTP failure for that serial only', () => {
        // fakeHttp answers HTTP 500 when the handler returns undefined.
        const { http } = fakeHttp({ products_list: (params) => (params.serial === 'DOWN' ? undefined : fortiEnvelope({ status: 0, assets: [] })) })
        const result = OEM_ADAPTERS.fortinet.coverage!.run(['OK1', 'DOWN'], { http, orgIds: [] })
        expect(result.failed).toEqual(['DOWN'])
        expect(result.rejected).toEqual([])
    })
})

describe('coverage failures', () => {
    it('Cisco marks every serial of a failed SN2INFO batch, and none of an answered one', () => {
        const serials = Array.from({ length: 51 }, (_, i) => `S${i}`)
        let call = 0
        const http = () => (call++ === 0 ? { status: 500, body: '' } : { status: 200, body: JSON.stringify({ serial_numbers: [] }) })
        const result = OEM_ADAPTERS.cisco.coverage!.run(serials, { http, orgIds: [] })
        expect(result.failed).toEqual(serials.slice(0, 50))
    })

    it('Mist marks a serial failed when an org failed and no org had the device', () => {
        const http = (request: { params: Record<string, string> }) =>
            request.params.org_id === 'down'
                ? { status: 502, body: '' }
                : request.params.org_id === 'has'
                  ? { status: 200, body: JSON.stringify([{ serial: 'A1', warranty_end: '2028-01-01' }]) }
                  : { status: 200, body: '[]' }
        expect(OEM_ADAPTERS.mist.coverage!.run(['A1'], { http, orgIds: ['down'] }).failed).toEqual(['A1'])
        // The device may be in the org that failed: not known yet.
        expect(OEM_ADAPTERS.mist.coverage!.run(['A1'], { http, orgIds: ['down', 'up'] }).failed).toEqual(['A1'])
        // Every org answered that it has none: answered (no coverage).
        expect(OEM_ADAPTERS.mist.coverage!.run(['A1'], { http, orgIds: ['up'] }).failed).toEqual([])
        // Found in a later org despite an earlier failure: answered.
        expect(OEM_ADAPTERS.mist.coverage!.run(['A1'], { http, orgIds: ['down', 'has'] })).toMatchObject({ failed: [], facts: [{ serial: 'A1', endDate: '2028-01-01' }] })
        // No org to search: answered (no coverage); Mist never rejects.
        expect(OEM_ADAPTERS.mist.coverage!.run(['A1'], { http, orgIds: [] })).toEqual({ facts: [], errors: [], failed: [], rejected: [] })
    })

    it('Cisco treats an answer without serial_numbers as rejected (asked again after the refresh interval)', () => {
        const http = () => ({ status: 200, body: JSON.stringify({ ErrorResponse: { APIError: { ErrorCode: 'EXCEEDED_OUTPUT' } } }) })
        const result = OEM_ADAPTERS.cisco.coverage!.run(['S1', 'S2'], { http, orgIds: [] })
        expect(result.failed).toEqual([])
        expect(result.rejected).toEqual(['S1', 'S2'])
        expect(result.errors).toEqual(['coverage_by_serial: no serial_numbers in the response'])
    })
})

describe('HPE Mist', () => {
    it('maps JSI lifecycle by model: end_of_sale_time is end of sale, eos_time is end of support (epoch seconds)', () => {
        const { http, calls } = fakeHttp({
            jsi_by_model: () => [{ model: 'AP45', sku: 'AP45-WW', serial: 'A1', end_of_sale_time: 1782777600, end_of_service_time: 1900000000, eos_time: 1940544000 }],
        })
        expect(OEM_ADAPTERS.mist.lifecycle!.run(['AP45'], { http, orgIds: ['org1'] }).facts).toEqual([
            { pid: 'AP45', dates: { endOfSale: '2026-06-30', endOfSupport: '2031-06-30' }, reference: 'mist:jsi' },
        ])
        expect(calls).toEqual([{ fn: 'jsi_by_model', params: { org_id: 'org1', model: 'AP45' } }])
    })

    it('maps JSI coverage by serial from the warranty dates, else the contract dates and has_support', () => {
        const items: Record<string, unknown> = {
            A1: { serial: 'A1', model: 'AP45', warranty_type: 'Standard', warranty_start: '2024-01-01', warranty_end: '2028-01-01' },
            A2: { serial: 'A2', model: 'EX2300-24MP', contract_id: 'C-9', contract_type: 'Next-Day', contract_start_date: '2022-09-01', contract_end_date: '2028-10-01', has_support: true },
            A3: { serial: 'A3', model: 'AP43', has_support: true, support_contract_status: 'Active' },
            A4: { serial: 'A4', model: 'AP43', has_support: false },
        }
        const { http, calls } = fakeHttp({ jsi_by_serial: (params) => [items[params.serial]] })
        expect(OEM_ADAPTERS.mist.coverage!.run(['A1', 'A2', 'A3', 'A4'], { http, orgIds: ['org1'] }).facts).toEqual([
            { serial: 'A1', covered: true, contractNumber: '', serviceLevel: 'Standard', startDate: '2024-01-01', endDate: '2028-01-01' },
            { serial: 'A2', covered: true, contractNumber: 'C-9', serviceLevel: 'Next-Day', startDate: '2022-09-01', endDate: '2028-10-01' },
            { serial: 'A3', covered: true, contractNumber: '', serviceLevel: '', startDate: undefined, endDate: undefined },
            { serial: 'A4', covered: false, contractNumber: '', serviceLevel: '', startDate: undefined, endDate: undefined },
        ])
        expect(calls[0]).toEqual({ fn: 'jsi_by_serial', params: { org_id: 'org1', serial: 'A1' } })
    })
})

describe('rate limits', () => {
    // FortiCloud answers 100 calls a minute, and its products/list takes one serial per call (external-contracts F1).
    it('ask FortiCloud for fewer serials per run than it answers calls for in a minute', () => {
        expect(OEM_ADAPTERS.fortinet.coverage?.maxKeysPerRun).toBeLessThan(100)
    })
})

describe('enabledRoutes', () => {
    const only = (...vendors: OemVendor[]) => (api: SyncApi) => vendors.some((vendor) => OEM_ADAPTERS[vendor].api === api)
    const vendors = (capability: 'lifecycle' | 'coverage' | 'rmaStatus', enabled: (api: SyncApi) => boolean) => enabledRoutes(capability, enabled).map((turn) => turn.vendor)

    it('gives each vendor whose route may run its turn, in the sync order', () => {
        const all = () => true
        expect(vendors('coverage', all)).toEqual(['cisco', 'meraki', 'fortinet', 'mist'])
        expect(enabledRoutes('rmaStatus', all)).toEqual([{ vendor: 'cisco', route: OEM_ADAPTERS.cisco.rmaStatus }])
        expect(vendors('lifecycle', only('mist'))).toEqual(['mist'])
        expect(enabledRoutes('coverage', () => false)).toEqual([])
    })

    it('runs Meraki coverage, which Cisco SN2INFO serves, only when Meraki and Cisco are both enabled', () => {
        expect(vendors('coverage', only('cisco'))).toEqual(['cisco'])
        expect(vendors('coverage', only('meraki'))).toEqual([])
        expect(enabledRoutes('coverage', only('meraki', 'cisco'))).toEqual([
            { vendor: 'cisco', route: OEM_ADAPTERS.cisco.coverage },
            { vendor: 'meraki', route: OEM_ADAPTERS.meraki.coverage },
        ])
    })

    it('runs a route the vendor serves itself exactly when that vendor is enabled', () => {
        expect(enabledRoutes('lifecycle', only('meraki'))).toEqual([{ vendor: 'meraki', route: OEM_ADAPTERS.meraki.lifecycle }])
        expect(vendors('lifecycle', only('cisco'))).toEqual(['cisco'])
        expect(vendors('rmaStatus', only('cisco'))).toEqual(['cisco'])
        expect(vendors('rmaStatus', only('meraki'))).toEqual([])
    })

    it('has no route for a capability without an API, enabled or not', () => {
        expect(vendors('lifecycle', only('fortinet'))).toEqual([])
        expect(vendors('coverage', only('aruba'))).toEqual([])
    })
})

describe('parseCoverageRow', () => {
    const row = {
        vendor: 'aruba',
        serial: ' cn12ab ',
        contractNumber: 'C-1',
        serviceLevel: 'NBD',
        startDate: '2026-01-01',
        endDate: '',
        annualCost: ' 120.50 ',
    }

    it('reads a contract covering the normalized serial from the dates given, with the cost as a number', () => {
        expect(parseCoverageRow(row)).toEqual({
            ok: true,
            vendor: 'aruba',
            fact: { serial: 'CN12AB', covered: true, contractNumber: 'C-1', serviceLevel: 'NBD', startDate: '2026-01-01', endDate: undefined },
            annualCost: 120.5,
        })
        expect(parseCoverageRow({ ...row, annualCost: '' })).toMatchObject({ ok: true, annualCost: undefined })
    })

    it('refuses a vendor the app does not integrate with, a blank serial, a date that is no calendar day and a cost that is no number', () => {
        expect(parseCoverageRow({ ...row, vendor: 'Aruba' })).toMatchObject({ ok: false, reason: expect.stringMatching(/^vendor must be one of /) })
        expect(parseCoverageRow({ ...row, serial: '  ' })).toEqual({ ok: false, reason: 'serial number is required' })
        expect(parseCoverageRow({ ...row, endDate: '2026-02-30' })).toEqual({ ok: false, reason: 'dates must be real calendar dates (YYYY-MM-DD)' })
        expect(parseCoverageRow({ ...row, annualCost: '12O' })).toEqual({ ok: false, reason: 'annual cost must be a number' })
    })
})

/*
 * The adapters' tolerant-reader promise (adapters.ts header): a 2xx whose body is not JSON, and a record missing the
 * field a fact is keyed by, degrade to "unknown" (no fact, an error where the answer said nothing) and never throw.
 */

const answer = (response: HttpResponse): OemContext => ({ http: () => response, orgIds: ['org1'] })
const notJson: HttpResponse = { status: 200, body: '<html>Service temporarily unavailable</html>' }
const empty: HttpResponse = { status: 200, body: '' }

describe('a 2xx answer that is not JSON', () => {
    it('gives Cisco EoX no facts and an error, and no other call is skipped', () => {
        const pids = Array.from({ length: 21 }, (_, i) => `PID-${i}`)
        const calls: string[] = []
        const result = OEM_ADAPTERS.cisco.lifecycle!.run(pids, {
            http: (request) => {
                calls.push(request.params.pids)
                return notJson
            },
            orgIds: [],
        })
        expect(calls).toHaveLength(2)
        expect(result).toEqual({ facts: [], errors: ['eox_by_pid: response is not JSON', 'eox_by_pid: response is not JSON'] })
    })

    it('marks a Cisco SN2INFO batch failed, so it is asked again next run', () => {
        const result = OEM_ADAPTERS.cisco.coverage!.run(['FOC1', 'FOC2'], answer(notJson))
        expect(result).toEqual({ facts: [], errors: ['coverage_by_serial: response is not JSON'], failed: ['FOC1', 'FOC2'], rejected: [] })
    })

    it('reads an empty 2xx body as not JSON too', () => {
        expect(OEM_ADAPTERS.cisco.coverage!.run(['FOC1'], answer(empty))).toMatchObject({ facts: [], failed: ['FOC1'], rejected: [] })
    })

    it('gives a Cisco RMA no status', () => {
        expect(OEM_ADAPTERS.cisco.rmaStatus!.run(['8000000001'], answer(notJson))).toEqual({ facts: [], errors: ['rma_status: response is not JSON'] })
    })

    it('gives Meraki EoX no facts', () => {
        expect(OEM_ADAPTERS.meraki.lifecycle!.run(['MR46-HW'], answer(notJson))).toEqual({ facts: [], errors: ['inventory_by_model: response is not JSON'] })
    })

    it('marks a FortiCloud serial failed, not rejected', () => {
        const result = OEM_ADAPTERS.fortinet.coverage!.run(['FGT60F0000000001'], answer(notJson))
        expect(result).toEqual({ facts: [], errors: ['products_list: response is not JSON'], failed: ['FGT60F0000000001'], rejected: [] })
    })

    it('marks a Mist serial failed when no org answered in JSON', () => {
        const result = OEM_ADAPTERS.mist.coverage!.run(['A0000000001'], answer(notJson))
        expect(result).toEqual({ facts: [], errors: ['jsi_by_serial: response is not JSON'], failed: ['A0000000001'], rejected: [] })
    })

    it('gives Mist JSI lifecycle no facts', () => {
        expect(OEM_ADAPTERS.mist.lifecycle!.run(['AP43-WW'], answer(notJson))).toEqual({ facts: [], errors: ['jsi_by_model: response is not JSON'] })
    })
})

describe('a record missing the field its fact is keyed by', () => {
    it('skips an EoX record without EOLProductID (no bulletin data), with no error, and keeps the others', () => {
        const json = {
            EOXRecord: [
                { EOXInputValue: 'PID-A', LastDateOfSupport: { value: '2029-04-30', dateFormat: 'YYYY-MM-DD' } },
                { EOXInputValue: 'PID-B', EOLProductID: 'PID-B', LastDateOfSupport: { value: '2030-01-31', dateFormat: 'YYYY-MM-DD' } },
            ],
        }
        const result = OEM_ADAPTERS.cisco.lifecycle!.run(['PID-A', 'PID-B'], answer({ status: 200, body: JSON.stringify(json) }))
        expect(result.facts.map((f) => f.pid)).toEqual(['PID-B'])
        expect(result.errors).toEqual([])
    })

    it('reads an EoX record without dates or bulletin link as unknown dates, not as an error', () => {
        const json = { EOXRecord: { EOXInputValue: 'PID-A', EOLProductID: 'PID-A' } }
        const result = OEM_ADAPTERS.cisco.lifecycle!.run(['PID-A'], answer({ status: 200, body: JSON.stringify(json) }))
        expect(result).toEqual({
            facts: [{ pid: 'PID-A', dates: { endOfSale: undefined, endOfSupport: undefined, endOfLife: undefined }, reference: '' }],
            errors: [],
        })
    })

    it('gives no EoX facts for an answer without EOXRecord', () => {
        expect(OEM_ADAPTERS.cisco.lifecycle!.run(['PID-A'], answer({ status: 200, body: '{}' }))).toEqual({ facts: [], errors: [] })
    })

    it('skips an SN2INFO record without sr_no: that serial is neither covered, uncovered, failed nor rejected', () => {
        const json = { serial_numbers: [{ is_covered: 'YES', service_contract_number: '9123' }, { sr_no: 'FOC2', is_covered: 'NO' }] }
        const result = OEM_ADAPTERS.cisco.coverage!.run(['FOC1', 'FOC2'], answer({ status: 200, body: JSON.stringify(json) }))
        expect(result).toEqual({
            facts: [{ serial: 'FOC2', covered: false, contractNumber: '', serviceLevel: '', startDate: undefined, endDate: undefined }],
            errors: [],
            failed: [],
            rejected: [],
        })
    })

    it('keys an RMA record without rmaNo by the RMA number asked', () => {
        const json = { returns: { RmaRecord: [{ status: 'Booked' }] } }
        const result = OEM_ADAPTERS.cisco.rmaStatus!.run(['8000000003'], answer({ status: 200, body: JSON.stringify(json) }))
        expect(result).toEqual({ facts: [{ rmaNumber: '8000000003', status: 'Booked' }], errors: [] })
    })

    it('reads a single RmaRecord object as one record, and gives no fact for one without a status', () => {
        const one = OEM_ADAPTERS.cisco.rmaStatus!.run(['8000000004'], answer({ status: 200, body: JSON.stringify({ returns: { RmaRecord: { rmaNo: '8000000004', status: 'Closed' } } }) }))
        expect(one.facts).toEqual([{ rmaNumber: '8000000004', status: 'Closed' }])
        const noStatus = OEM_ADAPTERS.cisco.rmaStatus!.run(['8000000005'], answer({ status: 200, body: JSON.stringify({ returns: { RmaRecord: [{ rmaNo: '8000000005' }] } }) }))
        expect(noStatus).toEqual({ facts: [], errors: [] })
    })

    it('keys a FortiCloud asset without serialNumber by the serial asked', () => {
        const json = { status: 0, assets: [{ entitlements: [{ levelDesc: 'Premium', startDate: '2025-01-01T00:00:00', endDate: '2027-01-01T00:00:00' }] }] }
        const result = OEM_ADAPTERS.fortinet.coverage!.run(['FGT60F0000000002'], answer({ status: 200, body: JSON.stringify(json) }))
        expect(result.facts).toEqual([
            { serial: 'FGT60F0000000002', covered: true, contractNumber: '', serviceLevel: 'Premium', startDate: '2025-01-01', endDate: '2027-01-01' },
        ])
    })
})
