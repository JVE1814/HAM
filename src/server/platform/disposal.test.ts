import { GlideRecord } from '@servicenow/glide'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fieldsOf, type Stage } from '../domain/lifecycle.ts'
import { completeDisposal, submitDisposal } from './disposal.ts'
import { platform, type Row } from '../test-support/fake-glide.ts'

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

const ASSETS = 'alm_hardware'
const ORDERS = 'x_daas_ham_disposal_order'
const LINES = 'x_daas_ham_disposal_line'
const APPROVALS = 'sysapproval_approver'

const rows = (table: string): Row[] => platform.tables[table] ?? []
const asset = (id: string): Row => rows(ASSETS).find((row) => row.sys_id === id) ?? {}
const line = (id: string): Row => rows(LINES).find((row) => row.sys_id === id) ?? {}
const order = (): Row => rows(ORDERS)[0] ?? {}

function stage(of: Stage): Row {
    const { installStatus, substatus } = fieldsOf(of)
    return { install_status: installStatus, substatus: substatus ?? '' }
}

/** A wiped fleet asset awaiting wipe sign-off, the Provider's own unless `fields` say otherwise. */
function wiped(id: string, fields: Row = {}): Row {
    return {
        sys_id: id,
        serial_number: `FOC-${id}`,
        x_daas_ham_fleet: 'true',
        x_daas_ham_legal_owner: 'provider',
        company: 'provider-co',
        x_daas_ham_wiped_on: '2026-02-20',
        x_daas_ham_wipe_certificate: 'CERT-1',
        ...stage('pending_wipe'),
        ...fields,
    }
}

function lineFor(assetId: string, fields: Row = {}): Row {
    return { sys_id: `line-${assetId}`, disposal_order: 'dsp1', asset: assetId, status: 'pending', ...fields }
}

/** The order as its form sends it: read from the table, with `changed` set on the record and not saved yet. */
function orderRecord(changed: Row = {}): GlideRecord {
    const record = new GlideRecord(ORDERS)
    record.get('dsp1')
    for (const [field, value] of Object.entries(changed)) record.setValue(field, value)
    return record
}

function user(id: string, role: string, company = 'provider-co'): void {
    ;(platform.tables.sys_user ??= []).push({ sys_id: id, company, active: 'true' })
    ;(platform.tables.sys_user_has_role ??= []).push({ sys_id: `role-of-${id}`, role, user: id, state: 'active' })
}

const requests = (): Record<string, string> => Object.fromEntries(rows(APPROVALS).map((row) => [row.approver, row.state]))

beforeEach(() => {
    platform.reset()
    platform.references = {
        [`${LINES}.asset`]: ASSETS,
        'sys_user_has_role.role': 'sys_user_role',
        'sys_user_has_role.user': 'sys_user',
    }
    platform.tables.sys_user_role = [
        { sys_id: 'am_role', name: 'x_daas_ham.asset_manager' },
        { sys_id: 'ca_role', name: 'x_daas_ham.customer_admin' },
    ]
    user('am', 'am_role')
    user('ca', 'ca_role', 'acme')
    user('ca-other', 'ca_role', 'globex')
    platform.tables[ORDERS] = [{ sys_id: 'dsp1', number: 'DSP0001', stage: 'draft', method: 'itad_recycle', customer: '' }]
    platform.tables[ASSETS] = [wiped('a1')]
    platform.tables[LINES] = [lineFor('a1')]
})

