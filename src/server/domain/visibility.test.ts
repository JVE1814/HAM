import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { fleetCondition, naasStockroomCondition } from './fleet'
import { DEPLOYED_STAGES } from './lifecycle'
import {
    actsAsCustomerAdmin,
    customerEquipmentQuery,
    grantsNaasRecord,
    INVENTORY_TECH_TABLES,
    OUTSIDE_NAAS,
    outsideNaasStockroomCondition,
    resolveVisibility,
    rowVisible,
    SCOPE,
    STOCKROOM_SCOPED_TABLES,
    visibilityFilter,
    type ScopedRecords,
    type ScopedRow,
    type ScopingFields,
    type ScopingIds,
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
        expect(actsAsCustomerAdmin(roles('x_daas_ham.customer_admin'))).toBe(true)
        expect(actsAsCustomerAdmin(roles('x_daas_ham.site_contact', 'x_daas_ham.customer_admin'))).toBe(true)
    })

    it('leaves them out for site contacts and for staff who see every customer, even holding the role', () => {
        expect(actsAsCustomerAdmin(roles('x_daas_ham.site_contact'))).toBe(false)
        expect(actsAsCustomerAdmin(roles('x_daas_ham.asset_manager'))).toBe(false)
        expect(actsAsCustomerAdmin(roles('x_daas_ham.asset_manager', 'x_daas_ham.customer_admin'))).toBe(false)
        expect(actsAsCustomerAdmin(() => true)).toBe(false) // a platform admin holds every role
    })
})

