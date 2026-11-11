import { describe, expect, it } from 'vitest'
import { recordMatches as matches } from '../test-support/encoded-query'
import { naasStockroomCondition, outsideNaasStockroomCondition } from './fleet'
import { EQUIPMENT_HANDLERS, ROLE } from './roles'
import {
    actsAsCustomerAdmin,
    contactScope,
    deletesFleetAsset,
    grantsContactRecord,
    grantsNaasRecord,
    grantsReturnOfOwnCustomer,
    isCustomerContact,
    outsideNaasConditions,
    readsFleetProviderField,
    resolveVisibility,
    rowVisible,
    SCOPED_TABLES,
    scopingOf,
    visibilityFilter,
    writesFleetAsset,
    writesFleetCommercialField,
    type ScopedRow,
    type ScopedTable,
    type ScopingIds,
    type TableScoping,
    type VisibilityScope,
} from './visibility'

const roles = (...held: string[]) => (role: string) => held.includes(role)

describe('resolveVisibility', () => {
    it('gives provider staff with any broad role the whole installed base', () => {
        expect(resolveVisibility(roles('x_daas_ham.asset_manager', 'x_daas_ham.inventory_tech'))).toBe('everything')
        expect(resolveVisibility(roles('x_daas_ham.noc'))).toBe('everything')
        expect(resolveVisibility(roles('x_daas_ham.field_tech'))).toBe('everything')
    })

    it('limits inventory techs without a broader role to their stockrooms', () => {
        expect(resolveVisibility(roles('x_daas_ham.inventory_tech'))).toBe('assigned_stockrooms')
    })

    it('limits customer admins to their own customer', () => {
        expect(resolveVisibility(roles('x_daas_ham.customer_admin'))).toBe('own_customer')
    })

    it('limits site contacts to their own sites unless they are also a customer admin', () => {
        expect(resolveVisibility(roles('x_daas_ham.site_contact'))).toBe('own_sites')
        expect(resolveVisibility(roles('x_daas_ham.site_contact', 'x_daas_ham.customer_admin'))).toBe('own_customer')
    })

    it('leaves everyone else to the platform ACLs', () => {
        expect(resolveVisibility(roles('itil'))).toBe('unscoped')
    })
})

describe('actsAsCustomerAdmin', () => {
    it('lets customer admins, also when they are site contacts, take the customer-admin actions', () => {
        expect(actsAsCustomerAdmin(resolveVisibility(roles('x_daas_ham.customer_admin')))).toBe(true)
        expect(actsAsCustomerAdmin(resolveVisibility(roles('x_daas_ham.site_contact', 'x_daas_ham.customer_admin')))).toBe(true)
    })

    it('leaves them out for site contacts and for staff who see every customer, even holding the role', () => {
        expect(actsAsCustomerAdmin(resolveVisibility(roles('x_daas_ham.site_contact')))).toBe(false)
        expect(actsAsCustomerAdmin(resolveVisibility(roles('x_daas_ham.asset_manager')))).toBe(false)
        expect(actsAsCustomerAdmin(resolveVisibility(roles('x_daas_ham.asset_manager', 'x_daas_ham.customer_admin')))).toBe(false)
        expect(actsAsCustomerAdmin(resolveVisibility(() => true))).toBe(false) // a platform admin holds every role
    })
})