describe('submitting a draft Disposal order', () => {
    it("asks the asset managers alone for the Provider's own assets", () => {
        expect(submitDisposal(orderRecord())).toEqual({ submitted: true })

        expect(requests()).toEqual({ am: 'requested' })
        expect(rows(APPROVALS)[0]).toMatchObject({ sysapproval: 'dsp1', source_table: ORDERS, document_id: 'dsp1' })
        expect(order()).toMatchObject({ stage: 'awaiting_approval', approval: 'requested' })
        expect(order().approval_customer_admins ?? '').toBe('')
    })

    it("asks the admins of the order's Customer too when a customer-owned asset is on it", () => {
        order().customer = 'acme'
        platform.tables[ASSETS] = [wiped('a1'), wiped('a2', { x_daas_ham_legal_owner: 'customer', company: 'acme' })]
        platform.tables[LINES] = [lineFor('a1'), lineFor('a2')]

        expect(submitDisposal(orderRecord())).toEqual({ submitted: true })

        expect(requests()).toEqual({ am: 'requested', ca: 'requested' })
        expect(order()).toMatchObject({ stage: 'awaiting_approval', approval_customer_admins: 'ca' })
    })

    it('lets the asset managers stand in for a Customer with no admin', () => {
        order().customer = 'initech'
        platform.tables[ASSETS] = [wiped('a1', { x_daas_ham_legal_owner: 'customer', company: 'initech' })]

        expect(submitDisposal(orderRecord())).toEqual({ submitted: true })

        expect(requests()).toEqual({ am: 'requested' })
        expect(order().approval_customer_admins ?? '').toBe('')
    })

    it.each([
        ['an order with no lines', () => (platform.tables[LINES] = []), 'Add the assets to dispose of first'],
        [
            'a customer-owned asset on an order that names no Customer',
            () => Object.assign(asset('a1'), { x_daas_ham_legal_owner: 'customer', company: 'acme' }),
            'Set the customer whose assets are being returned',
        ],
        [
            "a customer-owned asset of another Customer than the order's",
            () => {
                order().customer = 'globex'
                Object.assign(asset('a1'), { x_daas_ham_legal_owner: 'customer', company: 'acme' })
            },
            "Not the order's customer's assets: FOC-a1",
        ],
        ['an order with no asset manager to ask', () => (platform.tables.sys_user_has_role = []), 'Not submitted: no asset manager to approve it'],
    ])('keeps %s a draft and asks nobody', (_what, arrange, why) => {
        arrange()

        expect(submitDisposal(orderRecord())).toEqual({ submitted: false, why })

        expect(rows(APPROVALS)).toEqual([])
        expect(order().stage).toBe('draft')
    })

    it('asks nobody, and tells nothing more, when the platform refuses to save the form', () => {
        platform.refuses = (table) => (table === ORDERS ? 'mandatory field' : '')

        expect(submitDisposal(orderRecord({ short_description: 'Recycle the old switches' }))).toEqual({ submitted: false, why: '' })

        expect(rows(APPROVALS)).toEqual([])
        expect(order().stage).toBe('draft')
    })

    it('cancels its requests when the platform refuses to save it as awaiting approval', () => {
        platform.refuses = (table, row) => (table === ORDERS && row.stage === 'awaiting_approval' ? 'stage rule said no' : '')

        expect(submitDisposal(orderRecord())).toEqual({ submitted: false, why: '' })

        expect(requests()).toEqual({ am: 'cancelled' })
        expect(order().stage).toBe('draft')
        expect(platform.warnings).toEqual([expect.stringContaining('DSP0001 not saved as awaiting approval, its requests cancelled: stage rule said no')])
    })
})

