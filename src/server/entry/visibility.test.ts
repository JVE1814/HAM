import { beforeEach, describe, expect, it, vi } from 'vitest'

/*
 * The visibility scripts on a stand-in for the platform: what a reader may see is decided, and tested, in
 * domain/visibility; these tests cover what the scripts add, which is finding the scoping of the record they are
 * handed by its table, the hardware ACLs on alm_asset, and reading the record and the session.
 */

type Row = Record<string, string | Record<string, string>>

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

const REFERENCES = {
    'x_daas_ham_audit_line.audit': 'x_daas_ham_audit',
    'alm_transfer_order.from_stockroom': 'alm_stockroom',
    'alm_transfer_order.to_stockroom': 'alm_stockroom',
    'x_daas_ham_order.site': 'cmn_location',
    'x_daas_ham_return_order_line.return_order': 'x_daas_ham_return_order',
    'x_daas_ham_shipment_event.shipment': 'x_daas_ham_shipment',
    'x_daas_ham_site_template_item.site_template': 'x_daas_ham_site_template',
}

const { GlideRecord } = await import('@servicenow/glide')
const {
    createsCustomerReturn,
    deletesAsset,
    grantsCustomerRecord,
    grantsFleetAsset,
    readsAssetCost,
    readsRecord,
    scopeRecords,
    writesAsset,
    writesAssetCommercialField,
} = await import('./visibility.ts')
const { beyondVisibility } = await import('../platform/beyond-visibility.ts')
const { platform, recordOf } = await import('../test-support/fake-glide.ts')

type Reader = 'staff' | 'tech' | 'admin' | 'contact' | 'service desk'
const ROLES: Record<Reader, string[]> = {
    staff: ['x_daas_ham.noc'],
    tech: ['x_daas_ham.inventory_tech'],
    admin: ['x_daas_ham.customer_admin'],
    contact: ['x_daas_ham.site_contact'],
    'service desk': ['itil'],
}

const SITE1 = { sys_id: 'site1', company: 'cust1', x_daas_ham_site_contacts: '' }
const DEPOT = { sys_id: 'sr1', x_daas_ham_stockroom_type: 'central_depot', assignment_group: 'depot_crew' }
const OTHER_DEPOT = { sys_id: 'sr9', x_daas_ham_stockroom_type: 'central_depot' }

let users = 0
/**
 * Each is a new user: the modules
 * keep a user's session, and where a table is placed, for as long as they are loaded (on the platform, a transaction).
 */
function signIn(reader: Reader): void {
    const userId = `user${++users}`
    platform.user = { id: userId, name: '', company: 'cust1', roles: ROLES[reader], interactive: true }
    SITE1.x_daas_ham_site_contacts = `someone,${userId}`
    platform.tables.cmn_location = [SITE1]
    platform.tables.sys_user_grmember = [{ user: userId, group: 'depot_crew' }]
    platform.tables.alm_stockroom = [DEPOT, OTHER_DEPOT]
}

function withReferencesStored(table: string, row: Row): Record<string, string> {
    return Object.fromEntries(
        Object.entries(row).map(([field, value]) => {
            if (typeof value === 'string') return [field, value]
            const target = REFERENCES[`${table}.${field}` as keyof typeof REFERENCES]
            const others = (platform.tables[target] ?? []).filter((other) => other.sys_id !== value.sys_id)
            platform.tables[target] = [...others, value]
            return [field, value.sys_id ?? '']
        }),
    )
}

function record(table: string, row: Row, saved = true) {
    return recordOf<InstanceType<typeof GlideRecord>>(table, { sys_id: saved ? `${table}-row` : '', ...withReferencesStored(table, row) }, { fresh: !saved })
}

/** The rows of `table` a query finds once the table's before-query rule has run on it. */
function found(table: string, run: (current: InstanceType<typeof GlideRecord>) => void = scopeRecords): string[] {
    const current = new GlideRecord(table)
    run(current)
    current.query()
    const ids: string[] = []
    while (current.next()) ids.push(current.getUniqueValue())
    return ids
}

beforeEach(() => {
    platform.reset()
    platform.references = { ...REFERENCES }
})