describe('visibilityFilter', () => {
    const ids = {
        customerId: 'cust1',
        stockroomIds: () => ['sr1', 'sr2'],
        siteIds: () => ['site1'],
    }
    const assetFields = { stockroom: 'stockroom', customer: 'company', site: 'x_daas_ham_site' }

    it('adds no filter for staff who see everything or users left to ACLs', () => {
        expect(visibilityFilter('everything', assetFields, ids)).toBeNull()
        expect(visibilityFilter('unscoped', assetFields, ids)).toBeNull()
    })

    it("keeps site contacts to their own Customer, as the read ACLs do, so another Customer's Site listing them shows nothing", () => {
        const locationFields = { customer: 'company', site: 'sys_id' }
        expect(visibilityFilter('own_sites', locationFields, { ...ids, siteIds: () => ['site1', 'other_customer_site'] })).toBe(
            'company=cust1^sys_idINsite1,other_customer_site',
        )
        expect(visibilityFilter('own_sites', locationFields, { ...ids, customerId: '' })).toBe('sys_id=-1')
    })

    it('shows nothing when the user has no stockrooms, sites or customer', () => {
        const none = { customerId: '', stockroomIds: () => [], siteIds: () => [] }
        expect(visibilityFilter('assigned_stockrooms', assetFields, none)).toBe('sys_id=-1')
        expect(visibilityFilter('own_customer', assetFields, none)).toBe('sys_id=-1')
        expect(visibilityFilter('own_sites', assetFields, none)).toBe('sys_id=-1')
    })

    it('shows a site contact nothing when their Customer is set but no Site lists them', () => {
        const noSites = { customerId: 'cust1', stockroomIds: () => expect.unreachable('stockrooms fetched'), siteIds: () => [] }
        expect(visibilityFilter('own_sites', assetFields, noSites)).toBe('sys_id=-1')
        expect(visibilityFilter('own_sites', SCOPED_TABLES.x_daas_ham_order, noSites)).toBe('sys_id=-1')
        expect(visibilityFilter('own_sites', SCOPED_TABLES.alm_hardware, noSites)).toBe('sys_id=-1')
    })

    it('leaves inventory techs unfiltered on tables without a stockroom (read ACLs close the ones they may not read)', () => {
        expect(visibilityFilter('assigned_stockrooms', { customer: 'customer' }, ids)).toBeNull()
    })

    it('hides tables without a customer field from external users', () => {
        expect(visibilityFilter('own_customer', { stockroom: 'stockroom' }, ids)).toBe('sys_id=-1')
        expect(visibilityFilter('own_sites', { customer: 'customer' }, ids)).toBe('sys_id=-1')
        expect(visibilityFilter('own_sites', { site: 'site' }, ids)).toBe('sys_id=-1')
    })
})

function records(values: Record<string, readonly string[]>): Array<Record<string, string>> {
    return Object.entries(values).reduce<Array<Record<string, string>>>(
        (found, [field, options]) => found.flatMap((record) => options.map((value) => ({ ...record, [field]: value }))),
        [{}],
    )
}

/** A saved row of `record`'s values, as a read ACL's row check reads it. */
function rowOf(record: Record<string, string>): ScopedRow {
    return { saved: true, valueOf: (field) => record[field] ?? '' }
}

const SCOPES: readonly VisibilityScope[] = ['everything', 'unscoped', 'assigned_stockrooms', 'own_customer', 'own_sites']
const TABLES = Object.keys(SCOPED_TABLES) as ScopedTable[]
const scopingOfTable = (table: ScopedTable): TableScoping => SCOPED_TABLES[table]
/** The tables the app shares with the Provider's IT: those with records outside NaaS. */
const SHARED_TABLES = TABLES.filter((table) => outsideNaasConditions(scopingOfTable(table)).length > 0)

/** The readers the rules narrow: an inventory tech of stockroom sr1, and Customer cust1's admin and its contact at site1. */
type Reader = 'tech' | 'admin' | 'contact'
const READERS: readonly Reader[] = ['tech', 'admin', 'contact']
const READER_SCOPE: Record<Reader, VisibilityScope> = { tech: 'assigned_stockrooms', admin: 'own_customer', contact: 'own_sites' }
const READER_IDS: ScopingIds = { customerId: 'cust1', stockroomIds: () => ['sr1'], siteIds: () => ['site1'] }

type Sample = [record: Record<string, string>, seenBy: readonly Reader[]]

const TYPE = 'x_daas_ham_stockroom_type'
/** Records with a Customer and a Site. An inventory tech is not narrowed on a table that names no Stockroom. */
const CUSTOMER_SITE: Sample[] = [
    [{ customer: 'cust1', site: 'site1' }, ['tech', 'admin', 'contact']],
    [{ customer: 'cust1', site: 'site9' }, ['tech', 'admin']],
    [{ customer: 'cust1', site: '' }, ['tech', 'admin']],
    // Another Customer's Site that lists the contact shows them nothing.
    [{ customer: 'cust9', site: 'site1' }, ['tech']],
    [{ customer: '', site: '' }, ['tech']],
]
/** Records with a Customer and no Site: a site contact gets none. */
const CUSTOMER: Sample[] = [
    [{ customer: 'cust1' }, ['tech', 'admin']],
    [{ customer: 'cust9' }, ['tech']],
    [{ customer: '' }, ['tech']],
]
const AUDITS: Sample[] = [
    [{ stockroom: 'sr1', customer: '', site: '' }, ['tech']],
    [{ stockroom: 'sr9', customer: 'cust1', site: '' }, ['admin']],
    // A site audit has no Stockroom, so an inventory tech does not see it.
    [{ stockroom: '', customer: 'cust1', site: 'site1' }, ['admin', 'contact']],
    [{ stockroom: '', customer: 'cust1', site: 'site9' }, ['admin']],
    [{ stockroom: '', customer: 'cust9', site: 'site1' }, []],
]
/** `samples` on a line table, whose scoping fields are its parent's, reached through `parent`. */
const through = (parent: string, samples: Sample[]): Sample[] =>
    samples.map(([record, seenBy]) => [Object.fromEntries(Object.entries(record).map(([field, value]) => [`${parent}.${field}`, value])), seenBy])

