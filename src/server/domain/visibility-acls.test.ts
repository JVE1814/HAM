import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ASSET_EDITOR_ROLES, SCOPE, STOCKROOM_SCOPED_TABLES, type ScopedRecords } from './visibility'

/*
 * The before-query rules (ADR 0005) narrow lists, but a record reached another way (a dot-walk from a visible record,
 * an `^NQ` clause the rule's filter does not reach, or a table with no rule) is guarded only by its read ACL. So every
 * read ACL a site contact passes re-checks the Site, on the same field as the table's before-query rule, and on the
 * tables the rules narrow to an inventory tech's stockrooms a Deny-Unless ACL re-checks the stockroom. Hardware's read
 * ACLs sit on alm_asset, its parent, applying to hardware only.
 */

const SECURITY = new URL('../../fluent/security/', import.meta.url)
const source = (file: string) => readFileSync(new URL(file, SECURITY), 'utf8')
const entrySource = readFileSync(new URL('../entry/visibility.ts', import.meta.url), 'utf8')

/** The class an ACL on a parent table applies to alone (Applies To `sys_class_name=<class>`), if any. */
const appliedClass = (acl: string) => /appliesTo: 'sys_class_name=(\w+)'/.exec(acl)?.[1]

/** Every ACL of the app's security files, as the fields these tests read; `records` is the table of its records. */
const acls = readdirSync(SECURITY)
    .filter((file) => /^acls.*\.now\.ts$/.test(file))
    .flatMap((file) => source(file).split('Acl({').slice(1))
    .map((acl) => ({
        table: /table: '([^']+)'/.exec(acl)?.[1] ?? '',
        records: appliedClass(acl) ?? /table: '([^']+)'/.exec(acl)?.[1] ?? '',
        /** The field a field-level ACL secures; '' for a record ACL. */
        field: /field: '([^']+)'/.exec(acl)?.[1] ?? '',
        operation: /operation: '([^']+)'/.exec(acl)?.[1] ?? '',
        deny: acl.includes("decisionType: 'deny'"),
        roles: /roles: (\[[^\]]*\]|\w+)/.exec(acl)?.[1] ?? '',
        appliesTo: /appliesTo:\s*'([^']*)'/.exec(acl)?.[1] ?? '',
        condition: /condition:\s*'([^']*)'/.exec(acl)?.[1] ?? '',
        script: /script: (\w+)/.exec(acl)?.[1] ?? '',
        /** An inline script's text; '' for none or a module function. */
        inlineScript: /script: "([^"]*)"/.exec(acl)?.[1] ?? '',
    }))
const recordAcls = acls.filter((acl) => !acl.field)

/** The SCOPE each before-query rule's entry point restricts by, by the rule's table. */
const ruleScope = (() => {
    const scopeOf = new Map(
        [...entrySource.matchAll(/export function (\w+)\(current: GlideRecord\): void \{\s*restrict\(current, '(\w+)'\)/g)].map((m) => [m[1], m[2]]),
    )
    return new Map(
        source('visibility.now.ts')
            .split('BusinessRule({')
            .slice(1)
            .map((rule): [string, ScopedRecords] => [
                /table: '([^']+)'/.exec(rule)?.[1] ?? '',
                scopeOf.get(/script: (\w+)/.exec(rule)?.[1] ?? '') as ScopedRecords,
            ]),
    )
})()

/**
 * Every read ACL a site contact passes (customerRoles holds the site contact role), as the table of its records and
 * its script: inline, or (`entryPoint`) an entry/visibility function.
 */
const siteContactReads = readdirSync(SECURITY)
    .filter((file) => /^acls.*\.now\.ts$/.test(file))
    .flatMap((file) => source(file).split('Acl({').slice(1))
    .filter((acl) => acl.includes("operation: 'read'") && /roles: (customerRoles\b|\[[^\]]*\bsiteContact\b)/.test(acl))
    .map((acl) => ({
        table: appliedClass(acl) ?? /table: '([^']+)'/.exec(acl)?.[1] ?? '',
        script: /script: "([^"]*)"/.exec(acl)?.[1] ?? '',
        entryPoint: /script: (\w+)/.exec(acl)?.[1],
    }))

