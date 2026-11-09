import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
    actsAsCustomerAdmin,
    INVENTORY_TECH_TABLES,
    resolveVisibility,
    STOCKROOM_SCOPED_TABLES,
    visibilityFilter,
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

describe('read ACLs for inventory techs', () => {
    const SECURITY = new URL('../../fluent/security/', import.meta.url)
    const source = (file: string) => readFileSync(new URL(file, SECURITY), 'utf8')
    const roles = source('roles.now.ts')
    const items = (list: string) => list.split(',').map((item) => item.trim().replace(/"/g, "'")).filter(Boolean)
    const namedLists = (text: string) => new Map([...text.matchAll(/const (\w+) = \[([^\]]*)\]/g)].map((m) => [m[1], items(m[2])]))
    /** What an inventory tech with no other role holds: the role itself and the roles it contains. */
    const heldByTech = new Set(['inventoryTech', "'x_daas_ham.inventory_tech'", ...items(/inventoryTech = Role\(\{[\s\S]*?containsRoles: \[([^\]]*)\]/.exec(roles)?.[1] ?? '')])

    /** Every read ACL of the app as its table and the roles it grants, with named role lists expanded. */
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
                .filter((acl) => acl.includes("operation: 'read'"))
                .map((acl) => {
                    const granted = /roles: (\[[^\]]*\]|\w+)/.exec(acl)?.[1] ?? ''
                    const tokens = granted.startsWith('[') ? items(granted.slice(1, -1)) : [granted]
                    return { table: /table: '([^']+)'/.exec(acl)?.[1] ?? '', roles: tokens.flatMap(expand) }
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
    /** The scoping fields each before-query entry point passes, by function name. */
    const fieldsOf = new Map([...entrySource.matchAll(/export function (\w+)\(current: GlideRecord\): void \{\s*restrict\(current, (\{[^}]*\})\)/g)].map((m) => [m[1], m[2]]))
    const rules = rulesSource
        .split('BusinessRule({')
        .slice(1)
        .map((rule) => ({ table: /table: '([^']+)'/.exec(rule)?.[1] ?? '', fields: fieldsOf.get(/script: (\w+)/.exec(rule)?.[1] ?? '') ?? '' }))

    it('narrow an inventory tech to their stockrooms on exactly the stock, transfer order, staging and audit tables', () => {
        expect(rules.filter((rule) => !rule.fields)).toEqual([])
        const narrowed = rules.filter((rule) => rule.fields.includes('stockroom:')).map((rule) => rule.table)
        expect(narrowed.sort()).toEqual([...STOCKROOM_SCOPED_TABLES].sort())
    })
})
