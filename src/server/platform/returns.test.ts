import type { GlideRecord } from '@servicenow/glide'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fieldsOf, type Stage } from '../domain/lifecycle.ts'
import { LOCK } from '../domain/lock-names.ts'
import { FEE_STATUS, RETURN_LINE_STATUS } from '../domain/vocabulary.ts'
import { withLock } from './locks.ts'
import { chaseOverdue, contactReturnInsertRefusal, raiseReturn, requestProducedReturn, requestReturn, returnSwappedAssets } from './returns.ts'
import { platform, recordOf, type Row } from '../test-support/fake-glide.ts'

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

const RETURNS = 'x_daas_ham_return_order'
const RETURN_LINES = 'x_daas_ham_return_order_line'
const FEES = 'x_daas_ham_fee_event'
const LOCKS = 'x_daas_ham_job_lock'

const rows = (table: string): Row[] => platform.tables[table] ?? []

function unit(stage: Stage): Row {
    const { installStatus, substatus } = fieldsOf(stage)
    return { sys_id: 'a1', serial_number: 'FOC111', x_daas_ham_fleet: 'true', x_daas_ham_site: 'site1', x_daas_ham_agreement: 'ag1', install_status: installStatus, substatus: substatus ?? '' }
}

function raise() {
    return raiseReturn({
        trigger: 'device_removal',
        customerId: 'acme',
        siteId: 'site1',
        agreementId: '',
        method: 'ship_back',
        assetIds: ['a1'],
        description: 'Return of a1',
    })
}

beforeEach(() => {
    platform.reset()
    platform.uniqueKeys = { [LOCKS]: 'name' }
    platform.defaults = { [RETURNS]: () => ({ number: 'RET0002' }) }
    platform.tables.alm_hardware = [unit('in_service')]
})

describe('a unit whose return lock is held through every try', () => {
    beforeEach(() => {
        // Another Return holds the unit's return lock, taken just now.
        platform.tables[LOCKS] = [{ sys_id: 'lock1', name: LOCK.returnAsset('a1'), sys_created_on: '2025-11-09 12:00:00' }]
    })

    it('is left to the Return that took it, when it awaits that one by now', () => {
        platform.tables[RETURN_LINES] = [{ sys_id: 'line1', return_order: 'ret1', asset: 'a1', status: 'awaiting' }]
        expect(raise()).toEqual({ number: 'RET0002', lines: 0 })
        expect(rows(RETURN_LINES)).toHaveLength(1)
        expect(platform.warnings).toEqual([])
        expect(platform.notesOn(rows(RETURNS)[0]?.sys_id)).toEqual(['No equipment to bring back.'])
    })

    it('is warned about and counted as refused when it awaits no return: its holder never put it on one', () => {
        expect(raise()).toEqual({ number: 'RET0002', lines: 0 })
        expect(rows(RETURN_LINES)).toEqual([])
        expect(platform.warnings).toEqual([expect.stringContaining('a1')])
        expect(platform.notesOn(rows(RETURNS)[0]?.sys_id)).toEqual(['No unit could be added (see the system log).'])
    })
})

describe("a Customer admin's device removal", () => {
    beforeEach(() => {
        platform.user = { id: 'u1', name: 'Ada', company: 'acme', roles: ['x_daas_ham.customer_admin'], interactive: true }
        platform.creatable = () => true
        platform.defaults[RETURN_LINES] = () => ({ status: RETURN_LINE_STATUS.awaiting })
        platform.defaults[FEES] = () => ({ status: FEE_STATUS.open })
        platform.references = { [`${RETURN_LINES}.return_order`]: RETURNS, [`${RETURNS}.agreement`]: 'x_daas_ham_agreement' }
        platform.clock = Date.parse('2026-11-11T06:00:00Z')
        platform.tables.cmn_location = [{ sys_id: 'site1', name: 'HQ', company: 'acme', x_daas_ham_is_site: 'true' }]
        platform.tables.x_daas_ham_agreement = [{ sys_id: 'ag1', lost_asset_fee: '500', overdue_return_days: '10' }]
    })

    const removeA1 = () => requestReturn({ customerId: 'acme', siteId: 'site1', decommission: false, listedAssetIds: ['a1'], method: 'ship_back', describe: (site) => `Return from ${site}` })

    it('takes a unit still shipped to the Site', () => {
        platform.tables.alm_hardware = [unit('shipped')]
        expect(removeA1()).toEqual({ raised: true, number: 'RET0002', lines: 1 })
    })

    it('names a unit pending return as already on a return', () => {
        platform.tables.alm_hardware = [unit('pending_return')]
        platform.tables[RETURN_LINES] = [{ sys_id: 'lineA', return_order: 'retA', asset: 'a1', status: 'awaiting' }]
        expect(removeA1()).toMatchObject({ raised: false, reason: 'awaited' })
    })

    it('ignores a unit already declared missing, so its lost fee is charged once', () => {
        platform.tables.alm_hardware = [unit('missing')]
        platform.tables[RETURNS] = [{ sys_id: 'retA', number: 'RET0001', state: '3', due_back: '2026-09-01' }]
        platform.tables[RETURN_LINES] = [{ sys_id: 'lineA', return_order: 'retA', asset: 'a1', status: 'missing' }]
        platform.tables[FEES] = [{ sys_id: 'fee1', fee_type: 'lost', asset: 'a1', return_order: 'retA', status: 'open', amount: '500' }]
        expect(removeA1()).toMatchObject({ raised: false, reason: 'nothing' })
        platform.clock = Date.parse('2026-12-31T06:00:00Z')
        chaseOverdue()
        expect(rows(FEES).filter((fee) => fee.fee_type === 'lost' && fee.asset === 'a1')).toHaveLength(1)
    })
})