describe('customerEquipmentQuery', () => {
    const clauses = customerEquipmentQuery().split('^NQ')

    it('lists every deployed stage, from shipped to awaiting return', () => {
        expect(clauses).toHaveLength(DEPLOYED_STAGES.length)
        expect(clauses[0]).toContain('install_status=9^substatus=shipped_to_site')
        expect(clauses.at(-1)).toContain('install_status=1^substatus=pending_return')
    })

    it("keeps only fleet assets in each stage: the Provider IT's hardware in use, such as laptops, is left out", () => {
        for (const clause of clauses) expect(clause).toMatch(new RegExp(`\\^${fleetCondition()}$`))
    })

    it('keeps a deployed fleet unit that has lost its Agreement (a data gap) on its Customer\'s page', () => {
        expect(customerEquipmentQuery()).not.toContain('x_daas_ham_agreement')
    })

    it("puts the reader's filter in every stage's clause, which a before-query rule's filter would not reach", () => {
        const scoped = customerEquipmentQuery('company=cust1^x_daas_ham_siteINsite1').split('^NQ')
        expect(scoped).toHaveLength(DEPLOYED_STAGES.length)
        for (const clause of scoped) expect(clause).toContain('^company=cust1^x_daas_ham_siteINsite1')
        expect(customerEquipmentQuery(null)).toBe(customerEquipmentQuery())
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

    it('filters by the scoping field for each restricted scope', () => {
        expect(visibilityFilter('assigned_stockrooms', assetFields, ids)).toBe('stockroomINsr1,sr2')
        expect(visibilityFilter('own_customer', assetFields, ids)).toBe('company=cust1')
        expect(visibilityFilter('own_sites', assetFields, ids)).toBe('company=cust1^x_daas_ham_siteINsite1')
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

    it('leaves inventory techs unfiltered on tables without a stockroom (read ACLs close the ones they may not read)', () => {
        expect(visibilityFilter('assigned_stockrooms', { customer: 'customer' }, ids)).toBeNull()
    })

    it('hides tables without a customer field from external users', () => {
        expect(visibilityFilter('own_customer', { stockroom: 'stockroom' }, ids)).toBe('sys_id=-1')
        expect(visibilityFilter('own_sites', { customer: 'customer' }, ids)).toBe('sys_id=-1')
        expect(visibilityFilter('own_sites', { site: 'site' }, ids)).toBe('sys_id=-1')
    })

    it('supports an either-or stockroom filter for transfers between stockrooms', () => {
        expect(visibilityFilter('assigned_stockrooms', { stockroom: ['from_stockroom', 'to_stockroom'] }, ids)).toBe(
            'from_stockroomINsr1,sr2^ORto_stockroomINsr1,sr2',
        )
    })
})

/**
 * Whether a record (its field values, '' for blank) matches an encoded query of the forms visibilityFilter builds:
 * conditions joined by ^ (AND) and ^OR (OR, which binds tighter). A blank value matches neither IN nor NOT IN, as in
 * SQL, so a condition that should take in a blank one must say ISEMPTY.
 */
function matches(query: string, record: Record<string, string>): boolean {
    if (!query) return true
    const groups: string[][] = []
    for (const token of query.split('^')) {
        if (token.startsWith('OR') && groups.length > 0) groups[groups.length - 1].push(token.slice(2))
        else groups.push([token])
    }
    const holds = (condition: string): boolean => {
        const [, field, operator, operand] = /^([\w.]+?)(NOT IN|IN|ISEMPTY|=)(.*)$/.exec(condition) ?? []
        if (!field) throw new Error(`unparsed condition ${condition}`)
        const value = record[field] ?? ''
        if (operator === 'ISEMPTY') return value === ''
        if (value === '') return false
        if (operator === 'IN') return operand.split(',').includes(value)
        if (operator === 'NOT IN') return !operand.split(',').includes(value)
        return value === operand
    }
    return groups.every((group) => group.some(holds))
}

/** Every combination of `values` for `fields`, as records. */
function records(values: Record<string, readonly string[]>): Array<Record<string, string>> {
    return Object.entries(values).reduce<Array<Record<string, string>>>(
        (found, [field, options]) => found.flatMap((record) => options.map((value) => ({ ...record, [field]: value }))),
        [{}],
    )
}

const SCOPES: readonly VisibilityScope[] = ['everything', 'unscoped', 'assigned_stockrooms', 'own_customer', 'own_sites']
const IDS: readonly ScopingIds[] = [
    { customerId: 'cust1', stockroomIds: () => ['sr1', 'sr2'], siteIds: () => ['site1'] },
    { customerId: '', stockroomIds: () => [], siteIds: () => [] },
    { customerId: 'cust1', stockroomIds: () => ['sr1'], siteIds: () => [] },
]
const ASSET_VALUES = {
    stockroom: ['', 'sr1', 'sr9'],
    company: ['', 'cust1', 'cust9'],
    x_daas_ham_site: ['', 'site1', 'site9'],
    x_daas_ham_fleet: ['', 'false', 'true'],
}
const TRANSFER_VALUES = {
    from_stockroom: ['', 'sr1', 'sr9'],
    to_stockroom: ['sr2', 'sr9'],
    'from_stockroom.x_daas_ham_stockroom_type': ['', 'central_depot', 'it_storeroom'],
    'to_stockroom.x_daas_ham_stockroom_type': ['', 'staging_centre', 'it_storeroom'],
}

describe('visibilityFilter on a table shared with the Provider IT', () => {
    const ids = IDS[0]

    it("ORs into each of an inventory tech's conditions the records it leaves to the platform", () => {
        expect(visibilityFilter('assigned_stockrooms', SCOPE.assets, ids, OUTSIDE_NAAS.assets)).toBe(
            'x_daas_ham_fleet=false^ORx_daas_ham_fleetISEMPTY^ORstockroomINsr1,sr2',
        )
        expect(visibilityFilter('everything', SCOPE.assets, ids, OUTSIDE_NAAS.assets)).toBeNull()
    })

    it('keeps a Customer contact to their Customer (and Sites) on every record, fleet or not', () => {
        for (const scope of ['own_customer', 'own_sites'] as const) {
            for (const [records, outside] of Object.entries(OUTSIDE_NAAS) as Array<[ScopedRecords, readonly string[]]>) {
                expect(visibilityFilter(scope, SCOPE[records], ids, outside), `${scope} ${records}`).toBe(visibilityFilter(scope, SCOPE[records], ids))
            }
        }
        expect(visibilityFilter('own_sites', SCOPE.assets, ids, OUTSIDE_NAAS.assets)).toBe('company=cust1^x_daas_ham_siteINsite1')
    })

    it("narrows an inventory tech's fleet assets only: the Provider IT's hardware, flag false or blank, passes", () => {
        for (const scopeIds of IDS) {
            const filter = visibilityFilter('assigned_stockrooms', SCOPE.assets, scopeIds, OUTSIDE_NAAS.assets) ?? ''
            const narrowed = visibilityFilter('assigned_stockrooms', SCOPE.assets, scopeIds) ?? ''
            for (const record of records(ASSET_VALUES)) {
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
        const filter = visibilityFilter('assigned_stockrooms', SCOPE.transferOrders, ids, OUTSIDE_NAAS.transferOrders) ?? ''
        for (const record of records(TRANSFER_VALUES)) {
            const touchesNaas =
                naas(record['from_stockroom.x_daas_ham_stockroom_type']) || naas(record['to_stockroom.x_daas_ham_stockroom_type'])
            const mine = [record.from_stockroom, record.to_stockroom].some((stockroom) => ids.stockroomIds().includes(stockroom))
            expect(matches(filter, record), JSON.stringify(record)).toBe(!touchesNaas || mine)
        }
    })
})

/** A saved row of `record`'s values, outside NaaS when it matches every one of `outside` (OUTSIDE_NAAS). */
function rowOf(record: Record<string, string>, outside?: readonly string[]): ScopedRow {
    return {
        saved: true,
        valueOf: (field) => record[field] ?? '',
        outsideNaas: outside ? () => outside.every((condition) => matches(condition, record)) : undefined,
    }
}

describe('rowVisible', () => {
    const tables: Array<[ScopedRecords, Record<string, readonly string[]>]> = [
        ['assets', ASSET_VALUES],
        ['stockrooms', { sys_id: ['sr1', 'sr9'], x_daas_ham_customer: ['', 'cust1', 'cust9'], x_daas_ham_stockroom_type: ['', 'central_depot', 'it_storeroom'] }],
        ['transferOrders', TRANSFER_VALUES],
        ['stagingTasks', { 'asset.stockroom': ['', 'sr1', 'sr9'] }],
        ['auditLines', { 'audit.stockroom': ['', 'sr2', 'sr9'], 'audit.customer': ['', 'cust1'], 'audit.site': ['', 'site1', 'site9'] }],
        ['customerRecords', { customer: ['', 'cust1', 'cust9'] }],
        ['customerSiteRecords', { customer: ['', 'cust1', 'cust9'], site: ['', 'site1', 'site9'] }],
    ]

    it("keeps exactly the records the table's before-query filter keeps, for every scope and table", () => {
        for (const [table, values] of tables) {
            const fields: ScopingFields = SCOPE[table]
            const outside = OUTSIDE_NAAS[table]
            for (const scope of SCOPES) {
                for (const ids of IDS) {
                    const filter = visibilityFilter(scope, fields, ids, outside) ?? ''
                    for (const record of records(values)) {
                        const visible = rowVisible(scope, fields, rowOf(record, outside), ids)
                        expect(visible, `${table} ${scope} ${JSON.stringify(record)}`).toBe(matches(filter, record))
                    }
                }
            }
        }
    })

    it('passes a record that is not a saved row (a New form, a check of the whole table), for every scope', () => {
        const untouched: ScopingIds = {
            customerId: 'cust1',
            stockroomIds: () => expect.unreachable('stockrooms fetched'),
            siteIds: () => expect.unreachable('sites fetched'),
        }
        const unsaved: ScopedRow = { saved: false, valueOf: () => '' }
        for (const scope of SCOPES) {
            for (const [table] of tables) expect(rowVisible(scope, SCOPE[table], unsaved, untouched), `${scope} ${table}`).toBe(true)
        }
    })

    it('reads no fields and fetches no ids for staff who see everything or users left to the platform', () => {
        const untouched: ScopingIds = {
            customerId: 'cust1',
            stockroomIds: () => expect.unreachable('stockrooms fetched'),
            siteIds: () => expect.unreachable('sites fetched'),
        }
        const unread: ScopedRow = { saved: true, valueOf: () => expect.unreachable('field read'), outsideNaas: () => expect.unreachable('flag read') }
        for (const scope of ['everything', 'unscoped'] as const) expect(rowVisible(scope, SCOPE.assets, unread, untouched)).toBe(true)
    })

    it("refuses an inventory tech a record of another stockroom, or of none, and a site contact another Customer's Site", () => {
        const ids = IDS[0]
        const fleet = (values: Record<string, string>) => rowOf({ x_daas_ham_fleet: 'true', ...values }, OUTSIDE_NAAS.assets)
        expect(rowVisible('assigned_stockrooms', SCOPE.assets, fleet({ stockroom: 'sr2' }), ids)).toBe(true)
        expect(rowVisible('assigned_stockrooms', SCOPE.assets, fleet({ stockroom: 'sr9' }), ids)).toBe(false)
        expect(rowVisible('assigned_stockrooms', SCOPE.audits, rowOf({ site: 'site1' }), ids)).toBe(false)
        expect(rowVisible('own_sites', SCOPE.assets, fleet({ company: 'cust9', x_daas_ham_site: 'site1' }), ids)).toBe(false)
    })

    it("passes an inventory tech the Provider IT's hardware, but keeps a Customer contact from another company's", () => {
        const ids = IDS[0]
        const it = rowOf({ x_daas_ham_fleet: 'false', stockroom: 'sr9', company: 'cust9' }, OUTSIDE_NAAS.assets)
        expect(rowVisible('assigned_stockrooms', SCOPE.assets, it, ids)).toBe(true)
        expect(rowVisible('own_customer', SCOPE.assets, it, ids)).toBe(false)
        expect(rowVisible('own_sites', SCOPE.assets, it, ids)).toBe(false)
    })
})

describe('grantsNaasRecord', () => {
    const ids = IDS[0]
    const asset = (values: Record<string, string>) => rowOf(values, OUTSIDE_NAAS.assets)

    it("grants a fleet asset the reader's scope keeps, and nothing outside the fleet, which the platform's ACLs decide", () => {
        for (const scope of SCOPES) {
            for (const record of records(ASSET_VALUES)) {
                const expected = record.x_daas_ham_fleet === 'true' && rowVisible(scope, SCOPE.assets, asset(record), ids)
                expect(grantsNaasRecord(scope, SCOPE.assets, asset(record), ids), `${scope} ${JSON.stringify(record)}`).toBe(expected)
            }
        }
        expect(grantsNaasRecord('everything', SCOPE.assets, asset({ x_daas_ham_fleet: 'true' }), ids)).toBe(true)
        expect(grantsNaasRecord('everything', SCOPE.assets, asset({ x_daas_ham_fleet: 'false' }), ids)).toBe(false)
        expect(grantsNaasRecord('own_customer', SCOPE.assets, asset({ x_daas_ham_fleet: 'true', company: 'cust9' }), ids)).toBe(false)
    })

    it('grants a record that is not a saved row, so the reader may open the list at all', () => {
        for (const scope of SCOPES) expect(grantsNaasRecord(scope, SCOPE.assets, { saved: false, valueOf: () => '' }, ids)).toBe(true)
    })
})

describe('read ACLs for inventory techs', () => {
    const SECURITY = new URL('../../fluent/security/', import.meta.url)
    const source = (file: string) => readFileSync(new URL(file, SECURITY), 'utf8')
    const roles = source('roles.now.ts')
    const items = (list: string) => list.split(',').map((item) => item.trim().replace(/"/g, "'")).filter(Boolean)
    const namedLists = (text: string) => new Map([...text.matchAll(/const (\w+) = \[([^\]]*)\]/g)].map((m) => [m[1], items(m[2])]))
    /** What an inventory tech with no other role holds: the role itself and the roles it contains. */
    const heldByTech = new Set(['inventoryTech', "'x_daas_ham.inventory_tech'", ...items(/inventoryTech = Role\(\{[\s\S]*?containsRoles: \[([^\]]*)\]/.exec(roles)?.[1] ?? '')])

    /**
     * The table whose records an ACL is for: its own, or for one on a parent table applying to one class only (hardware's
     * read ACLs, on alm_asset, ADR 0005) that class.
     */
    const recordsOf = (acl: string) =>
        /appliesTo: 'sys_class_name=(\w+)'/.exec(acl)?.[1] ?? /table: '([^']+)'/.exec(acl)?.[1] ?? ''
    /** Every read ACL of the app as the table of its records and the roles it grants, with named role lists expanded. */
    const readAcls = readdirSync(SECURITY)
        .filter((file) => /^acls.*\.now\.ts$/.test(file))
        .flatMap((file) => {
            const text = source(file)
            const lists = new Map([...namedLists(roles), ...namedLists(text)])
            const expand = (token: string): string[] => {
                const name = token.replace(/^\.\.\./, '')
                return lists.has(name) ? (lists.get(name) ?? []).flatMap(expand) : [token]
            }
            return text
                .split('Acl({')
                .slice(1)
                // A Deny-Unless ACL (the row checks) grants nothing: it only takes access away.
                .filter((acl) => acl.includes("operation: 'read'") && !acl.includes("decisionType: 'deny'"))
                .map((acl) => {
                    const granted = /roles: (\[[^\]]*\]|\w+)/.exec(acl)?.[1] ?? ''
                    const tokens = granted.startsWith('[') ? items(granted.slice(1, -1)) : [granted]
                    return { table: recordsOf(acl), roles: tokens.flatMap(expand) }
                })
        })
    const readableByTech = [...new Set(readAcls.filter((acl) => acl.roles.some((role) => heldByTech.has(role))).map((acl) => acl.table))]
    const closedToTech = [...new Set(readAcls.map((acl) => acl.table))].filter((table) => !readableByTech.includes(table))

    it('let an inventory tech read exactly the tables of their stockroom work', () => {
        expect(heldByTech).toContain("'inventory_user'")
        expect(readableByTech.sort()).toEqual([...INVENTORY_TECH_TABLES].sort())
    })

    it('close customer, commercial and configuration tables to an inventory tech with no broader role', () => {
        expect(closedToTech).toEqual(
            expect.arrayContaining([
                'x_daas_ham_agreement',
                'x_daas_ham_subscription_line',
                'x_daas_ham_catalog_entry',
                'x_daas_ham_site_template',
                'x_daas_ham_fee_event',
                'x_daas_ham_attestation',
                'x_daas_ham_lease_schedule',
                'x_daas_ham_cloud_account',
                'x_daas_ham_model_lifecycle',
            ]),
        )
    })
})

describe('before-query rules for inventory techs', () => {
    const rulesSource = readFileSync(new URL('../../fluent/security/visibility.now.ts', import.meta.url), 'utf8')
    const entrySource = readFileSync(new URL('../entry/visibility.ts', import.meta.url), 'utf8')
    /** The SCOPE each before-query entry point restricts by, by function name. */
    const scopeOf = new Map(
        [...entrySource.matchAll(/export function (\w+)\(current: GlideRecord\): void \{\s*restrict\(current, '(\w+)'\)/g)].map((m) => [m[1], m[2]]),
    )
    const rules = rulesSource
        .split('BusinessRule({')
        .slice(1)
        .map((rule) => ({ table: /table: '([^']+)'/.exec(rule)?.[1] ?? '', scope: scopeOf.get(/script: (\w+)/.exec(rule)?.[1] ?? '') as ScopedRecords }))

    it('narrow an inventory tech to their stockrooms on exactly the stock, transfer order, staging and audit tables', () => {
        expect(rules.filter((rule) => !rule.scope || !SCOPE[rule.scope])).toEqual([])
        const narrowed = rules.filter((rule) => SCOPE[rule.scope].stockroom).map((rule) => rule.table)
        expect(narrowed.sort()).toEqual([...STOCKROOM_SCOPED_TABLES].sort())
    })

    it("leave the Provider IT's hardware and stockrooms, and transfer orders between them, to the platform", () => {
        const shared = rules.filter((rule) => OUTSIDE_NAAS[rule.scope]).map((rule) => rule.table)
        expect(shared.sort()).toEqual(['alm_hardware', 'alm_stockroom', 'alm_transfer_order'])
    })
})
