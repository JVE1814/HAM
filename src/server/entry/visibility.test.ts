import { beforeEach, describe, expect, it, vi } from 'vitest'

/*
 * The visibility scripts on a stand-in for the platform: what a reader may see is decided, and tested, in
 * domain/visibility; these tests cover what the scripts add, which is finding the scoping of the record they are
 * handed by its table, the hardware ACLs on alm_asset, and reading the record and the session.
 */

type Row = Record<string, string | Record<string, string>>

const platform = vi.hoisted(() => ({
    userId: '',
    roles: [] as string[],
    company: '',
    /** The rows a GlideRecord reads, by table. */
    rows: {} as Record<string, Array<Record<string, unknown>>>,
    /** The tables a table extends, nearest first. */
    parents: {} as Record<string, string[]>,
    /** What GlideTableHierarchy#getTables gives for a table, where it is not the array of the table and its parents. */
    hierarchy: {} as Record<string, () => unknown>,
    warnings: [] as string[],
}))

/** The value of `field` on `row`, dot-walked through the rows its references hold; null for blank. */
function valueOf(row: Record<string, unknown> | null, field: string): string | null {
    const [first, ...rest] = field.split('.')
    const value = row?.[first]
    if (rest.length > 0) return valueOf(typeof value === 'object' && value ? (value as Record<string, unknown>) : null, rest.join('.'))
    if (typeof value === 'object' && value) return String((value as Record<string, unknown>).sys_id ?? '') || null
    return value === undefined || value === '' ? null : String(value)
}

vi.mock('@servicenow/glide', () => {
    class GlideRecord {
        row: Record<string, unknown> | null = null
        fresh = false
        filters: string[] = []
        private found: Array<Record<string, unknown>> = []
        constructor(private table: string) {}
        getTableName = () => this.table
        isNewRecord = () => this.fresh
        getUniqueValue = () => valueOf(this.row, 'sys_id') ?? ''
        getValue = (field: string) => (field.includes('.') ? null : valueOf(this.row, field))
        getElement = (field: string) => ({ getValue: () => valueOf(this.row, field) })
        addEncodedQuery = (query: string) => void this.filters.push(query)
        setLimit = () => undefined
        get(id: string) {
            this.row = (platform.rows[this.table] ?? []).find((row) => row.sys_id === id) ?? null
            return this.row !== null
        }
        query() {
            this.found = (platform.rows[this.table] ?? []).filter((row) =>
                this.filters.every((filter) => {
                    const [, field, operator, operand] = /^(\w+?)(LIKE|=)(.*)$/.exec(filter) ?? []
                    const value = String(row[field] ?? '')
                    return operator === 'LIKE' ? value.includes(operand) : value === operand
                }),
            )
        }
        next() {
            this.row = this.found.shift() ?? null
            return this.row !== null
        }
    }
    return {
        GlideRecord,
        GlideAggregate: class {},
        GlideTableHierarchy: class {
            constructor(private table: string) {}
            getTables = () => platform.hierarchy[this.table]?.() ?? [this.table, ...(platform.parents[this.table] ?? [])]
        },
        gs: {
            getUserID: () => platform.userId,
            hasRole: (role: string) => platform.roles.includes(role),
            getUser: () => ({ getCompanyID: () => platform.company }),
            warn: (message: string) => void platform.warnings.push(message),
        },
    }
})

const { GlideRecord } = await import('@servicenow/glide')
const { grantsCustomerRecord, grantsFleetAsset, readsRecord, scopeRecords } = await import('./visibility.ts')
const { beyondVisibility } = await import('../platform/beyond-visibility.ts')

type Reader = 'staff' | 'tech' | 'admin' | 'contact' | 'service desk'
const ROLES: Record<Reader, string[]> = {
    staff: ['x_daas_ham.noc'],
    tech: ['x_daas_ham.inventory_tech'],
    admin: ['x_daas_ham.customer_admin'],
    contact: ['x_daas_ham.site_contact'],
    'service desk': ['itil'],
}

const SITE1 = { sys_id: 'site1', company: 'cust1', x_daas_ham_site_contacts: '' }
const DEPOT = { sys_id: 'sr1', x_daas_ham_stockroom_type: 'central_depot' }
const OTHER_DEPOT = { sys_id: 'sr9', x_daas_ham_stockroom_type: 'central_depot' }

let users = 0
/**
 * Sign in a user of Customer cust1, a member of stockroom sr1 and a contact of site1. Each is a new user: the modules
 * keep a user's session, and where a table is placed, for as long as they are loaded (on the platform, a transaction).
 */