/** The SCOPE an entry/visibility row check or grant reads, from its body. */
const checkedScope = (name: string) =>
    new RegExp(`export function ${name}\\(current: GlideRecord\\): boolean \\{[^}]*?(?:readable\\(current, '(\\w+)'|SCOPE\\.(\\w+))`)
        .exec(entrySource)
        ?.slice(1)
        .find(Boolean)

/** The Site field each before-query rule filters a site contact on, by table; null for a rule with none. */
const ruleSiteField = new Map([...ruleScope].map(([table, scope]): [string, string | null] => [table, SCOPE[scope]?.site ?? null]))

/** The record path whose Site contacts the script checks, unless the reader is a customer admin. */
const SITE_CHECK = /\(gs\.hasRole\('x_daas_ham\.customer_admin'\) \|\| \(',' \+ current\.([\w.]+)\.x_daas_ham_site_contacts \+ ','\)\.indexOf\(',' \+ gs\.getUserID\(\) \+ ','\) > -1\)/

describe('read ACLs for site contacts', () => {
    it('cover the tables a site contact reads', () => {
        expect(siteContactReads.map((acl) => acl.table).sort()).toEqual(
            expect.arrayContaining(['alm_hardware', 'x_daas_ham_order', 'x_daas_ham_order_line', 'x_daas_ham_return_order', 'x_daas_ham_shipment']),
        )
    })

    it("check the Customer and that the record's Site lists the site contact", () => {
        for (const acl of siteContactReads.filter((acl) => !acl.entryPoint)) {
            expect(acl.script, acl.table).toContain('== gs.getUser().getCompanyID() && ')
            expect(acl.script, acl.table).toMatch(SITE_CHECK)
        }
    })

    it("check the same Site as the table's before-query rule", () => {
        for (const acl of siteContactReads.filter((acl) => ruleSiteField.has(acl.table))) {
            if (acl.entryPoint) expect(SCOPE[checkedScope(acl.entryPoint) as ScopedRecords]?.site, acl.table).toBe(ruleSiteField.get(acl.table))
            else expect(SITE_CHECK.exec(acl.script)?.[1], acl.table).toBe(ruleSiteField.get(acl.table))
        }
    })

    it("check a record with an entry point only through the table's rule's own SCOPE", () => {
        const viaEntryPoint = siteContactReads.filter((acl) => acl.entryPoint)
        expect(viaEntryPoint.map((acl) => acl.table)).toContain('alm_hardware')
        for (const acl of viaEntryPoint) expect(checkedScope(acl.entryPoint ?? ''), acl.table).toBe(ruleScope.get(acl.table))
    })

    it('grant no table whose before-query rule has no Site field (it shows site contacts nothing)', () => {
        const siteless = [...ruleSiteField].filter(([, site]) => site === null).map(([table]) => table)
        expect(siteless).toEqual(expect.arrayContaining(['x_daas_ham_agreement', 'x_daas_ham_fee_event']))
        expect(siteContactReads.filter((acl) => siteless.includes(acl.table))).toEqual([])
    })
})

describe('row checks of the read ACLs', () => {
    const rowChecks = recordAcls.filter((acl) => acl.operation === 'read' && acl.deny)

    it('deny, on each table the rules narrow to stockrooms, what its rule would hide', () => {
        expect(rowChecks.map((acl) => acl.records).sort()).toEqual([...STOCKROOM_SCOPED_TABLES].sort())
        for (const acl of rowChecks) {
            expect(ruleScope.get(acl.records), acl.records).toBeDefined()
            expect(checkedScope(acl.script), `${acl.records}: ${acl.script}`).toBe(ruleScope.get(acl.records))
        }
    })

    it('take no role: every reader passes them, as the rules narrow whoever reads', () => {
        for (const acl of rowChecks) expect(acl.roles, acl.records).toBe('')
    })

    it('apply to every record of their table: the script, not Applies To, tells what a reader leaves to the platform', () => {
        for (const acl of rowChecks.filter((acl) => acl.table === acl.records)) expect(acl.appliesTo, acl.table).toBe('')
    })

    it('pass a record that is not a saved row, which holds nothing to hide (a New form, a check of the whole table)', () => {
        expect(entrySource).toMatch(/saved: !current\.isNewRecord\(\) && !!current\.getUniqueValue\(\)/)
    })
})