const SAMPLES: Record<ScopedTable, Sample[]> = {
    alm_hardware: [
        [{ x_daas_ham_fleet: 'true', stockroom: 'sr1', company: 'cust1', x_daas_ham_site: 'site1' }, ['tech', 'admin', 'contact']],
        [{ x_daas_ham_fleet: 'true', stockroom: 'sr9', company: 'cust1', x_daas_ham_site: 'site9' }, ['admin']],
        [{ x_daas_ham_fleet: 'true', stockroom: '', company: 'cust9', x_daas_ham_site: 'site1' }, []],
        // The Provider IT's hardware: left to the platform for an inventory tech, another company's to a Customer contact.
        [{ x_daas_ham_fleet: 'false', stockroom: 'sr9', company: 'cust9', x_daas_ham_site: '' }, ['tech']],
        // A row from before the Fleet flag is outside the fleet too; a contact is kept to their Customer, fleet or not.
        [{ x_daas_ham_fleet: '', stockroom: '', company: 'cust1', x_daas_ham_site: 'site1' }, ['tech', 'admin', 'contact']],
    ],
    alm_stockroom: [
        [{ sys_id: 'sr1', [TYPE]: 'central_depot', x_daas_ham_customer: '' }, ['tech']],
        [{ sys_id: 'sr9', [TYPE]: 'staging_centre', x_daas_ham_customer: '' }, []],
        [{ sys_id: 'sr9', [TYPE]: 'customer_site', x_daas_ham_customer: 'cust1' }, ['admin']],
        [{ sys_id: 'sr9', [TYPE]: '', x_daas_ham_customer: '' }, ['tech']],
        [{ sys_id: 'sr9', [TYPE]: 'it_storeroom', x_daas_ham_customer: 'cust9' }, ['tech']],
    ],
    alm_transfer_order: [
        [{ from_stockroom: 'sr9', to_stockroom: 'sr1', [`from_stockroom.${TYPE}`]: 'central_depot', [`to_stockroom.${TYPE}`]: 'staging_centre' }, ['tech']],
        [{ from_stockroom: 'sr1', to_stockroom: 'sr9', [`from_stockroom.${TYPE}`]: 'central_depot', [`to_stockroom.${TYPE}`]: '' }, ['tech']],
        // It touches a NaaS stockroom, and neither end is theirs.
        [{ from_stockroom: 'sr8', to_stockroom: 'sr9', [`from_stockroom.${TYPE}`]: 'it_storeroom', [`to_stockroom.${TYPE}`]: 'central_depot' }, []],
        [{ from_stockroom: 'sr8', to_stockroom: 'sr9', [`from_stockroom.${TYPE}`]: 'it_storeroom', [`to_stockroom.${TYPE}`]: '' }, ['tech']],
        [{ from_stockroom: '', to_stockroom: 'sr9', [`from_stockroom.${TYPE}`]: '', [`to_stockroom.${TYPE}`]: 'customer_site' }, []],
    ],
    x_daas_ham_staging_task: [
        [{ 'asset.stockroom': 'sr1' }, ['tech']],
        [{ 'asset.stockroom': 'sr9' }, []],
        [{ 'asset.stockroom': '' }, []],
    ],
    x_daas_ham_audit: AUDITS,
    x_daas_ham_audit_line: through('audit', AUDITS),
    x_daas_ham_order: CUSTOMER_SITE,
    x_daas_ham_order_line: through('order', CUSTOMER_SITE),
    x_daas_ham_return_order: CUSTOMER_SITE,
    x_daas_ham_shipment: CUSTOMER_SITE,
    x_daas_ham_attestation: CUSTOMER_SITE,
    x_daas_ham_agreement: CUSTOMER,
    x_daas_ham_subscription_line: CUSTOMER,
    x_daas_ham_catalog_entry: CUSTOMER,
    x_daas_ham_fee_event: CUSTOMER,
    x_daas_ham_return_order_line: through('return_order', CUSTOMER_SITE),
    x_daas_ham_shipment_event: through('shipment', CUSTOMER_SITE),
    x_daas_ham_attestation_item: through('attestation', CUSTOMER_SITE),
    // A Site template with no Customer is offered to every Customer.
    x_daas_ham_site_template: [
        [{ customer: 'cust1' }, ['tech', 'admin']],
        [{ customer: 'cust9' }, ['tech']],
        [{ customer: '' }, ['tech', 'admin']],
    ],
    x_daas_ham_site_template_item: [
        [{ 'site_template.customer': 'cust1' }, ['tech', 'admin']],
        [{ 'site_template.customer': 'cust9' }, ['tech']],
        [{ 'site_template.customer': '' }, ['tech', 'admin']],
    ],
}