function signIn(reader: Reader): void {
    platform.userId = `user${++users}`
    platform.roles = ROLES[reader]
    platform.company = 'cust1'
    SITE1.x_daas_ham_site_contacts = `someone,${platform.userId}`
    platform.rows.cmn_location = [SITE1]
    platform.rows.x_daas_ham_stockroom_member = [{ user: platform.userId, stockroom: 'sr1' }]
}

/** A saved record of `table`, as a rule or an ACL is handed it. */
function record(table: string, row: Row, saved = true) {
    const current = new GlideRecord(table)
    Object.assign(current, { row: { sys_id: saved ? `${table}-row` : '', ...row }, fresh: !saved })
    return current
}

function filterOf(table: string): string[] {
    const current = new GlideRecord(table)
    scopeRecords(current)
    return (current as unknown as { filters: string[] }).filters
}

beforeEach(() => {
    platform.warnings = []
    platform.parents = {}
    platform.hierarchy = {}
    platform.rows = {}
})

describe('scopeRecords', () => {
    it('narrows a query by the scoping of its table', () => {
        signIn('tech')
        expect(filterOf('x_daas_ham_audit')).toEqual(['stockroomINsr1'])
        expect(filterOf('alm_stockroom')).toEqual(['x_daas_ham_stockroom_typeNOT INcentral_depot,staging_centre,customer_site^ORx_daas_ham_stockroom_typeISEMPTY^ORsys_idINsr1'])
        expect(filterOf('x_daas_ham_order')).toEqual([])
        signIn('contact')
        expect(filterOf('x_daas_ham_order')).toEqual(['customer=cust1^siteINsite1'])
        expect(filterOf('x_daas_ham_order_line')).toEqual(['order.customer=cust1^order.siteINsite1'])
        expect(filterOf('x_daas_ham_agreement')).toEqual(['sys_id=-1'])
        signIn('staff')
        expect(filterOf('x_daas_ham_order')).toEqual([])
        expect(platform.warnings).toEqual([])
    })

    it("narrows a query of a table that extends a scoped one as its parent's rule does, which runs for it too", () => {
        platform.parents.u_lab_hardware = ['alm_hardware', 'alm_asset']
        signIn('admin')
        expect(filterOf('u_lab_hardware')).toEqual(filterOf('alm_hardware'))
        expect(filterOf('u_lab_hardware')).toEqual(['company=cust1'])
        expect(platform.warnings).toEqual([])
    })

    it('reads the tables a table extends from a list that is no array, and places no table whose hierarchy the platform refuses', () => {
        platform.hierarchy.u_listed_audit = () => ({ toString: () => '[u_listed_audit, x_daas_ham_audit, task]' })
        platform.hierarchy.u_refused_audit = () => {
            throw new Error('not allowed')
        }
        signIn('tech')
        expect(filterOf('u_listed_audit')).toEqual(['stockroomINsr1'])
        expect(platform.warnings).toEqual([])
        expect(filterOf('u_refused_audit')).toEqual(['sys_id=-1'])
        expect(platform.warnings).toHaveLength(1)
    })

    it('leaves a query the app runs past the rules as it is', () => {
        signIn('admin')
        const current = new GlideRecord('alm_hardware')
        beyondVisibility(current, () => scopeRecords(current))
        expect((current as unknown as { filters: string[] }).filters).toEqual([])
    })

    it('shows a narrowed reader nothing of a table with no scoping, which only a wiring mistake can reach, and logs it', () => {
        platform.parents.u_unplaced = ['task']
        for (const reader of ['tech', 'admin', 'contact'] as const) {
            signIn(reader)
            expect(filterOf('u_unplaced'), reader).toEqual(['sys_id=-1'])
        }
        expect(platform.warnings.length).toBeGreaterThan(0)
        expect(platform.warnings.every((warning) => warning.includes('u_unplaced'))).toBe(true)
        signIn('staff')
        expect(filterOf('u_unplaced')).toEqual([])
        signIn('service desk')
        expect(filterOf('u_unplaced')).toEqual([])
    })
})

