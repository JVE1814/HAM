import { GlideRecord } from '@servicenow/glide'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EVENT } from '../domain/events.ts'
import { fieldsOf, type Stage } from '../domain/lifecycle.ts'
import { LOCK } from '../domain/lock-names.ts'
import { applyLeaseDecision, transferToProvider } from './leases.ts'
import { platform, type Row } from '../test-support/fake-glide.ts'

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

const ASSETS = 'alm_hardware'
const LEASES = 'x_daas_ham_lease_schedule'
const DECISIONS = 'x_daas_ham_lease_decision'
const DISPOSALS = 'x_daas_ham_disposal_order'
const DISPOSAL_LINES = 'x_daas_ham_disposal_line'
const LOCKS = 'x_daas_ham_job_lock'

const rows = (table: string): Row[] => platform.tables[table] ?? []
const asset = (id: string): Row => rows(ASSETS).find((row) => row.sys_id === id) ?? {}
const lease = (): Row => rows(LEASES)[0] ?? {}
const decisionRow = (): Row => rows(DECISIONS)[0] ?? {}

function stage(of: Stage): Row {
    const { installStatus, substatus } = fieldsOf(of)
    return { install_status: installStatus, substatus: substatus ?? '' }
}

function leased(id: string, of: Stage, fields: Row = {}): Row {
    return {
        sys_id: id,
        serial_number: `FOC-${id}`,
        x_daas_ham_fleet: 'true',
        x_daas_ham_lease: 'lease1',
        x_daas_ham_legal_owner: 'lessor',
        company: 'provider-co',
        cost: '900',
        purchase_date: '2024-01-01',
        ...stage(of),
        ...fields,
    }
}

/** The decision as its form sends it: stored open, with `chosen` set on the record and not saved yet. */
function decide(chosen: Row): GlideRecord {
    const record = new GlideRecord(DECISIONS)
    record.get('dec1')
    for (const [field, value] of Object.entries(chosen)) record.setValue(field, value)
    return record
}

function record(table: string, id: string): GlideRecord {
    const found = new GlideRecord(table)
    found.get(id)
    return found
}

/** Run every chunk the buyout queued, as its script action would. */
function runBuyout(): void {
    for (let event = platform.events.shift(); event; event = platform.events.shift()) {
        if (event.name !== EVENT.leaseBuyout) continue
        transferToProvider({ name: event.name, record: record(LEASES, event.record), subject: event.parm1, position: event.parm2 }, record(LEASES, event.record))
    }
}

beforeEach(() => {
    platform.reset()
    platform.clock = Date.parse('2026-03-01T08:00:00Z')
    platform.uniqueKeys = { [LOCKS]: 'name' }
    platform.references = { [`${ASSETS}.x_daas_ham_lease`]: LEASES }
    platform.properties = { 'x_daas_ham.provider_company': 'provider-co' }
    platform.defaults = { [DISPOSALS]: () => ({ number: 'DSP0001' }) }
    platform.tables[LEASES] = [{ sys_id: 'lease1', number: 'LSE0001', vendor: 'lessor-co', ends: '2026-03-31', end_action: 'undecided', buyout_price: '100', mismatch: 'true' }]
    platform.tables[DECISIONS] = [{ sys_id: 'dec1', number: 'LDEC0001', lease: 'lease1', active: 'true', state: '1' }]
    platform.tables[ASSETS] = []
})

