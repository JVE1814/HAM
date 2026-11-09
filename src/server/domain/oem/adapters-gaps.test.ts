import { describe, expect, it } from 'vitest'
import { OEM_ADAPTERS, type OemContext } from './adapters'
import type { HttpResponse } from '../http'

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