describe("a Customer admin's site decommission", () => {
    beforeEach(() => {
        platform.user = { id: 'u1', name: 'Ada', company: 'acme', roles: ['x_daas_ham.customer_admin'], interactive: true }
        platform.creatable = () => true
        platform.defaults[RETURN_LINES] = () => ({ status: RETURN_LINE_STATUS.awaiting })
        platform.references = { [`${RETURN_LINES}.return_order`]: RETURNS, [`${RETURNS}.agreement`]: 'x_daas_ham_agreement' }
        platform.tables.cmn_location = [{ sys_id: 'site1', name: 'HQ', company: 'acme', x_daas_ham_is_site: 'true' }]
        platform.tables.x_daas_ham_agreement = [{ sys_id: 'ag1', overdue_return_days: '10' }]
    })

    const decommission = () => requestReturn({ customerId: 'acme', siteId: 'site1', decommission: true, listedAssetIds: [], method: 'ship_back', describe: (site) => `Decommission of ${site}` })
    const returning = (): string[] => rows(RETURN_LINES).map((line) => line.asset)

    it("takes back the Customer's own units at the Site, in every stage it recovers", () => {
        platform.tables.alm_hardware = [
            { ...unit('in_service'), sys_id: 'a1', company: 'acme' },
            { ...unit('shipped'), sys_id: 'a2', company: 'acme' },
        ]
        expect(decommission()).toEqual({ raised: true, number: 'RET0002', lines: 2 })
        expect(returning().sort()).toEqual(['a1', 'a2'])
    })

    it("leaves a unit at the Site that is another Customer's, or no Customer's, off the Return, whatever its stage", () => {
        platform.tables.alm_hardware = [
            { ...unit('in_service'), sys_id: 'a1', company: 'acme' },
            { ...unit('shipped'), sys_id: 'b1', company: 'other' },
            { ...unit('in_service'), sys_id: 'b2', company: 'other' },
            { ...unit('in_service'), sys_id: 'b3', company: '' },
        ]
        expect(decommission()).toEqual({ raised: true, number: 'RET0002', lines: 1 })
        expect(returning()).toEqual(['a1'])
    })
})

describe('the daily chase of overdue returns', () => {
    beforeEach(() => {
        platform.references = { [`${RETURN_LINES}.return_order`]: RETURNS, [`${RETURNS}.agreement`]: 'x_daas_ham_agreement' }
        platform.clock = Date.parse('2026-11-11T05:20:00Z')
        platform.tables.alm_hardware = [unit('pending_return')]
        // Due back ten days ago: overdue, and within the 14 days of grace before the unit is declared missing.
        platform.tables[RETURNS] = [{ sys_id: 'retA', number: 'RET0001', customer: 'acme', due_back: '2026-11-01', escalated: 'false' }]
        platform.tables[RETURN_LINES] = [{ sys_id: 'lineA', return_order: 'retA', asset: 'a1', status: 'awaiting' }]
    })

    const notices = () => platform.events.filter((event) => event.name === 'x_daas_ham.return.overdue')

    it('escalates an overdue Return order once, and lets its run lock go', () => {
        chaseOverdue()
        chaseOverdue()

        expect(rows(RETURNS)[0]?.escalated).toBe('true')
        expect(notices()).toHaveLength(1)
        expect(rows(LOCKS)).toEqual([])
    })

    it('chases nothing while another run holds its lock, and says so', () => {
        const other = withLock(LOCK.overdueReturnsRun(), () => chaseOverdue())

        expect(other.ran).toBe(true)
        expect(rows(RETURNS)[0]?.escalated).toBe('false')
        expect(notices()).toEqual([])
        expect(platform.logs).toContainEqual(expect.stringContaining(LOCK.overdueReturnsRun()))
    })
})