function recordsLike(table: ScopedTable): Array<Record<string, string>> {
    const values: Record<string, Set<string>> = {}
    for (const [record] of SAMPLES[table]) {
        for (const [field, value] of Object.entries(record)) (values[field] ??= new Set()).add(value)
    }
    return records(Object.fromEntries(Object.entries(values).map(([field, options]) => [field, [...options]])))
}

const IDS: readonly ScopingIds[] = [
    READER_IDS,
    { customerId: 'cust1', stockroomIds: () => ['sr1', 'sr9'], siteIds: () => ['site1', 'site9'] },
    { customerId: '', stockroomIds: () => [], siteIds: () => [] },
    { customerId: 'cust1', stockroomIds: () => ['sr1'], siteIds: () => [] },
]

describe('every scoped table', () => {
    it.each(TABLES)('%s: the before-query filter keeps the sample records each narrowed reader may see, and no other', (table) => {
        for (const [record, seenBy] of SAMPLES[table]) {
            const kept = READERS.filter((reader) => matches(visibilityFilter(READER_SCOPE[reader], scopingOfTable(table), READER_IDS) ?? '', record))
            expect(kept, JSON.stringify(record)).toEqual(seenBy)
        }
    })

    it.each(TABLES)('%s: the row check passes the same sample records', (table) => {
        for (const [record, seenBy] of SAMPLES[table]) {
            const passed = READERS.filter((reader) => rowVisible(READER_SCOPE[reader], scopingOfTable(table), rowOf(record), READER_IDS))
            expect(passed, JSON.stringify(record)).toEqual(seenBy)
        }
    })

    it.each(TABLES)('%s: staff who see every Customer, and users with no NaaS role, are not narrowed', (table) => {
        for (const scope of ['everything', 'unscoped'] as const) {
            expect(visibilityFilter(scope, scopingOfTable(table), READER_IDS), scope).toBeNull()
            for (const [record] of SAMPLES[table]) expect(rowVisible(scope, scopingOfTable(table), rowOf(record), READER_IDS), scope).toBe(true)
        }
    })

    it.each(TABLES)('%s: the row check keeps exactly what the filter keeps, whatever the record and the reader', (table) => {
        const scoping = scopingOfTable(table)
        for (const scope of SCOPES) {
            for (const ids of IDS) {
                const filter = visibilityFilter(scope, scoping, ids) ?? ''
                for (const record of recordsLike(table)) {
                    expect(rowVisible(scope, scoping, rowOf(record), ids), `${scope} ${JSON.stringify(record)}`).toBe(matches(filter, record))
                }
            }
        }
    })
})

