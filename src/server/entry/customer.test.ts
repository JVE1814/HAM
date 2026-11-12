import type { RESTAPIRequest, RESTAPIResponse } from '@servicenow/glide/sn_ws_int'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_LISTED_DEVICES } from '../domain/customer-requests.ts'
import { fieldsOf } from '../domain/lifecycle.ts'
import { RETURN_LINE_STATUS } from '../domain/vocabulary.ts'
import { answerAttestation, requestCustomerReturn } from './customer.ts'
import { platform, type Row } from '../test-support/fake-glide.ts'

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

const RETURNS = 'x_daas_ham_return_order'
const RETURN_LINES = 'x_daas_ham_return_order_line'
const ATTESTATIONS = 'x_daas_ham_attestation'
const ITEMS = 'x_daas_ham_attestation_item'
const LOCKS = 'x_daas_ham_job_lock'
const TOO_MANY = { status: 400, body: { error: 'At most 5000 devices per request' } }

const rows = (table: string): Row[] => platform.tables[table] ?? []

type Handler = (request: RESTAPIRequest, response: RESTAPIResponse) => void

function post(handler: Handler, body: object, pathParams: Record<string, string> = {}): { status: number; body: unknown } {
    const reply = { status: 0, body: null as unknown }
    const request = { body: { data: body }, pathParams, queryParams: {} } as unknown as RESTAPIRequest
    const response = {
        setStatus: (status: number) => void (reply.status = status),
        setBody: (sent: unknown) => void (reply.body = sent),
    } as unknown as RESTAPIResponse
    handler(request, response)
    return reply
}

beforeEach(() => {
    platform.reset()
    platform.user = { id: 'u1', name: 'Ada', company: 'acme', roles: ['x_daas_ham.customer_admin'], interactive: true }
    platform.uniqueKeys = { [LOCKS]: 'name' }
})

describe('POST /customer/returns', () => {
    const { installStatus, substatus } = fieldsOf('in_service')
    const requestReturn = (assets: unknown) => post(requestCustomerReturn, { site: 'site1', assets, decommission: false, method: 'ship_back' })

    beforeEach(() => {
        platform.creatable = () => true
        platform.defaults = { [RETURNS]: () => ({ number: 'RET0002' }), [RETURN_LINES]: () => ({ status: RETURN_LINE_STATUS.awaiting }) }
        platform.references = { [`${RETURN_LINES}.return_order`]: RETURNS, [`${RETURNS}.agreement`]: 'x_daas_ham_agreement' }
        platform.tables.cmn_location = [{ sys_id: 'site1', name: 'HQ', company: 'acme', x_daas_ham_is_site: 'true' }]
        platform.tables.x_daas_ham_agreement = [{ sys_id: 'ag1', overdue_return_days: '10' }]
        platform.tables.alm_hardware = [
            { sys_id: 'a1', serial_number: 'FOC111', x_daas_ham_fleet: 'true', company: 'acme', x_daas_ham_site: 'site1', x_daas_ham_agreement: 'ag1', install_status: installStatus, substatus: substatus ?? '' },
        ]
    })

    it('raises the Return for the devices listed, each once', () => {
        expect(requestReturn(['a1', 'a1'])).toEqual({ status: 201, body: { returnOrder: 'RET0002' } })
        expect(rows(RETURN_LINES).map((line) => line.asset)).toEqual(['a1'])
    })

    it('refuses a list longer than a request may name, and raises nothing', () => {
        expect(requestReturn(Array(MAX_LISTED_DEVICES + 1).fill('a1'))).toEqual(TOO_MANY)
        expect(rows(RETURNS)).toEqual([])
        expect(rows(RETURN_LINES)).toEqual([])
    })
})

describe('POST /customer/attestations/{id}', () => {
    const answer = (items: unknown) => post(answerAttestation, { items, submit: false }, { id: 'att1' })

    beforeEach(() => {
        platform.tables[ATTESTATIONS] = [{ sys_id: 'att1', number: 'ATT0001', state: '1' }]
        platform.tables[ITEMS] = [{ sys_id: 'item1', attestation: 'att1', asset: 'a1', response: '' }]
    })

    it('saves the answers given', () => {
        expect(answer([{ id: 'item1', response: 'confirmed' }])).toEqual({ status: 200, body: { attestation: 'ATT0001' } })
        expect(rows(ITEMS)[0]?.response).toBe('confirmed')
    })

    it('takes as many answers as a request may name', () => {
        const answers = Array(MAX_LISTED_DEVICES).fill({ id: 'item1', response: 'confirmed' })
        expect(answer(answers)).toEqual({ status: 200, body: { attestation: 'ATT0001' } })
    })

    it('refuses more, and saves none of them', () => {
        const answers = Array(MAX_LISTED_DEVICES + 1).fill({ id: 'item1', response: 'confirmed' })
        expect(answer(answers)).toEqual(TOO_MANY)
        expect(rows(ITEMS)[0]?.response).toBe('')
    })
})