describe('ACLs on the hardware the app shares with the Provider IT', () => {
    const hardware = recordAcls.filter((acl) => acl.records === 'alm_hardware')
    /** The app's ACLs on alm_asset, the parent: record and field ACLs that apply to hardware alone. */
    const onParent = acls.filter((acl) => acl.table === 'alm_asset')

    it("sit on alm_asset, so alm_hardware inherits the platform's record ACLs there and an alm_asset list is checked too", () => {
        expect(recordAcls.filter((acl) => acl.table === 'alm_hardware')).toEqual([])
        expect(hardware.length).toBeGreaterThanOrEqual(5)
        for (const acl of hardware) expect(acl.table, `${acl.operation} ${acl.roles}`).toBe('alm_asset')
        expect(onParent.filter((acl) => acl.records !== 'alm_hardware')).toEqual([])
    })

    it('check the class again in their script, in case Applies To is not applied', () => {
        for (const acl of onParent.filter((acl) => acl.deny || !acl.field)) {
            expect(acl.script, `${acl.operation} ${acl.field} ${acl.roles}`).toMatch(/^\w+$/)
            const body = new RegExp(`export function ${acl.script}\\(current: GlideRecord\\): boolean \\{[^}]*`).exec(entrySource)?.[0]
            expect(body, acl.script).toContain('otherAssetClass(current)')
        }
    })

    it('grant only fleet assets: the Allow-If ones leave other hardware to the platform', () => {
        for (const acl of hardware.filter((acl) => !acl.deny)) expect(acl.script, acl.roles).toBe('grantsFleetAsset')
        expect(entrySource).toMatch(/outsideNaas: \(hardware\) => !isFleetAsset\(hardware\)/)
    })
})