describe('a reader with no stockroom, Site or Customer', () => {
    const none: ScopingIds = { customerId: '', stockroomIds: () => [], siteIds: () => [] }
    const sees = (reader: Reader, table: ScopedTable) =>
        SAMPLES[table].filter(([record]) => matches(visibilityFilter(READER_SCOPE[reader], scopingOfTable(table), none) ?? '', record)).map(([record]) => record)

    it('is shown nothing of the tables the rules narrow them on', () => {
        for (const table of TABLES.filter((table) => !SHARED_TABLES.includes(table))) {
            const scoping = scopingOfTable(table)
            if (scoping.stockroom) expect(sees('tech', table), table).toEqual([])
            if (!scoping.sharedWithoutCustomer) expect(sees('admin', table), table).toEqual([])
            expect(sees('contact', table), table).toEqual([])
        }
    })

    it("is shown, as an inventory tech, the Provider IT's records of a shared table and no NaaS record", () => {
        expect(sees('tech', 'alm_hardware').map((record) => record.x_daas_ham_fleet)).toEqual(['false', ''])
        expect(sees('tech', 'alm_stockroom').map((record) => record[TYPE])).toEqual(['', 'it_storeroom'])
        for (const table of SHARED_TABLES) {
            expect(sees('admin', table), table).toEqual([])
            expect(sees('contact', table), table).toEqual([])
        }
    })

    it('is shown, as a Customer admin, the Site templates offered to every Customer', () => {
        expect(sees('admin', 'x_daas_ham_site_template')).toEqual([{ customer: '' }])
    })
})

describe('visibilityFilter on a table shared with the Provider IT', () => {
    const ids = IDS[1]

    it('is hardware, stockrooms and transfer orders, and no table of the app', () => {
        expect(SHARED_TABLES).toEqual(['alm_hardware', 'alm_stockroom', 'alm_transfer_order'])
    })

    it('keeps a Customer contact to their Customer (and Sites) on every record, fleet or not', () => {
        for (const scope of ['own_customer', 'own_sites'] as const) {
            for (const table of SHARED_TABLES) {
                const withoutNaas: TableScoping = { ...scopingOfTable(table), naas: undefined }
                expect(visibilityFilter(scope, scopingOfTable(table), ids), `${scope} ${table}`).toBe(visibilityFilter(scope, withoutNaas, ids))
            }
        }
        expect(visibilityFilter('own_sites', SCOPED_TABLES.alm_hardware, ids)).toBe('company=cust1^x_daas_ham_siteINsite1,site9')
    })

    it("narrows an inventory tech's fleet assets only: the Provider IT's hardware, flag false or blank, passes", () => {
        const withoutNaas: TableScoping = { ...SCOPED_TABLES.alm_hardware, naas: undefined }
        for (const scopeIds of IDS) {
            const filter = visibilityFilter('assigned_stockrooms', SCOPED_TABLES.alm_hardware, scopeIds) ?? ''
            const narrowed = visibilityFilter('assigned_stockrooms', withoutNaas, scopeIds) ?? ''
            for (const record of recordsLike('alm_hardware')) {
                const outside = record.x_daas_ham_fleet !== 'true'
                expect(matches(filter, record), JSON.stringify(record)).toBe(outside || matches(narrowed, record))
            }
        }
    })

    it("narrows an inventory tech's NaaS stockrooms only, and transfer orders touching one", () => {
        const types = ['', 'central_depot', 'staging_centre', 'customer_site', 'it_storeroom']
        const naas = (type: string) => matches(naasStockroomCondition(), { x_daas_ham_stockroom_type: type })
        for (const type of types) {
            expect(matches(outsideNaasStockroomCondition(), { x_daas_ham_stockroom_type: type }), type).toBe(!naas(type))
        }
        const filter = visibilityFilter('assigned_stockrooms', SCOPED_TABLES.alm_transfer_order, ids) ?? ''
        for (const record of recordsLike('alm_transfer_order')) {
            const touchesNaas = naas(record[`from_stockroom.${TYPE}`]) || naas(record[`to_stockroom.${TYPE}`])
            const mine = [record.from_stockroom, record.to_stockroom].some((stockroom) => ids.stockroomIds().includes(stockroom))
            expect(matches(filter, record), JSON.stringify(record)).toBe(!touchesNaas || mine)
        }
    })
})