describe('readsRecord', () => {
    it("denies what the table's rule would hide, on the fields of the record and its parent", () => {
        signIn('tech')
        expect(readsRecord(record('x_daas_ham_audit', { stockroom: 'sr1' }))).toBe(true)
        expect(readsRecord(record('x_daas_ham_audit', { stockroom: 'sr9' }))).toBe(false)
        expect(readsRecord(record('x_daas_ham_audit_line', { audit: { sys_id: 'a1', stockroom: 'sr1' } }))).toBe(true)
        expect(readsRecord(record('x_daas_ham_audit_line', { audit: { sys_id: 'a1', stockroom: 'sr9' } }))).toBe(false)
        expect(readsRecord(record('alm_transfer_order', { from_stockroom: OTHER_DEPOT, to_stockroom: DEPOT }))).toBe(true)
        expect(readsRecord(record('alm_transfer_order', { from_stockroom: OTHER_DEPOT, to_stockroom: OTHER_DEPOT }))).toBe(false)
        expect(readsRecord(record('alm_stockroom', { sys_id: 'sr9', x_daas_ham_stockroom_type: '' }))).toBe(true)
        signIn('staff')
        expect(readsRecord(record('x_daas_ham_audit', { stockroom: 'sr9' }))).toBe(true)
        expect(platform.warnings).toEqual([])
    })

    it('passes a record that is not a saved row: a New form, a check of the whole table', () => {
        signIn('tech')
        expect(readsRecord(record('x_daas_ham_audit', { stockroom: 'sr9' }, false))).toBe(true)
        expect(readsRecord(new GlideRecord('x_daas_ham_audit'))).toBe(true)
        const unsavedWithId = record('x_daas_ham_audit', { stockroom: 'sr9' })
        Object.assign(unsavedWithId, { fresh: true })
        expect(readsRecord(unsavedWithId)).toBe(true)
    })

    it('checks hardware on alm_asset, where its ACL sits: on the alm_hardware record, which an alm_asset row does not carry', () => {
        platform.rows.alm_hardware = [
            { sys_id: 'mine', sys_class_name: 'alm_hardware', x_daas_ham_fleet: '1', stockroom: 'sr1' },
            { sys_id: 'theirs', sys_class_name: 'alm_hardware', x_daas_ham_fleet: '1', stockroom: 'sr9' },
            { sys_id: 'laptop', sys_class_name: 'alm_hardware', x_daas_ham_fleet: '0', stockroom: 'sr9' },
        ]
        signIn('tech')
        const assetRow = (id: string) => record('alm_asset', { sys_id: id, sys_class_name: 'alm_hardware' })
        expect(readsRecord(assetRow('mine'))).toBe(true)
        expect(readsRecord(assetRow('theirs'))).toBe(false)
        expect(readsRecord(assetRow('laptop'))).toBe(true)
        // Not found: refused, not taken for hardware outside the fleet.
        expect(readsRecord(assetRow('gone'))).toBe(false)
        expect(readsRecord(record('alm_hardware', { sys_id: 'theirs', sys_class_name: 'alm_hardware', x_daas_ham_fleet: '1', stockroom: 'sr9' }))).toBe(false)
        expect(readsRecord(record('alm_hardware', { sys_id: 'mine', sys_class_name: 'alm_hardware', x_daas_ham_fleet: '1', stockroom: 'sr1' }))).toBe(true)
    })

    it('passes an Asset of another class, in case Applies To is not applied; no other table goes by its class', () => {
        platform.parents.alm_consumable = ['alm_asset']
        signIn('tech')
        expect(readsRecord(record('alm_asset', { sys_class_name: 'alm_consumable' }))).toBe(true)
        expect(readsRecord(record('alm_consumable', { sys_class_name: 'alm_consumable' }))).toBe(true)
        expect(platform.warnings).toEqual([])
        // An Audit extends task and so has a class of its own, which is no reason to pass it.
        expect(readsRecord(record('x_daas_ham_audit', { sys_class_name: 'x_daas_ham_audit', stockroom: 'sr9' }))).toBe(false)
    })

    it('refuses a narrowed reader a saved record of a table with no scoping, and logs it', () => {
        platform.parents.u_unplaced_row = ['task']
        signIn('tech')
        expect(readsRecord(record('u_unplaced_row', { stockroom: 'sr1' }))).toBe(false)
        expect(platform.warnings).toHaveLength(1)
        expect(readsRecord(record('u_unplaced_row', { stockroom: 'sr9' }))).toBe(false)
        // Logged once for a table in a transaction, not for every row.
        expect(platform.warnings).toHaveLength(1)
        signIn('staff')
        expect(readsRecord(record('u_unplaced_row', { stockroom: 'sr1' }))).toBe(true)
    })
})