describe('a Return order saved in a Customer contact session', () => {
    // Users no other test of this file signs in as: a user's scope is kept for as long as the modules are loaded.
    const ADMIN = { id: 'direct-admin', name: 'Ada', company: 'acme', roles: ['x_daas_ham.customer_admin'], interactive: true }
    const SITE_CONTACT = { id: 'direct-contact', name: 'Sam', company: 'acme', roles: ['x_daas_ham.site_contact'], interactive: true }
    const STAFF = { id: 'direct-staff', name: 'Max', company: 'provider', roles: ['x_daas_ham.asset_manager'], interactive: true }
    const OWN_CUSTOMER = 'Return not raised. You can only request returns for your own customer.'

    const refusalOf = (row: Row) => contactReturnInsertRefusal(recordOf<GlideRecord>(RETURNS, row, { fresh: true }))

    /** Run the check on every insert of a Return order, as the platform runs the before-insert rule. */
    function withTheRule(): void {
        platform.refuses = (table, row, operation) => (table === RETURNS && operation === 'insert' ? (refusalOf(row) ?? '') : '')
    }

    beforeEach(() => {
        platform.creatable = () => true
        platform.defaults[RETURN_LINES] = () => ({ status: RETURN_LINE_STATUS.awaiting })
        platform.references = { [`${RETURN_LINES}.return_order`]: RETURNS, [`${RETURNS}.agreement`]: 'x_daas_ham_agreement' }
        platform.tables.cmn_location = [
            { sys_id: 'site1', name: 'HQ', company: 'acme', x_daas_ham_is_site: 'true' },
            { sys_id: 'site9', name: 'Elsewhere', company: 'other', x_daas_ham_is_site: 'true' },
        ]
        platform.tables.x_daas_ham_agreement = [{ sys_id: 'ag1', overdue_return_days: '10' }]
        platform.tables.alm_hardware = [{ ...unit('in_service'), company: 'acme' }]
    })

    it('is refused unless it names their own Customer and one of its Sites', () => {
        platform.user = ADMIN
        expect(refusalOf({})).toBe(OWN_CUSTOMER)
        expect(refusalOf({ customer: 'other', site: 'site9' })).toBe(OWN_CUSTOMER)
        expect(refusalOf({ customer: 'acme' })).toBe("Return not raised. Choose one of the customer's sites.")
        expect(refusalOf({ customer: 'acme', site: 'site9' })).toBe("Return not raised. The site is not one of the customer's sites.")
        expect(refusalOf({ customer: 'acme', site: 'site1' })).toBeNull()
    })

    it('is not checked when provider staff save it: they raise Returns for any Customer', () => {
        platform.user = STAFF
        expect(refusalOf({})).toBeNull()
        expect(refusalOf({ customer: 'other', site: 'site1' })).toBeNull()
    })

    it("passes the customer page's request, and refuses a Return raised for another Customer", () => {
        withTheRule()
        platform.user = ADMIN
        const requested = requestReturn({ customerId: 'acme', siteId: 'site1', decommission: false, listedAssetIds: ['a1'], method: 'ship_back', describe: (site) => `Return from ${site}` })
        expect(requested).toEqual({ raised: true, number: 'RET0002', lines: 1 })

        const theirs = raiseReturn({ trigger: 'device_removal', customerId: 'other', siteId: 'site9', agreementId: '', method: 'ship_back', assetIds: [], description: 'Not theirs' })
        expect(theirs).toBeNull()
        expect(rows(RETURNS).map((saved) => saved.customer)).toEqual(['acme'])
    })

    it("passes the swap-back a site contact's install confirmation raises: who asks is not the rule's to judge", () => {
        withTheRule()
        platform.user = SITE_CONTACT
        const order = recordOf<GlideRecord>('x_daas_ham_order', { sys_id: 'ord1', number: 'ORD0001', order_type: 'device_replace', customer: 'acme', site: 'site1', agreement: 'ag1', install_mode: 'self_install' })
        expect(returnSwappedAssets(order, ['a1'])).toEqual({ number: 'RET0002', lines: 1 })
        expect(rows(RETURNS).map((saved) => [saved.customer, saved.site, saved.trigger])).toEqual([['acme', 'site1', 'defective_return']])
    })
})