describe('rowVisible', () => {
    const untouched: ScopingIds = {
        customerId: 'cust1',
        stockroomIds: () => expect.unreachable('stockrooms fetched'),
        siteIds: () => expect.unreachable('sites fetched'),
    }

    it('passes a record that is not a saved row (a New form, a check of the whole table), for every scope', () => {
        const unsaved: ScopedRow = { saved: false, valueOf: () => '' }
        for (const scope of SCOPES) {
            for (const table of TABLES) expect(rowVisible(scope, scopingOfTable(table), unsaved, untouched), `${scope} ${table}`).toBe(true)
        }
    })

    it('reads no fields and fetches no ids for staff who see everything or users left to the platform', () => {
        const unread: ScopedRow = { saved: true, valueOf: () => expect.unreachable('field read'), missing: () => expect.unreachable('record read') }
        for (const scope of ['everything', 'unscoped'] as const) expect(rowVisible(scope, SCOPED_TABLES.alm_hardware, unread, untouched)).toBe(true)
    })

    it("reads the Fleet flag as a GlideRecord gives it: '1' is a fleet asset, '0' the Provider IT's", () => {
        const hardware = (flag: string) => rowOf({ x_daas_ham_fleet: flag, stockroom: 'sr9' })
        expect(rowVisible('assigned_stockrooms', SCOPED_TABLES.alm_hardware, hardware('1'), READER_IDS)).toBe(false)
        expect(rowVisible('assigned_stockrooms', SCOPED_TABLES.alm_hardware, hardware('0'), READER_IDS)).toBe(true)
    })

    it('refuses a narrowed reader an Asset whose hardware record cannot be read: it is not taken for one outside the fleet', () => {
        const missing: ScopedRow = { saved: true, valueOf: () => '', missing: () => true }
        for (const reader of READERS) expect(rowVisible(READER_SCOPE[reader], SCOPED_TABLES.alm_hardware, missing, READER_IDS), reader).toBe(false)
        expect(rowVisible('everything', SCOPED_TABLES.alm_hardware, missing, READER_IDS)).toBe(true)
    })
})

describe('a table the app cannot place', () => {
    it('is one with no entry of its own that extends no table with one', () => {
        expect(scopingOf(['x_daas_ham_order'])).toBe(SCOPED_TABLES.x_daas_ham_order)
        expect(scopingOf(['u_rack_hardware', 'alm_hardware', 'alm_asset'])).toBe(SCOPED_TABLES.alm_hardware)
        expect(scopingOf(['alm_consumable', 'alm_asset'])).toBeNull()
        expect(scopingOf([])).toBeNull()
        expect(scopingOf(['constructor', 'toString'])).toBeNull()
    })

    it('shows a reader the rules narrow nothing, in the filter and in the row check, and narrows no one else', () => {
        const row = rowOf({ customer: 'cust1', site: 'site1', stockroom: 'sr1' })
        for (const reader of READERS) {
            expect(visibilityFilter(READER_SCOPE[reader], null, READER_IDS), reader).toBe('sys_id=-1')
            expect(rowVisible(READER_SCOPE[reader], null, row, READER_IDS), reader).toBe(false)
            expect(rowVisible(READER_SCOPE[reader], null, { saved: false, valueOf: () => '' }, READER_IDS), reader).toBe(true)
        }
        for (const scope of ['everything', 'unscoped'] as const) {
            expect(visibilityFilter(scope, null, READER_IDS), scope).toBeNull()
            expect(rowVisible(scope, null, row, READER_IDS), scope).toBe(true)
        }
        expect(grantsContactRecord('own_customer', null, row, READER_IDS)).toBe(false)
    })
})

describe('grantsNaasRecord', () => {
    const ids = READER_IDS
    const hardware = SCOPED_TABLES.alm_hardware

    it("grants a fleet asset the reader's scope keeps, and nothing outside the fleet, which the platform's ACLs decide", () => {
        for (const scope of SCOPES) {
            for (const record of recordsLike('alm_hardware')) {
                const expected = record.x_daas_ham_fleet === 'true' && rowVisible(scope, hardware, rowOf(record), ids)
                expect(grantsNaasRecord(scope, hardware, rowOf(record), ids), `${scope} ${JSON.stringify(record)}`).toBe(expected)
            }
        }
        expect(grantsNaasRecord('everything', hardware, rowOf({ x_daas_ham_fleet: 'true' }), ids)).toBe(true)
        expect(grantsNaasRecord('everything', hardware, rowOf({ x_daas_ham_fleet: 'false' }), ids)).toBe(false)
        expect(grantsNaasRecord('own_customer', hardware, rowOf({ x_daas_ham_fleet: 'true', company: 'cust9' }), ids)).toBe(false)
    })

    it('grants a record that is not a saved row, so the reader may open the list at all', () => {
        for (const scope of SCOPES) expect(grantsNaasRecord(scope, hardware, { saved: false, valueOf: () => '' }, ids)).toBe(true)
    })

    it('grants no one an Asset whose hardware record cannot be read, but staff who see everything', () => {
        const missing: ScopedRow = { saved: true, valueOf: () => '', missing: () => true }
        for (const reader of READERS) expect(grantsNaasRecord(READER_SCOPE[reader], hardware, missing, ids), reader).toBe(false)
        expect(grantsNaasRecord('everything', hardware, missing, ids)).toBe(true)
    })
})