describe('grantsFleetAsset', () => {
    it("grants a fleet asset the reader's scope keeps, no other hardware and no Asset of another class", () => {
        const hardware = (row: Row) => record('alm_hardware', { sys_class_name: 'alm_hardware', ...row })
        signIn('admin')
        expect(grantsFleetAsset(hardware({ x_daas_ham_fleet: '1', company: 'cust1' }))).toBe(true)
        expect(grantsFleetAsset(hardware({ x_daas_ham_fleet: '1', company: 'cust9' }))).toBe(false)
        expect(grantsFleetAsset(hardware({ x_daas_ham_fleet: '0', company: 'cust1' }))).toBe(false)
        expect(grantsFleetAsset(record('alm_asset', { sys_class_name: 'alm_consumable', company: 'cust1' }))).toBe(false)
        signIn('staff')
        expect(grantsFleetAsset(hardware({ x_daas_ham_fleet: '1', company: 'cust9' }))).toBe(true)
        expect(grantsFleetAsset(hardware({ x_daas_ham_fleet: '0', company: 'cust9' }))).toBe(false)
    })
})

describe('grantsCustomerRecord', () => {
    const OTHER_SITE = { sys_id: 'site9', company: 'cust1', x_daas_ham_site_contacts: 'someone' }

    it('grants a Customer admin the records of their Customer, on the record or its parent', () => {
        signIn('admin')
        expect(grantsCustomerRecord(record('x_daas_ham_agreement', { customer: 'cust1' }))).toBe(true)
        expect(grantsCustomerRecord(record('x_daas_ham_agreement', { customer: 'cust9' }))).toBe(false)
        expect(grantsCustomerRecord(record('x_daas_ham_order', { customer: 'cust1', site: OTHER_SITE }))).toBe(true)
        expect(grantsCustomerRecord(record('x_daas_ham_return_order_line', { return_order: { sys_id: 'r1', customer: 'cust1' } }))).toBe(true)
        expect(grantsCustomerRecord(record('x_daas_ham_return_order_line', { return_order: { sys_id: 'r1', customer: 'cust9' } }))).toBe(false)
        expect(grantsCustomerRecord(record('x_daas_ham_return_order_line', {}))).toBe(false)
    })

    it('grants a site contact those at a Site that lists them, and no table without a Site', () => {
        signIn('contact')
        expect(grantsCustomerRecord(record('x_daas_ham_order', { customer: 'cust1', site: SITE1 }))).toBe(true)
        expect(grantsCustomerRecord(record('x_daas_ham_order', { customer: 'cust1', site: OTHER_SITE }))).toBe(false)
        expect(grantsCustomerRecord(record('x_daas_ham_order', { customer: 'cust9', site: SITE1 }))).toBe(false)
        expect(grantsCustomerRecord(record('x_daas_ham_shipment_event', { shipment: { sys_id: 's1', customer: 'cust1', site: 'site1' } }))).toBe(true)
        expect(grantsCustomerRecord(record('x_daas_ham_shipment_event', { shipment: { sys_id: 's1', customer: 'cust1', site: 'site9' } }))).toBe(false)
        expect(grantsCustomerRecord(record('x_daas_ham_fee_event', { customer: 'cust1' }))).toBe(false)
    })

    it('offers a Site template with no Customer, and its items, to every Customer', () => {
        signIn('admin')
        expect(grantsCustomerRecord(record('x_daas_ham_site_template', {}))).toBe(true)
        expect(grantsCustomerRecord(record('x_daas_ham_site_template', { customer: 'cust9' }))).toBe(false)
        expect(grantsCustomerRecord(record('x_daas_ham_site_template_item', { site_template: { sys_id: 't1' } }))).toBe(true)
        expect(grantsCustomerRecord(record('x_daas_ham_site_template_item', { site_template: { sys_id: 't1', customer: 'cust9' } }))).toBe(false)
    })

    it('grants as the contact the ACL admits, whatever else the user holds: a staff role adds no record here', () => {
        signIn('admin')
        platform.roles = ['x_daas_ham.customer_admin', 'x_daas_ham.inventory_tech']
        expect(grantsCustomerRecord(record('x_daas_ham_agreement', { customer: 'cust9' }))).toBe(false)
        signIn('contact')
        platform.roles = ['x_daas_ham.site_contact', 'x_daas_ham.noc']
        expect(grantsCustomerRecord(record('x_daas_ham_order', { customer: 'cust1', site: OTHER_SITE }))).toBe(false)
        expect(grantsCustomerRecord(record('x_daas_ham_order', { customer: 'cust1', site: SITE1 }))).toBe(true)
    })

    it('judges a record that is not a saved row by its values, and grants nothing of a table with no scoping', () => {
        signIn('admin')
        expect(grantsCustomerRecord(new GlideRecord('x_daas_ham_order'))).toBe(false)
        expect(grantsCustomerRecord(record('x_daas_ham_order', { customer: 'cust1' }, false))).toBe(true)
        expect(grantsCustomerRecord(record('u_unplaced_grant', { customer: 'cust1' }))).toBe(false)
        expect(platform.warnings).toHaveLength(1)
    })
})