describe('a buy-out decision', () => {
    beforeEach(() => {
        platform.tables[ASSETS] = [
            leased('a1', 'in_service'),
            leased('a2', 'available'),
            leased('a3', 'pending_wipe'),
            leased('gone', 'returned_to_lessor'),
            leased('it', 'in_service', { x_daas_ham_fleet: '' }),
            leased('other', 'in_service', { x_daas_ham_lease: 'lease2' }),
        ]
    })

    it('closes the decision, fixes the buyout terms on the lease and queues the transfer', () => {
        expect(applyLeaseDecision(decide({ decision: 'buyout' }))).toEqual({
            applied: true,
            notes: ["The lease's assets become Provider-owned in the background"],
            problems: [],
        })

        expect(decisionRow()).toMatchObject({ state: '3', decision: 'buyout' })
        expect(lease()).toMatchObject({ end_action: 'buyout', ends: '2026-03-31', buyout_assets: '3', buyout_share: '33.33', buyout_extra_through: 'a1' })
        expect(platform.events).toEqual([{ name: EVENT.leaseBuyout, record: 'lease1', parm1: 'lease1', parm2: '', delayed: false }])
        expect(rows(ASSETS).map((row) => row.x_daas_ham_legal_owner)).toEqual(['lessor', 'lessor', 'lessor', 'lessor', 'lessor', 'lessor'])
    })

    it('makes the Provider own each covered Asset, the price split over them to the cent', () => {
        platform.properties['x_daas_ham.job.batch_size'] = '2'
        applyLeaseDecision(decide({ decision: 'buyout' }))

        runBuyout()

        const bought = { x_daas_ham_lease: '', x_daas_ham_legal_owner: 'provider', purchase_date: '2026-03-01' }
        expect(asset('a1')).toMatchObject({ ...bought, cost: '33.34' })
        expect(asset('a2')).toMatchObject({ ...bought, cost: '33.33' })
        expect(asset('a3')).toMatchObject({ ...bought, cost: '33.33' })
        const kept = { x_daas_ham_legal_owner: 'lessor', cost: '900', purchase_date: '2024-01-01' }
        expect(asset('gone')).toMatchObject({ ...kept, x_daas_ham_lease: 'lease1' })
        expect(asset('it')).toMatchObject({ ...kept, x_daas_ham_lease: 'lease1' })
        expect(asset('other')).toMatchObject({ ...kept, x_daas_ham_lease: 'lease2' })
        expect(platform.events).toEqual([])
        expect(platform.logs).toEqual([])
    })

    it('keeps each cost and purchase date when the buyout has no price', () => {
        lease().buyout_price = ''
        applyLeaseDecision(decide({ decision: 'buyout' }))

        runBuyout()

        expect(lease()).toMatchObject({ buyout_assets: '3', buyout_share: '0' })
        expect(lease().buyout_extra_through ?? '').toBe('')
        expect(asset('a1')).toMatchObject({ x_daas_ham_lease: '', x_daas_ham_legal_owner: 'provider', cost: '900', purchase_date: '2024-01-01' })
    })

    it("leaves an Asset whose save is refused the Lessor's, with a warning, and transfers the rest", () => {
        applyLeaseDecision(decide({ decision: 'buyout' }))
        platform.refuses = (table, row) => (table === ASSETS && row.sys_id === 'a2' ? 'asset is read only' : '')

        runBuyout()

        expect(asset('a2')).toMatchObject({ x_daas_ham_lease: 'lease1', x_daas_ham_legal_owner: 'lessor', cost: '900' })
        expect(asset('a1').x_daas_ham_legal_owner).toBe('provider')
        expect(asset('a3').x_daas_ham_legal_owner).toBe('provider')
        expect(platform.warnings).toEqual([expect.stringContaining('Buyout of LSE0001: FOC-a2 not transferred: asset is read only')])
    })
})

describe('an extension', () => {
    it('moves the lease end, leaves the lease undecided and clears its mismatch', () => {
        expect(applyLeaseDecision(decide({ decision: 'extend', new_end_date: '2027-03-31' }))).toEqual({ applied: true, notes: [], problems: [] })

        expect(decisionRow().state).toBe('3')
        expect(lease()).toMatchObject({ ends: '2027-03-31', end_action: 'undecided', mismatch: 'false' })
        expect(lease().buyout_assets ?? '').toBe('')
        expect(platform.events).toEqual([])
    })

    it('is not applied without a new end date after the lease end, and the decision stays open', () => {
        expect(applyLeaseDecision(decide({ decision: 'extend', new_end_date: '2026-03-31' }))).toEqual({
            applied: false,
            notes: [],
            problems: ['An extension needs a new end date after the current lease end'],
        })

        expect(decisionRow().state).toBe('1')
        expect(lease()).toMatchObject({ ends: '2026-03-31', end_action: 'undecided', mismatch: 'true' })
    })
})