describe('changes to hardware by hand', () => {
    const ids = IDS[0]
    const fleet = (values: Record<string, string> = {}) => rowOf({ x_daas_ham_fleet: 'true', ...values })
    const outside = rowOf({ x_daas_ham_fleet: 'false', stockroom: 'sr9', company: 'cust9' })
    const unsaved: ScopedRow = { saved: false, valueOf: () => '' }
    const holding = (...held: string[]) => (role: string) => held.includes(role)
    const untouched: ScopingIds = {
        customerId: 'cust1',
        stockroomIds: () => expect.unreachable('stockrooms fetched'),
        siteIds: () => expect.unreachable('sites fetched'),
    }
    const unread: ScopedRow = { saved: true, valueOf: () => expect.unreachable('field read'), missing: () => expect.unreachable('record read') }

    it('tell Customer contacts from staff and users the app does not scope', () => {
        expect(SCOPES.filter(isCustomerContact)).toEqual(['own_customer', 'own_sites'])
    })

    it('let an asset editor save a fleet asset their scope keeps: an inventory tech only in their stockrooms', () => {
        expect(EQUIPMENT_HANDLERS).toEqual([ROLE.assetManager, ROLE.inventoryTech, ROLE.fieldTech])
        expect(writesFleetAsset('everything', holding(ROLE.fieldTech), fleet({ stockroom: 'sr9' }), ids)).toBe(true)
        expect(writesFleetAsset('assigned_stockrooms', holding(ROLE.inventoryTech), fleet({ stockroom: 'sr1' }), ids)).toBe(true)
        expect(writesFleetAsset('assigned_stockrooms', holding(ROLE.inventoryTech), fleet({ stockroom: 'sr9' }), ids)).toBe(false)
        expect(writesFleetAsset('assigned_stockrooms', holding(ROLE.inventoryTech), fleet(), ids)).toBe(false)
    })

    it('refuse a fleet asset to Customer contacts and to NaaS roles that run no assets', () => {
        for (const role of [ROLE.noc, ROLE.accountManager, ROLE.finance]) expect(writesFleetAsset('everything', holding(role), fleet(), ids), role).toBe(false)
        const contact = fleet({ company: 'cust1', x_daas_ham_site: 'site1' })
        expect(writesFleetAsset('own_customer', holding(ROLE.customerAdmin, ROLE.assetManager), contact, ids)).toBe(false)
        expect(writesFleetAsset('own_sites', holding(ROLE.siteContact), contact, ids)).toBe(false)
    })

    it("leave hardware outside the fleet, a record not yet saved and users with no NaaS role to the platform", () => {
        for (const scope of SCOPES) {
            expect(writesFleetAsset(scope, holding(), outside, ids), scope).toBe(true)
            expect(writesFleetAsset(scope, holding(), unsaved, untouched), scope).toBe(true)
        }
        expect(writesFleetAsset('unscoped', holding(), unread, untouched)).toBe(true)
    })

    it('let only an app administrator delete a fleet asset, which leaves by disposal', () => {
        expect(deletesFleetAsset(holding(ROLE.admin), fleet())).toBe(true)
        expect(deletesFleetAsset(holding(ROLE.admin), unread)).toBe(true)
        for (const role of [ROLE.assetManager, ROLE.inventoryTech, ROLE.fieldTech, 'asset']) expect(deletesFleetAsset(holding(role), fleet()), role).toBe(false)
        expect(deletesFleetAsset(holding('asset'), outside)).toBe(true)
        expect(deletesFleetAsset(holding(), unsaved)).toBe(true)
    })

    it("keep a fleet asset's company and cost to asset managers, and leave other hardware's to the platform", () => {
        expect(writesFleetCommercialField(holding(ROLE.assetManager), fleet())).toBe(true)
        expect(writesFleetCommercialField(holding(ROLE.assetManager), unread)).toBe(true)
        for (const role of [ROLE.inventoryTech, ROLE.fieldTech, ROLE.finance, 'asset']) {
            expect(writesFleetCommercialField(holding(role), fleet()), role).toBe(false)
        }
        expect(writesFleetCommercialField(holding('asset'), outside)).toBe(true)
        expect(writesFleetCommercialField(holding(), unsaved)).toBe(true)
    })

    it("keep a fleet asset's cost from Customer contacts, and read nothing for anyone else", () => {
        for (const scope of ['own_customer', 'own_sites'] as const) {
            expect(readsFleetProviderField(scope, fleet({ company: 'cust1' })), scope).toBe(false)
            expect(readsFleetProviderField(scope, outside), scope).toBe(true)
            expect(readsFleetProviderField(scope, unsaved), scope).toBe(true)
        }
        for (const scope of ['everything', 'assigned_stockrooms', 'unscoped'] as const) expect(readsFleetProviderField(scope, unread), scope).toBe(true)
    })
})

