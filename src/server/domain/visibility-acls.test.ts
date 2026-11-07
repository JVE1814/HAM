import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/*
 * The before-query rules (ADR 0005) narrow lists, but a record reached another way (a dot-walk from a visible record,
 * or a table with no rule) is guarded only by its read ACL. So every read ACL a site contact passes re-checks the
 * Site, on the same field as the table's before-query rule.
 */

const SECURITY = new URL('../../fluent/security/', import.meta.url)
const source = (file: string) => readFileSync(new URL(file, SECURITY), 'utf8')

/** Every read ACL a site contact passes (customerRoles holds the site contact role), as its table and script. */
const siteContactReads = readdirSync(SECURITY)
    .filter((file) => /^acls.*\.now\.ts$/.test(file))
    .flatMap((file) => source(file).split('Acl({').slice(1))
    .filter((acl) => acl.includes("operation: 'read'") && /roles: (customerRoles\b|\[[^\]]*\bsiteContact\b)/.test(acl))
    .map((acl) => ({ table: /table: '([^']+)'/.exec(acl)?.[1] ?? '', script: /script: "([^"]*)"/.exec(acl)?.[1] ?? '' }))

/** The Site field each before-query rule filters a site contact on, by table; null for a rule with none. */
const ruleSiteField = (() => {
    const entrySource = readFileSync(new URL('../entry/visibility.ts', import.meta.url), 'utf8')
    const fieldsOf = new Map([...entrySource.matchAll(/export function (\w+)\(current: GlideRecord\): void \{\s*restrict\(current, (\{[^}]*\})\)/g)].map((m) => [m[1], m[2]]))
    return new Map(
        source('visibility.now.ts')
            .split('BusinessRule({')
            .slice(1)
            .map((rule): [string, string | null] => {
                const fields = fieldsOf.get(/script: (\w+)/.exec(rule)?.[1] ?? '') ?? ''
                return [/table: '([^']+)'/.exec(rule)?.[1] ?? '', /\bsite: '([^']+)'/.exec(fields)?.[1] ?? null]
            }),
    )
})()

/** The record path whose Site contacts the script checks, unless the reader is a customer admin. */
const SITE_CHECK = /\(gs\.hasRole\('x_daas_ham\.customer_admin'\) \|\| \(',' \+ current\.([\w.]+)\.x_daas_ham_site_contacts \+ ','\)\.indexOf\(',' \+ gs\.getUserID\(\) \+ ','\) > -1\)/

describe('read ACLs for site contacts', () => {
    it('cover the tables a site contact reads', () => {
        expect(siteContactReads.map((acl) => acl.table).sort()).toEqual(
            expect.arrayContaining(['alm_hardware', 'x_daas_ham_order', 'x_daas_ham_order_line', 'x_daas_ham_return_order', 'x_daas_ham_shipment']),
        )
    })

    it("check the Customer and that the record's Site lists the site contact", () => {
        for (const acl of siteContactReads) {
            expect(acl.script, acl.table).toContain('== gs.getUser().getCompanyID() && ')
            expect(acl.script, acl.table).toMatch(SITE_CHECK)
        }
    })

    it("check the same Site as the table's before-query rule", () => {
        for (const acl of siteContactReads.filter((acl) => ruleSiteField.has(acl.table))) {
            expect(SITE_CHECK.exec(acl.script)?.[1], acl.table).toBe(ruleSiteField.get(acl.table))
        }
    })

    it('grant no table whose before-query rule has no Site field (it shows site contacts nothing)', () => {
        const siteless = [...ruleSiteField].filter(([, site]) => site === null).map(([table]) => table)
        expect(siteless).toEqual(expect.arrayContaining(['x_daas_ham_agreement', 'x_daas_ham_fee_event']))
        expect(siteContactReads.filter((acl) => siteless.includes(acl.table))).toEqual([])
    })
})