describe('completing an approved Disposal order', () => {
    beforeEach(() => {
        Object.assign(order(), { stage: 'approved', approval: 'approved', state: '1' })
    })

    it('retires each ready asset by the order method and completes the order', () => {
        expect(completeDisposal(orderRecord())).toEqual({ completed: true, blocked: 0, unsaved: 0 })

        expect(asset('a1')).toMatchObject(stage('disposed'))
        expect(line('line-a1')).toMatchObject({ status: 'done' })
        expect(line('line-a1').blockers ?? '').toBe('')
        expect(order()).toMatchObject({ stage: 'completed', state: '3' })
        expect(platform.logs).toEqual([])
    })

    it.each([
        ['broker_resale', 'provider', 'sold'],
        ['oem_takeback', 'provider', 'returned_to_oem'],
        ['return_to_lessor', 'lessor', 'returned_to_lessor'],
    ] as const)("retires a line by its own method %s, whatever the order's", (method, owner, retired) => {
        Object.assign(asset('a1'), { x_daas_ham_legal_owner: owner })
        line('line-a1').method = method

        expect(completeDisposal(orderRecord())).toMatchObject({ completed: true })

        expect(asset('a1')).toMatchObject(stage(retired))
    })

    it("returns a customer-owned asset to the order's Customer", () => {
        Object.assign(order(), { customer: 'acme', method: 'return_to_customer' })
        Object.assign(asset('a1'), { x_daas_ham_legal_owner: 'customer', company: 'acme' })

        expect(completeDisposal(orderRecord())).toMatchObject({ completed: true })

        expect(asset('a1')).toMatchObject(stage('returned_to_customer'))
    })

    it.each([
        ['no wipe evidence', () => (asset('a1').x_daas_ham_wipe_certificate = ''), 'no wipe evidence'],
        ['a stage that awaits neither wipe nor disposal', () => Object.assign(asset('a1'), stage('available')), 'asset is available, not awaiting wipe or disposal'],
        ["one of the Provider IT's assets", () => (asset('a1').x_daas_ham_fleet = ''), 'asset is not a fleet asset'],
        ["a method its owner's assets do not leave by", () => (asset('a1').x_daas_ham_legal_owner = 'lessor'), 'a lessor-owned asset can only be return to lessor'],
        [
            "a customer-owned asset of another Customer than the order's",
            () => {
                Object.assign(order(), { customer: 'globex', method: 'return_to_customer' })
                Object.assign(asset('a1'), { x_daas_ham_legal_owner: 'customer', company: 'acme' })
            },
            "asset does not belong to the order's customer",
        ],
        ['an asset the user cannot read', () => (platform.tables[ASSETS] = []), 'asset not found, or not in your stockrooms'],
    ])('blocks a line for %s, and keeps the order open', (_what, arrange, blocker) => {
        arrange()
        const before = { ...asset('a1') }

        expect(completeDisposal(orderRecord())).toEqual({ completed: false, blocked: 1, unsaved: 0 })

        expect(line('line-a1')).toMatchObject({ status: 'blocked', blockers: blocker })
        expect(asset('a1')).toEqual(before)
        expect(order()).toMatchObject({ stage: 'approved', state: '1' })
    })

    it('names every blocker of a line, joined', () => {
        Object.assign(asset('a1'), stage('available'), { x_daas_ham_wiped_on: '' })

        completeDisposal(orderRecord())

        expect(line('line-a1').blockers).toBe('asset is available, not awaiting wipe or disposal; no wipe evidence')
    })

    it('blocks a line with why the platform refused to retire its asset', () => {
        platform.refuses = (table, row) => (table === ASSETS && row.install_status === fieldsOf('disposed').installStatus ? 'retirement needs sign-off' : '')

        expect(completeDisposal(orderRecord())).toEqual({ completed: false, blocked: 1, unsaved: 0 })

        expect(line('line-a1')).toMatchObject({ status: 'blocked', blockers: 'retirement needs sign-off' })
        // The move before the refused one stays saved.
        expect(asset('a1')).toMatchObject(stage('pending_disposal'))
    })

    describe('with a ready line and a blocked one', () => {
        beforeEach(() => {
            platform.tables[ASSETS] = [wiped('a1'), wiped('a2', { x_daas_ham_wiped_on: '', x_daas_ham_wipe_certificate: '' })]
            platform.tables[LINES] = [lineFor('a1'), lineFor('a2')]
        })

        it('retires the ready one, records what blocks the other and keeps the order open', () => {
            expect(completeDisposal(orderRecord())).toEqual({ completed: false, blocked: 1, unsaved: 0 })

            expect(asset('a1')).toMatchObject(stage('disposed'))
            expect(line('line-a1').status).toBe('done')
            expect(asset('a2')).toMatchObject(stage('pending_wipe'))
            expect(line('line-a2')).toMatchObject({ status: 'blocked', blockers: 'no wipe evidence' })
            expect(order()).toMatchObject({ stage: 'approved', state: '1' })
        })

        it('completes once the blocker is cleared, without touching the line already done', () => {
            completeDisposal(orderRecord())
            Object.assign(asset('a2'), { x_daas_ham_wiped_on: '2026-02-21', x_daas_ham_wipe_certificate: 'CERT-2' })
            const done = { ...line('line-a1') }
            const retired = { ...asset('a1') }
            platform.clock += 60_000

            expect(completeDisposal(orderRecord())).toEqual({ completed: true, blocked: 0, unsaved: 0 })

            expect(line('line-a1')).toEqual(done)
            expect(asset('a1')).toEqual(retired)
            expect(asset('a2')).toMatchObject(stage('disposed'))
            expect(line('line-a2')).toMatchObject({ status: 'done', blockers: '' })
            expect(order()).toMatchObject({ stage: 'completed', state: '3' })
        })
    })

    it('counts a line the platform refuses to save, logs it and keeps the order open, its asset retired', () => {
        platform.refuses = (table) => (table === LINES ? 'line is read only' : '')

        expect(completeDisposal(orderRecord())).toEqual({ completed: false, blocked: 0, unsaved: 1 })

        expect(asset('a1')).toMatchObject(stage('disposed'))
        expect(line('line-a1').status).toBe('pending')
        expect(order().stage).toBe('approved')
        expect(platform.warnings).toEqual([expect.stringContaining('DSP0001 line for a1 not saved (done, its asset retired): line is read only')])
    })

    it('reports an order the platform refuses to save as completed, and closes it when completed again', () => {
        platform.refuses = (table, row) => (table === ORDERS && row.stage === 'completed' ? 'closure needs a note' : '')

        expect(completeDisposal(orderRecord())).toEqual({ completed: false, blocked: 0, unsaved: 0, refused: 'closure needs a note' })

        expect(asset('a1')).toMatchObject(stage('disposed'))
        expect(line('line-a1').status).toBe('done')
        expect(order()).toMatchObject({ stage: 'approved', state: '1' })

        platform.refuses = () => ''
        const retired = { ...asset('a1') }
        platform.clock += 60_000

        expect(completeDisposal(orderRecord())).toEqual({ completed: true, blocked: 0, unsaved: 0 })

        expect(asset('a1')).toEqual(retired)
        expect(order()).toMatchObject({ stage: 'completed', state: '3' })
    })

    it('retires nothing when the platform refuses to save the form it was asked from', () => {
        platform.refuses = (table) => (table === ORDERS ? 'method changed after submit' : '')

        expect(completeDisposal(orderRecord({ method: 'broker_resale' }))).toEqual({ completed: false, blocked: 0, unsaved: 0 })

        expect(asset('a1')).toMatchObject(stage('pending_wipe'))
        expect(line('line-a1').status).toBe('pending')
    })
})