describe('ACLs on changes to hardware by hand', () => {
    const onParent = (operation: string, field = '') =>
        acls.filter((acl) => acl.table === 'alm_asset' && acl.operation === operation && acl.field === field)
    const denyScript = (operation: string, field = '') => onParent(operation, field).filter((acl) => acl.deny).map((acl) => acl.script)

    it('check, beside the platform\'s asset-role ACLs, who saves and deletes a fleet asset', () => {
        expect(denyScript('write')).toEqual(['writesAsset'])
        expect(denyScript('delete')).toEqual(['deletesAsset'])
        for (const acl of onParent('write').concat(onParent('delete'))) expect(acl.roles, acl.operation).toBe('')
    })

    it("keep a fleet asset's company and cost to asset managers, and its cost from Customer contacts", () => {
        expect(denyScript('write', 'company')).toEqual(['writesAssetCommercialField'])
        expect(denyScript('write', 'cost')).toEqual(['writesAssetCommercialField'])
        expect(denyScript('read', 'cost')).toEqual(['readsAssetCost'])
    })

    /*
     * Allow-If ACLs the platform has at the same name and operation (Brazil, read-only, 2026-11-09): alm_asset.company
     * write (snc_internal), alm_asset.cost read (snc_internal; sn_esm_user, sn_customerservice.requester). alm_asset.cost
     * has no write ACL of the platform's: it takes alm_asset.*'s, snc_internal on an Asset not consumed (10).
     */
    const PLATFORM_ALLOW_IF = ['alm_asset.company write', 'alm_asset.cost read']

    it('sit each beside an Allow-If ACL of its own level, so no verdict depends on matching across levels', () => {
        const denied = acls.filter((acl) => acl.deny && acl.field)
        expect(denied.length).toBeGreaterThan(0)
        for (const acl of denied) {
            const level = `${acl.table}.${acl.field} ${acl.operation}`
            const ours = acls.filter((other) => !other.deny && other.table === acl.table && other.field === acl.field && other.operation === acl.operation)
            expect(PLATFORM_ALLOW_IF.includes(level) || ours.length > 0, level).toBe(true)
        }
        const costWrite = onParent('write', 'cost').filter((acl) => !acl.deny)
        expect(costWrite.map((acl) => [acl.roles, acl.condition, acl.appliesTo])).toEqual([["['snc_internal']", 'install_status!=10', 'sys_class_name=alm_hardware']])
    })

    it("leave the app's own Customer and ownership columns on hardware to asset managers, and its Fleet flag to admins", () => {
        const writers = (field: string) => acls.filter((acl) => acl.table === 'alm_hardware' && acl.field === field && acl.operation === 'write')
        for (const field of ['x_daas_ham_agreement', 'x_daas_ham_subscription_line', 'x_daas_ham_lease', 'x_daas_ham_lessor', 'x_daas_ham_legal_owner']) {
            expect(writers(field).map((acl) => [acl.roles, acl.deny]), field).toEqual([['[assetManager]', false]])
        }
        expect(writers('x_daas_ham_fleet').map((acl) => acl.roles)).toEqual(['[admin]'])
        expect(acls.filter((acl) => acl.field === 'x_daas_ham_fleet' && acl.operation === 'create').map((acl) => acl.roles)).toEqual(['[admin]'])
    })

    it("name in ASSET_EDITOR_ROLES the roles of security/roles.now.ts assetEditors", () => {
        const roles = source('roles.now.ts')
        const roleName = new Map([...roles.matchAll(/export const (\w+) = Role\(\{\s*name: '([^']+)'/g)].map((m) => [m[1], m[2]]))
        const editors = (/export const assetEditors = \[([^\]]*)\]/.exec(roles)?.[1] ?? '').split(',').map((name) => roleName.get(name.trim()))
        expect(editors).toEqual([...ASSET_EDITOR_ROLES])
    })
})

describe("ACLs on the Provider's own fields of records a Customer contact reads", () => {
    const fieldReaders = (table: string, field: string) => acls.filter((acl) => acl.table === table && acl.field === field && acl.operation === 'read' && !acl.deny)

    it('grant them to provider staff, which holds no customer role, so the record a contact reads comes without them', () => {
        const fields: Array<[string, string]> = [
            ['alm_hardware', 'x_daas_ham_support_cost'],
            ['alm_hardware', 'x_daas_ham_claim_code'],
            ['alm_hardware', 'x_daas_ham_lessor'],
            ['alm_hardware', 'x_daas_ham_lease'],
            ['x_daas_ham_shipment', 'cost'],
        ]
        for (const [table, field] of fields) expect(fieldReaders(table, field).map((acl) => acl.roles), `${table}.${field}`).toEqual(['providerStaff'])
        expect(source('roles.now.ts')).toMatch(/export const providerStaff = \[(?![^\]]*(customerAdmin|siteContact))[^\]]*\]/)
    })
})

describe('create ACLs of Orders, Order lines and Returns', () => {
    const creators = (table: string) => recordAcls.filter((acl) => acl.table === table && acl.operation === 'create')
    const CUSTOMER_CHECK = "var company = gs.getUser().getCompanyID(); answer = !!company && "

    it('give a customer admin no Order lines: the record producer adds them past the ACLs (entry/orders)', () => {
        expect(creators('x_daas_ham_order_line').map((acl) => acl.roles)).toEqual(['orderRaisers'])
        expect(source('acls.now.ts')).toMatch(/const orderRaisers = \[(?![^\]]*customer)[^\]]*\]/)
    })

    it("let a customer admin create an Order only of their own Customer, and a Return of theirs or of none yet", () => {
        const forCustomer = (table: string) => creators(table).filter((acl) => acl.roles === '[customerAdmin]')
        expect(forCustomer('x_daas_ham_order').map((acl) => acl.inlineScript)).toEqual([`${CUSTOMER_CHECK}current.getValue('customer') == company;`])
        expect(forCustomer('x_daas_ham_return_order').map((acl) => acl.inlineScript)).toEqual([
            `${CUSTOMER_CHECK}(current.customer.nil() || current.getValue('customer') == company);`,
        ])
        for (const table of ['x_daas_ham_order', 'x_daas_ham_return_order']) {
            expect(creators(table).filter((acl) => /customer|siteContact/.test(acl.roles) && acl.roles !== '[customerAdmin]'), table).toEqual([])
        }
    })
})