describe('a return to the lessor', () => {
    beforeEach(() => {
        platform.tables[ASSETS] = [
            leased('a1', 'available'),
            leased('a2', 'spare_pool', { company: 'acme', x_daas_ham_agreement: 'ag1' }),
            leased('a3', 'spare_pool', { company: 'acme', x_daas_ham_agreement: 'ag1', x_daas_ham_order_line: 'ol1' }),
            leased('a4', 'in_service', { company: 'acme', x_daas_ham_agreement: 'ag1', x_daas_ham_site: 'site1' }),
            leased('a5', 'reserved', { company: 'acme', x_daas_ham_agreement: 'ag1', x_daas_ham_order_line: 'ol2' }),
        ]
    })

    const returned = () => applyLeaseDecision(decide({ decision: 'return' }))

    it('withdraws the free stock to pending wipe onto a draft disposal, and queues the refresh of the rest', () => {
        expect(returned()).toEqual({ applied: true, notes: ["The lease's stock awaits wipe on draft disposal order DSP0001"], problems: [] })

        expect(decisionRow().state).toBe('3')
        expect(lease().end_action).toBe('return')
        expect(asset('a1')).toMatchObject(stage('pending_wipe'))
        // A Spare pool unit goes through available, where it is the Provider's own stock again.
        expect(asset('a2')).toMatchObject({ ...stage('pending_wipe'), company: 'provider-co', x_daas_ham_agreement: '' })
        expect(rows(DISPOSALS)).toEqual([expect.objectContaining({ number: 'DSP0001', method: 'return_to_lessor', disposal_vendor: 'lessor-co' })])
        expect(rows(DISPOSALS)[0]?.short_description).toBe('Return stock to the lessor at the end of lease LSE0001')
        expect(rows(DISPOSAL_LINES).map((line) => [line.disposal_order, line.asset])).toEqual([
            [rows(DISPOSALS)[0]?.sys_id, 'a1'],
            [rows(DISPOSALS)[0]?.sys_id, 'a2'],
        ])
        expect(platform.events).toEqual([{ name: EVENT.leaseAssets, record: 'lease1', parm1: 'lease1', parm2: '', delayed: false }])
        expect(rows(LOCKS)).toEqual([])
        expect(platform.logs).toEqual([])
    })

    it('leaves a hot spare on an Order line, a reserved unit and an installed unit where they are', () => {
        returned()

        expect(asset('a3')).toMatchObject({ ...stage('spare_pool'), x_daas_ham_order_line: 'ol1', company: 'acme' })
        expect(asset('a4')).toMatchObject(stage('in_service'))
        expect(asset('a5')).toMatchObject({ ...stage('reserved'), x_daas_ham_order_line: 'ol2' })
    })

    it('counts a unit whose move is refused, and lists the rest', () => {
        platform.refuses = (table, row) => (table === ASSETS && row.sys_id === 'a1' ? 'stage rule said no' : '')

        expect(returned()).toEqual({
            applied: true,
            notes: ["The lease's stock awaits wipe on draft disposal order DSP0001"],
            problems: ['1 stock unit(s) of the lease could not go to pending wipe, so are not on the disposal; see the system log'],
        })

        expect(asset('a1')).toMatchObject(stage('available'))
        expect(rows(DISPOSAL_LINES).map((line) => line.asset)).toEqual(['a2'])
        expect(platform.warnings).toEqual([expect.stringContaining('Lease return: FOC-a1 not moved to pending_wipe: stage rule said no')])
    })

    it('counts a unit whose stock lock a claim holds through every try as not withdrawn', () => {
        platform.tables[LOCKS] = [{ sys_id: 'lock1', name: LOCK.reserveAsset('a1'), sys_created_on: '2026-03-01 08:00:00' }]

        expect(returned().problems).toEqual(['1 stock unit(s) of the lease could not go to pending wipe, so are not on the disposal; see the system log'])

        expect(asset('a1')).toMatchObject(stage('available'))
        expect(platform.warnings).toEqual([expect.stringContaining('Lease return: FOC-a1 not withdrawn: its stock lock could not be taken')])
    })

    it('leaves a unit a claim took since the query to that claim, uncounted', () => {
        // Sourcing reserves a1 as the return takes its stock lock.
        platform.onSave = (table, row, operation) => {
            if (table === LOCKS && operation === 'insert' && row.name === LOCK.reserveAsset('a1')) Object.assign(asset('a1'), stage('reserved'), { x_daas_ham_order_line: 'ol9' })
        }

        expect(returned()).toEqual({ applied: true, notes: ["The lease's stock awaits wipe on draft disposal order DSP0001"], problems: [] })

        expect(asset('a1')).toMatchObject({ ...stage('reserved'), x_daas_ham_order_line: 'ol9' })
        expect(rows(DISPOSAL_LINES).map((line) => line.asset)).toEqual(['a2'])
    })

    it('counts a unit at pending wipe whose disposal line is refused as unlisted', () => {
        platform.refuses = (table, row) => (table === DISPOSAL_LINES && row.asset === 'a2' ? 'line refused' : '')

        expect(returned()).toEqual({
            applied: true,
            notes: ["The lease's stock awaits wipe on draft disposal order DSP0001"],
            problems: ['1 stock unit(s) of the lease went to pending wipe but are on no disposal order; see the system log and add them to one by hand'],
        })

        expect(asset('a2')).toMatchObject(stage('pending_wipe'))
        expect(rows(DISPOSAL_LINES).map((line) => line.asset)).toEqual(['a1'])
        expect(platform.warnings).toEqual([expect.stringContaining('Lease return: FOC-a2 left off DSP0001: line refused')])
    })

    it('counts every withdrawn unit as unlisted when the disposal order itself is refused, asking for it once', () => {
        platform.refuses = (table) => (table === DISPOSALS ? 'no disposal today' : '')

        expect(returned()).toEqual({
            applied: true,
            notes: [],
            problems: ['2 stock unit(s) of the lease went to pending wipe but are on no disposal order; see the system log and add them to one by hand'],
        })

        expect(rows(DISPOSALS)).toEqual([])
        expect(rows(DISPOSAL_LINES)).toEqual([])
        expect(platform.warnings).toEqual([expect.stringContaining('Lease return: no disposal order for LSE0001: no disposal today')])
    })

    it('raises no disposal for a lease with no free stock', () => {
        platform.tables[ASSETS] = [leased('a4', 'in_service')]

        expect(returned()).toEqual({ applied: true, notes: [], problems: [] })

        expect(rows(DISPOSALS)).toEqual([])
        expect(platform.events.map((event) => event.name)).toEqual([EVENT.leaseAssets])
    })
})