describe("the Customer contacts' read ACLs", () => {
    it('grant by the customer admin role alone: a Customer admin their Customer, any other contact their Sites', () => {
        expect(contactScope(roles('x_daas_ham.customer_admin'))).toBe('own_customer')
        expect(contactScope(roles('x_daas_ham.site_contact', 'x_daas_ham.customer_admin'))).toBe('own_customer')
        expect(contactScope(roles('x_daas_ham.site_contact'))).toBe('own_sites')
        // A staff role widens nothing here: staff read through their own ACLs.
        expect(contactScope(roles('x_daas_ham.site_contact', 'x_daas_ham.noc'))).toBe('own_sites')
        expect(contactScope(roles('x_daas_ham.customer_admin', 'x_daas_ham.inventory_tech'))).toBe('own_customer')
    })

    it.each(TABLES)('%s: grant a contact the sample records their before-query filter keeps', (table) => {
        for (const [record, seenBy] of SAMPLES[table]) {
            for (const contact of ['admin', 'contact'] as const) {
                const scope = contactScope(roles(contact === 'admin' ? 'x_daas_ham.customer_admin' : 'x_daas_ham.site_contact'))
                expect(grantsContactRecord(scope, scopingOfTable(table), rowOf(record), READER_IDS), `${contact} ${JSON.stringify(record)}`).toBe(seenBy.includes(contact))
            }
        }
    })

    it("judge a record that is not a saved row by its values: a blank one is no Customer's, a Site template for all excepted", () => {
        const blank: ScopedRow = { saved: false, valueOf: () => '' }
        const filled: ScopedRow = { saved: false, valueOf: (field) => (field === 'customer' ? 'cust1' : '') }
        expect(grantsContactRecord('own_customer', SCOPED_TABLES.x_daas_ham_order, blank, READER_IDS)).toBe(false)
        expect(grantsContactRecord('own_customer', SCOPED_TABLES.x_daas_ham_order, filled, READER_IDS)).toBe(true)
        expect(grantsContactRecord('own_customer', SCOPED_TABLES.x_daas_ham_site_template, blank, READER_IDS)).toBe(true)
    })

    it('grant a contact whose user has no Company nothing but a Site template for all', () => {
        const none: ScopingIds = { customerId: '', stockroomIds: () => [], siteIds: () => ['site1'] }
        for (const table of TABLES) {
            const granted = SAMPLES[table].filter(([record]) => grantsContactRecord('own_customer', scopingOfTable(table), rowOf(record), none))
            expect(granted.length, table).toBe(scopingOfTable(table).sharedWithoutCustomer ? 1 : 0)
            for (const [record] of SAMPLES[table]) expect(grantsContactRecord('own_sites', scopingOfTable(table), rowOf(record), none), table).toBe(false)
        }
    })
})

describe("the customer admins' create ACL on Returns", () => {
    it('grants a Return of their own Customer, or one that names none yet, and nothing to a user with no Customer', () => {
        expect(grantsReturnOfOwnCustomer('cust1', 'cust1')).toBe(true)
        expect(grantsReturnOfOwnCustomer('cust1', '')).toBe(true)
        expect(grantsReturnOfOwnCustomer('cust1', 'cust9')).toBe(false)
        expect(grantsReturnOfOwnCustomer('', '')).toBe(false)
        expect(grantsReturnOfOwnCustomer('', 'cust1')).toBe(false)
    })
})
