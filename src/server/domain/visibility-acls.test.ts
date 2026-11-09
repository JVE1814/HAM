import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SCOPE, STOCKROOM_SCOPED_TABLES, type ScopedRecords } from './visibility'

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
        operation: /operation: '([^']+)'/.exec(acl)?.[1] ?? '',
        deny: acl.includes("decisionType: 'deny'"),
        roles: /roles: (\[[^\]]*\]|\w+)/.exec(acl)?.[1] ?? '',
        appliesTo: /appliesTo:\s*'([^']*)'/.exec(acl)?.[1] ?? '',
        script: /script: (\w+)/.exec(acl)?.[1] ?? '',
    }))

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
    const rowChecks = acls.filter((acl) => acl.operation === 'read' && acl.deny)

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
    const hardware = acls.filter((acl) => acl.records === 'alm_hardware')

    it("sit on alm_asset, so alm_hardware inherits the platform's read ACLs there and an alm_asset list is checked too", () => {
        expect(acls.filter((acl) => acl.table === 'alm_hardware')).toEqual([])
        expect(hardware.length).toBeGreaterThanOrEqual(3)
        for (const acl of hardware) expect(acl.table, `${acl.operation} ${acl.roles}`).toBe('alm_asset')
        expect(acls.filter((acl) => acl.table === 'alm_asset' && acl.records !== 'alm_hardware')).toEqual([])
    })

    it('check the class again in their script, in case Applies To is not applied', () => {
        for (const acl of hardware) {
            expect(acl.script, `${acl.operation} ${acl.roles}`).toMatch(/^\w+$/)
            const body = new RegExp(`export function ${acl.script}\\(current: GlideRecord\\): boolean \\{[^}]*`).exec(entrySource)?.[0]
            expect(body, acl.script).toContain('otherAssetClass(current)')
        }
    })

    it('grant only fleet assets: the Allow-If ones leave other hardware to the platform', () => {
        for (const acl of hardware.filter((acl) => !acl.deny)) expect(acl.script, acl.roles).toBe('grantsFleetAsset')
        expect(entrySource).toMatch(/outsideNaas: \(hardware\) => !isFleetAsset\(hardware\)/)
    })
})