describe('scopeRecords', () => {
    it('narrows a query by the scoping of its table', () => {
        platform.references['x_daas_ham_order_line.order'] = 'x_daas_ham_order'
        const seed = () => {
            platform.tables.x_daas_ham_audit = [
                { sys_id: 'audit-mine', stockroom: 'sr1' },
                { sys_id: 'audit-theirs', stockroom: 'sr9' },
            ]
            platform.tables.alm_stockroom.push({ sys_id: 'it-untyped', x_daas_ham_stockroom_type: '' }, { sys_id: 'it-store', x_daas_ham_stockroom_type: 'it_store' })
            platform.tables.x_daas_ham_order = [
                { sys_id: 'order-here', customer: 'cust1', site: 'site1' },
                { sys_id: 'order-elsewhere', customer: 'cust1', site: 'site9' },
                { sys_id: 'order-theirs', customer: 'cust9', site: 'site1' },
            ]
            platform.tables.x_daas_ham_order_line = [
                { sys_id: 'line-here', order: 'order-here' },
                { sys_id: 'line-elsewhere', order: 'order-elsewhere' },
            ]
            platform.tables.x_daas_ham_agreement = [{ sys_id: 'agreement1', customer: 'cust1' }]
        }
        const everyOrder = ['order-here', 'order-elsewhere', 'order-theirs']
        signIn('tech')
        seed()
        expect(found('x_daas_ham_audit')).toEqual(['audit-mine'])
        expect(found('alm_stockroom')).toEqual(['sr1', 'it-untyped', 'it-store'])
        expect(found('x_daas_ham_order')).toEqual(everyOrder)
        signIn('contact')
        seed()
        expect(found('x_daas_ham_order')).toEqual(['order-here'])
        expect(found('x_daas_ham_order_line')).toEqual(['line-here'])
        expect(found('x_daas_ham_agreement')).toEqual([])
        signIn('staff')
        expect(found('x_daas_ham_order')).toEqual(everyOrder)
        expect(platform.warnings).toEqual([])
    })

    it("narrows a query of a table that extends a scoped one as its parent's rule does, which runs for it too", () => {
        platform.parents.u_lab_hardware = ['alm_hardware', 'alm_asset']
        platform.parents.alm_hardware = ['alm_asset']
        platform.tables.alm_asset = [
            { sys_id: 'lab-ours', sys_class_name: 'u_lab_hardware', company: 'cust1' },
            { sys_id: 'lab-theirs', sys_class_name: 'u_lab_hardware', company: 'cust9' },
        ]
        signIn('admin')
        expect(found('u_lab_hardware')).toEqual(['lab-ours'])
        expect(found('alm_hardware')).toEqual(['lab-ours'])
        expect(platform.warnings).toEqual([])
    })

    it('reads the tables a table extends from a list that is no array, and places no table whose hierarchy the platform refuses', () => {
        platform.hierarchy.u_listed_audit = () => ({ toString: () => '[u_listed_audit, x_daas_ham_audit, task]' })
        platform.hierarchy.u_refused_audit = () => {
            throw new Error('not allowed')
        }
        const audits = [
            { sys_id: 'audit-mine', stockroom: 'sr1' },
            { sys_id: 'audit-theirs', stockroom: 'sr9' },
        ]
        platform.tables.u_listed_audit = audits
        platform.tables.u_refused_audit = audits
        signIn('tech')
        expect(found('u_listed_audit')).toEqual(['audit-mine'])
        expect(platform.warnings).toEqual([])
        expect(found('u_refused_audit')).toEqual([])
        expect(platform.warnings).toHaveLength(1)
    })

    it('leaves a query the app runs past the rules as it is', () => {
        platform.tables.alm_hardware = [
            { sys_id: 'ours', company: 'cust1' },
            { sys_id: 'theirs', company: 'cust9' },
        ]
        signIn('admin')
        expect(found('alm_hardware', (current) => beyondVisibility(current, () => scopeRecords(current)))).toEqual(['ours', 'theirs'])
    })

    it('shows a narrowed reader nothing of a table with no scoping, which only a wiring mistake can reach, and logs it', () => {
        platform.parents.u_unplaced = ['task']
        platform.tables.task = [{ sys_id: 'unplaced1', sys_class_name: 'u_unplaced', stockroom: 'sr1', company: 'cust1' }]
        for (const reader of ['tech', 'admin', 'contact'] as const) {
            signIn(reader)
            expect(found('u_unplaced'), reader).toEqual([])
        }
        expect(platform.warnings.length).toBeGreaterThan(0)
        expect(platform.warnings.every((warning) => warning.includes('u_unplaced'))).toBe(true)
        signIn('staff')
        expect(found('u_unplaced')).toEqual(['unplaced1'])
        signIn('service desk')
        expect(found('u_unplaced')).toEqual(['unplaced1'])
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
        const unsavedWithId = record('x_daas_ham_audit', { sys_id: 'not-saved-yet', stockroom: 'sr9' }, false)
        expect(readsRecord(unsavedWithId)).toBe(true)
    })

    it("reads a transfer order's Stockrooms past the rules, and refuses one whose Stockroom is not found", () => {
        signIn('tech')
        const order = (from: string, to: string) => record('alm_transfer_order', { from_stockroom: from, to_stockroom: to })
        platform.tables.alm_stockroom.push({ sys_id: 'it1', x_daas_ham_stockroom_type: '' }, { sys_id: 'it2', x_daas_ham_stockroom_type: '' })
        expect(readsRecord(order('it1', 'it2'))).toBe(true)
        expect(readsRecord(order('it1', ''))).toBe(true)
        expect(readsRecord(order('sr9', 'it1'))).toBe(false)
        // Stockrooms the reader's own rule would hide from a dot-walk, which then reads a blank type.
        expect(readsRecord(order('sr8', 'sr7'))).toBe(false)
        expect(readsRecord(order('sr8', 'sr1'))).toBe(true)
    })

    it('checks hardware on alm_asset, where its ACL sits: on the alm_hardware record, which an alm_asset row does not carry', () => {
        platform.tables.alm_hardware = [
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

describe('the checks of changes to hardware by hand', () => {
    const hardware = (row: Row) => record('alm_hardware', { sys_class_name: 'alm_hardware', ...row })
    const fleet = (row: Row = {}) => hardware({ x_daas_ham_fleet: '1', ...row })
    const CHECKS = { writesAsset, deletesAsset, writesAssetCommercialField, readsAssetCost }

    it('pass an Asset of another class, in case Applies To is not applied', () => {
        platform.parents.alm_consumable = ['alm_asset']
        for (const reader of ['tech', 'admin', 'contact', 'staff'] as const) {
            signIn(reader)
            for (const [name, check] of Object.entries(CHECKS)) {
                expect(check(record('alm_asset', { sys_class_name: 'alm_consumable', x_daas_ham_fleet: '1', company: 'cust9' })), `${reader} ${name}`).toBe(true)
            }
        }
    })

    it('pass hardware outside the fleet, which the platform decides alone', () => {
        for (const reader of ['tech', 'admin', 'contact', 'staff'] as const) {
            signIn(reader)
            for (const [name, check] of Object.entries(CHECKS)) {
                expect(check(hardware({ x_daas_ham_fleet: '0', stockroom: 'sr9', company: 'cust9' })), `${reader} ${name}`).toBe(true)
            }
        }
    })

    it('let an asset editor save a fleet asset their scope keeps, on the alm_hardware record of an alm_asset row', () => {
        platform.tables.alm_hardware = [
            { sys_id: 'mine', sys_class_name: 'alm_hardware', x_daas_ham_fleet: '1', stockroom: 'sr1' },
            { sys_id: 'theirs', sys_class_name: 'alm_hardware', x_daas_ham_fleet: '1', stockroom: 'sr9' },
        ]
        const assetRow = (id: string) => record('alm_asset', { sys_id: id, sys_class_name: 'alm_hardware' })
        signIn('tech')
        expect(writesAsset(assetRow('mine'))).toBe(true)
        expect(writesAsset(assetRow('theirs'))).toBe(false)
        expect(writesAsset(fleet({ stockroom: 'sr1' }))).toBe(true)
        expect(writesAsset(fleet({ stockroom: 'sr9' }))).toBe(false)
        // The NOC sees every fleet asset and runs none.
        signIn('staff')
        expect(writesAsset(fleet({ stockroom: 'sr1' }))).toBe(false)
        platform.user.roles = ['x_daas_ham.field_tech']
        expect(writesAsset(fleet({ stockroom: 'sr9' }))).toBe(true)
        signIn('admin')
        expect(writesAsset(fleet({ company: 'cust1' }))).toBe(false)
        signIn('service desk')
        expect(writesAsset(fleet({ stockroom: 'sr9' }))).toBe(true)
    })

    it('keep deleting a fleet asset to app administrators, and its company and cost to asset managers', () => {
        signIn('tech')
        expect(deletesAsset(fleet({ stockroom: 'sr1' }))).toBe(false)
        expect(writesAssetCommercialField(fleet({ stockroom: 'sr1' }))).toBe(false)
        signIn('staff')
        platform.user.roles = ['x_daas_ham.asset_manager']
        expect(deletesAsset(fleet())).toBe(false)
        expect(writesAssetCommercialField(fleet())).toBe(true)
        platform.user.roles = ['x_daas_ham.admin']
        expect(deletesAsset(fleet())).toBe(true)
    })

    it("keep a fleet asset's cost from Customer contacts", () => {
        for (const reader of ['admin', 'contact'] as const) {
            signIn(reader)
            expect(readsAssetCost(fleet({ company: 'cust1', x_daas_ham_site: 'site1' })), reader).toBe(false)
        }
        for (const reader of ['tech', 'staff', 'service desk'] as const) {
            signIn(reader)
            expect(readsAssetCost(fleet({ company: 'cust1' })), reader).toBe(true)
        }
    })

    it('pass a record that is not a saved row: a New form, a check of the whole table', () => {
        signIn('admin')
        for (const [name, check] of Object.entries(CHECKS)) {
            expect(check(new GlideRecord('alm_hardware')), name).toBe(true)
            expect(check(record('alm_hardware', { sys_class_name: 'alm_hardware', x_daas_ham_fleet: '1', company: 'cust9' }, false)), name).toBe(true)
        }
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
        platform.user.roles = ['x_daas_ham.customer_admin', 'x_daas_ham.inventory_tech']
        expect(grantsCustomerRecord(record('x_daas_ham_agreement', { customer: 'cust9' }))).toBe(false)
        signIn('contact')
        platform.user.roles = ['x_daas_ham.site_contact', 'x_daas_ham.noc']
        expect(grantsCustomerRecord(record('x_daas_ham_order', { customer: 'cust1', site: OTHER_SITE }))).toBe(false)
        expect(grantsCustomerRecord(record('x_daas_ham_order', { customer: 'cust1', site: SITE1 }))).toBe(true)
    })

    it('judges a record that is not a saved row by its values, and grants nothing of a table with no scoping', () => {
        signIn('admin')
        expect(grantsCustomerRecord(new GlideRecord('x_daas_ham_order'))).toBe(false)
        expect(grantsCustomerRecord(record('x_daas_ham_order', { customer: 'cust1' }, false))).toBe(true)
        expect(grantsCustomerRecord(record('x_daas_ham_order', { customer: 'cust9' }, false))).toBe(false)
        expect(grantsCustomerRecord(record('u_unplaced_grant', { customer: 'cust1' }))).toBe(false)
        expect(platform.warnings).toHaveLength(1)
    })
})

describe("the customer admins' create ACLs", () => {
    it('grant a Return of their own Customer, or one that names none yet', () => {
        signIn('admin')
        expect(createsCustomerReturn(record('x_daas_ham_return_order', { customer: 'cust1' }, false))).toBe(true)
        expect(createsCustomerReturn(record('x_daas_ham_return_order', { customer: 'cust9' }, false))).toBe(false)
        expect(createsCustomerReturn(new GlideRecord('x_daas_ham_return_order'))).toBe(true)
    })

    it('grant a user with no Company neither', () => {
        signIn('admin')
        platform.user = { ...platform.user, id: 'no-company', company: '' }
        expect(grantsCustomerRecord(record('x_daas_ham_order', { customer: 'cust1' }, false))).toBe(false)
        expect(grantsCustomerRecord(new GlideRecord('x_daas_ham_order'))).toBe(false)
        expect(createsCustomerReturn(record('x_daas_ham_return_order', { customer: 'cust1' }, false))).toBe(false)
        expect(createsCustomerReturn(new GlideRecord('x_daas_ham_return_order'))).toBe(false)
    })
})