describe('a Return order left open that no line keeps open', () => {
    const CLOSED = '3'
    const leftOpen = (fields: Row = {}): Row => ({ sys_id: 'retB', number: 'RET0009', customer: 'acme', site: 'site1', active: 'true', state: '1', sys_created_on: '2026-11-09 08:00:00', ...fields })
    const line = (sysId: string, status: string): Row => ({ sys_id: sysId, return_order: 'retB', asset: 'a1', status })
    const stateOf = (sysId: string) => rows(RETURNS).find((stored) => stored.sys_id === sysId)?.state

    beforeEach(() => {
        platform.references = { [`${RETURN_LINES}.return_order`]: RETURNS, [`${RETURNS}.agreement`]: 'x_daas_ham_agreement' }
        platform.clock = Date.parse('2026-11-11T05:20:00Z')
        platform.tables[RETURNS] = [leftOpen()]
        platform.tables[RETURN_LINES] = []
    })

    it('is closed by the daily job when it has no line, with a work note, and logged', () => {
        chaseOverdue()

        expect(rows(RETURNS)[0]?.state).toBe(CLOSED)
        expect(platform.notesOn(rows(RETURNS)[0]?.sys_id)).toEqual(['Closed by the daily job: no unit on it is awaited or being evaluated.'])
        expect(platform.logs).toEqual([expect.stringContaining('Return RET0009 closed by the daily job: no line keeps it open')])
        expect(rows(LOCKS)).toEqual([])
    })

    it('is closed when its lines are all evaluated or missing: a close refused as the last one was settled', () => {
        platform.tables[RETURN_LINES] = [line('line1', 'evaluated'), line('line2', 'missing')]

        chaseOverdue()

        expect(stateOf('retB')).toBe(CLOSED)
    })

    it.each(['awaiting', 'received'])('stays open while a line of it is %s', (status) => {
        platform.tables[RETURNS] = [leftOpen({ due_back: '2026-12-01' })]
        platform.tables[RETURN_LINES] = [line('line1', 'evaluated'), line('line2', status)]

        chaseOverdue()

        expect(stateOf('retB')).toBe('1')
        expect(platform.logs).toEqual([])
    })

    it('stays open for a day after it was created: its lines may still be added by hand', () => {
        platform.tables[RETURNS] = [leftOpen({ sys_created_on: '2026-11-10 05:20:00' })]

        chaseOverdue()

        expect(stateOf('retB')).toBe('1')

        platform.clock += 1000
        chaseOverdue()

        expect(stateOf('retB')).toBe(CLOSED)
    })

    it('is left as it is once closed by hand', () => {
        platform.tables[RETURNS] = [leftOpen({ active: 'false', state: '4' })]

        chaseOverdue()

        expect(stateOf('retB')).toBe('4')
        expect(platform.logs).toEqual([])
    })

    it('is warned about when the platform refuses the close, and closed by a later run', () => {
        platform.refuses = (table) => (table === RETURNS ? 'closing needs close notes' : '')

        chaseOverdue()

        expect(stateOf('retB')).toBe('1')
        expect(platform.warnings).toEqual([expect.stringContaining('Return RET0009 not closed, close it: closing needs close notes')])

        platform.refuses = () => ''
        chaseOverdue()

        expect(stateOf('retB')).toBe(CLOSED)
    })

    it('closes nothing while another run holds the run lock', () => {
        const other = withLock(LOCK.overdueReturnsRun(), () => chaseOverdue())

        expect(other.ran).toBe(true)
        expect(stateOf('retB')).toBe('1')
    })
})

describe('a Return order the record producer saved for a requester who may not request it', () => {
    const produced = () => recordOf<GlideRecord>(RETURNS, rows(RETURNS)[0] ?? {}, { produced: true })

    beforeEach(() => {
        platform.user = { id: 'produced-plain', name: 'Pat', company: 'provider', roles: [], interactive: true }
        platform.creatable = () => false
        platform.tables.cmn_location = [{ sys_id: 'site1', name: 'HQ', company: 'acme', x_daas_ham_is_site: 'true' }]
        platform.tables[RETURNS] = [{ sys_id: 'ret1', number: 'RET0001', customer: 'acme', site: 'site1', trigger: 'device_removal', state: '1' }]
    })

    it('is removed again, with no line', () => {
        expect(requestProducedReturn(produced(), ['a1'])).toEqual({ raised: false, reason: 'forbidden', why: 'You may not request returns' })

        expect(rows(RETURNS)).toEqual([])
        expect(rows(RETURN_LINES)).toEqual([])
        expect(platform.warnings).toEqual([])
    })

    it('is logged, to cancel, when the platform keeps it', () => {
        platform.refuses = (table, _row, operation) => (table === RETURNS && operation === 'delete' ? 'kept for this test' : '')

        requestProducedReturn(produced(), ['a1'])

        expect(rows(RETURNS)).toHaveLength(1)
        expect(platform.warnings).toEqual(['[x_daas_ham] Refused return RET0001 not removed: kept for this test'])
    })
})