describe('a decision that is not applied', () => {
    function leaseUntouched(): void {
        expect(lease()).toMatchObject({ end_action: 'undecided', ends: '2026-03-31' })
        expect(platform.events).toEqual([])
    }

    it('is one already closed', () => {
        decisionRow().active = 'false'

        expect(applyLeaseDecision(decide({ decision: 'buyout' }))).toEqual({ applied: false, notes: [], problems: ['This decision is closed'] })
        leaseUntouched()
    })

    it('is one whose lease schedule is gone', () => {
        platform.tables[LEASES] = []

        expect(applyLeaseDecision(decide({ decision: 'buyout' }))).toEqual({ applied: false, notes: [], problems: ['The lease schedule no longer exists'] })
    })

    it('is one with nothing chosen', () => {
        expect(applyLeaseDecision(decide({}))).toEqual({ applied: false, notes: [], problems: ['Choose buy out, extend or return'] })
        expect(decisionRow().state).toBe('1')
        leaseUntouched()
    })

    it.each([
        ['buyout', 'The lease is already being bought out'],
        ['return', 'The lease is already being returned to the lessor'],
    ])('is any decision on a lease whose end action is already %s', (endAction, problem) => {
        lease().end_action = endAction

        expect(applyLeaseDecision(decide({ decision: 'extend', new_end_date: '2027-03-31' }))).toEqual({ applied: false, notes: [], problems: [problem] })
        expect(decisionRow().state).toBe('1')
        expect(lease().ends).toBe('2026-03-31')
    })

    it('is one the platform refuses to close: nothing is told, and the lease is left alone', () => {
        platform.refuses = (table) => (table === DECISIONS ? 'mandatory field' : '')

        expect(applyLeaseDecision(decide({ decision: 'buyout' }))).toEqual({ applied: false, notes: [], problems: [] })
        expect(decisionRow().state).toBe('1')
        leaseUntouched()
    })
})

describe('a lease the platform refuses to save', () => {
    beforeEach(() => {
        platform.tables[ASSETS] = [leased('a1', 'available')]
    })

    function nothingStarted(): void {
        expect(lease().end_action).toBe('undecided')
        expect(asset('a1')).toMatchObject(stage('available'))
        expect(rows(DISPOSALS)).toEqual([])
        expect(platform.events).toEqual([])
    }

    it('opens the decision again and starts neither the transfer nor the return', () => {
        platform.refuses = (table) => (table === LEASES ? 'lease is locked' : '')

        expect(applyLeaseDecision(decide({ decision: 'return' }))).toEqual({
            applied: false,
            notes: [],
            problems: ['Lease LSE0001 not saved: lease is locked. The decision is open again'],
        })

        expect(decisionRow().state).toBe('1')
        nothingStarted()
    })

    it('says so when the decision cannot be opened again either, and logs it', () => {
        platform.refuses = (table, row) => (table === LEASES || (table === DECISIONS && row.state === '1') ? 'locked' : '')

        expect(applyLeaseDecision(decide({ decision: 'buyout' }))).toEqual({
            applied: false,
            notes: [],
            problems: ['Lease LSE0001 not saved: locked. The decision stays closed (see the system log); the daily lease review raises a new one'],
        })

        expect(decisionRow().state).toBe('3')
        expect(platform.warnings).toEqual([expect.stringContaining('Lease decision LDEC0001 not reopened (Lease LSE0001 not saved: locked): locked')])
        nothingStarted()
    })
})