describe('read ACLs of the service desk', () => {
    it('cover the tables of the Orders and Returns it raises, and no other', () => {
        const read = recordAcls.filter((acl) => acl.operation === 'read' && acl.roles === '[serviceDesk]').map((acl) => acl.table)
        expect(read.sort()).toEqual(
            [
                'x_daas_ham_agreement',
                'x_daas_ham_order',
                'x_daas_ham_order_line',
                'x_daas_ham_return_order',
                'x_daas_ham_return_order_line',
                'x_daas_ham_site_template',
                'x_daas_ham_site_template_item',
            ].sort(),
        )
        expect(source('acls.now.ts')).toMatch(/const orderRaisers = \[[^\]]*\bserviceDesk\b[^\]]*\]/)
        expect(source('roles.now.ts')).toContain("export const serviceDesk = 'sn_customerservice_agent'")
    })
})

describe('the NaaS dashboard', () => {
    const dashboard = readFileSync(new URL('../../fluent/workspace/dashboard.now.ts', import.meta.url), 'utf8')
    const workspace = readFileSync(new URL('../../fluent/workspace/workspace.now.ts', import.meta.url), 'utf8')
    const roles = source('roles.now.ts')
    const roleName = new Map([...roles.matchAll(/export const (\w+) = Role\(\{\s*name: '([^']+)'/g)].map((m) => [m[1], m[2]]))
    /** The role names of a list of roles.now.ts constants, as `a, b, c`. */
    const names = (list: string | undefined) => (list ?? '').split(',').map((name) => roleName.get(name.trim()) ?? name.trim()).sort()

    it("is read by the workspace's roles, so the NOC and the techs keep its Operations, Billing and Lifecycle tabs", () => {
        const staff = names(/export const providerStaff = \[([^\]]*)\]/.exec(roles)?.[1])
        const permitted = [...dashboard.matchAll(/role: Now\.ref\('sys_user_role', \{ name: '([^']+)' \}\), canRead: true/g)].map((m) => m[1]).sort()
        expect(staff).toHaveLength(6)
        expect(names(/type: 'ux_route',[^}]*?roles: \[([^\]]*)\]/.exec(workspace)?.[1])).toEqual(staff)
        expect(permitted).toEqual(staff)
        expect(dashboard).not.toMatch(/canWrite: true|canShare: true|owner: true/)
    })

    it("leaves each widget's data to its table's read ACL: the Margin tab's to the money readers", () => {
        const tables = [...new Set([...dashboard.matchAll(/tableOrViewName: '(\w+)'/g)].map((m) => m[1]))]
        expect(tables).toEqual(expect.arrayContaining(['alm_hardware', 'x_daas_ham_margin', 'x_daas_ham_cost_fact']))
        for (const table of tables) expect(recordAcls.some((acl) => acl.records === table && acl.operation === 'read' && !acl.deny), table).toBe(true)
        expect(source('acls-commercial.now.ts')).toMatch(/table: 'x_daas_ham_margin',\s*operation: 'read',\s*roles: moneyReaders/)
        expect(source('acls-commercial.now.ts')).toMatch(/table: 'x_daas_ham_cost_fact',\s*operation: 'read',\s*roles: moneyReaders/)
    })
})
