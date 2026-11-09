import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SCOPED_TABLES, type TableScoping } from './visibility'

/*
 * What a reader may see is decided in one place (domain/visibility SCOPED_TABLES, tested in visibility.test.ts) and
 * reached through three scripts (entry/visibility `scopeRecords`, `readsRecord`, `grantsCustomerRecord`, and
 * `grantsFleetAsset` for hardware), each of which finds the table of the record it is handed. What code cannot say
 * is which records call them: these tests read the security Fluent files for that. A before-query rule (ADR 0005)
 * narrows lists, but a record reached another way (a dot-walk from a visible record, an `^NQ` clause the rule's filter
 * does not reach, or a table with no rule) is guarded only by its read ACL.
 */

const SECURITY = new URL('../../fluent/security/', import.meta.url)
const source = (file: string) => readFileSync(new URL(file, SECURITY), 'utf8')
const SCOPINGS: Readonly<Record<string, TableScoping>> = SCOPED_TABLES
const scopedTables = Object.keys(SCOPINGS)

const items = (list: string) => list.split(',').map((item) => item.trim().replace(/"/g, "'")).filter(Boolean)
const namedLists = (text: string) => new Map([...text.matchAll(/const (\w+) = \[([^\]]*)\]/g)].map((m) => [m[1], items(m[2])]))
const roleLists = namedLists(source('roles.now.ts'))

/** Every ACL of the app's security files, as the fields these tests read. */
const acls = readdirSync(SECURITY)
    .filter((file) => /^acls.*\.now\.ts$/.test(file))
    .flatMap((file) => {
        const text = source(file)
        const lists = new Map([...roleLists, ...namedLists(text)])
        const expand = (token: string): string[] => {
            const name = token.replace(/^\.\.\./, '')
            return lists.has(name) ? (lists.get(name) ?? []).flatMap(expand) : [token]
        }
        return text
            .split('Acl({')
            .slice(1)
            .map((acl) => {
                const table = /table: '([^']+)'/.exec(acl)?.[1] ?? ''
                const granted = /roles: (\[[^\]]*\]|\w+)/.exec(acl)?.[1] ?? ''
                const appliesTo = /appliesTo:\s*'([^']*)'/.exec(acl)?.[1] ?? ''
                return {
                    table,
                    /** The table of its records: its own, or the one class an ACL on a parent table applies to. */
                    records: /^sys_class_name=(\w+)$/.exec(appliesTo)?.[1] ?? table,
                    operation: /operation: '([^']+)'/.exec(acl)?.[1] ?? '',
                    deny: acl.includes("decisionType: 'deny'"),
                    /** The roles it names, with named role lists expanded. */
                    roles: (granted.startsWith('[') ? items(granted.slice(1, -1)) : granted ? [granted] : []).flatMap(expand),
                    appliesTo,
                    /** The entry function its script is, or `inline` for a script written in the ACL. */
                    script: /script: (\w+),/.exec(acl)?.[1] ?? (/script:/.test(acl) ? 'inline' : ''),
                }
            })
    })
const reads = acls.filter((acl) => acl.operation === 'read')

const rules = source('visibility.now.ts')
    .split('BusinessRule({')
    .slice(1)
    .map((rule) => ({ table: /table: '([^']+)'/.exec(rule)?.[1] ?? '', script: /script: (\w+),/.exec(rule)?.[1] ?? '' }))
const ruledTables = rules.map((rule) => rule.table)

describe('before-query rules', () => {
    it('run the one script, each on a table that has a scoping for it to find', () => {
        expect(rules.length).toBeGreaterThan(0)
        for (const rule of rules) {
            expect(rule.script, rule.table).toBe('scopeRecords')
            expect(scopedTables, rule.table).toContain(rule.table)
        }
        expect(new Set(ruledTables).size).toBe(ruledTables.length)
    })

    it('narrow every scoped table but the lines and Site templates, which their read ACL alone guards', () => {
        expect(scopedTables.filter((table) => !ruledTables.includes(table)).sort()).toEqual([
            'x_daas_ham_attestation_item',
            'x_daas_ham_return_order_line',
            'x_daas_ham_shipment_event',
            'x_daas_ham_site_template',
            'x_daas_ham_site_template_item',
        ])
    })
})

describe('row checks of the read ACLs', () => {
    const rowChecks = reads.filter((acl) => acl.deny)
    const stockroomScoped = scopedTables.filter((table) => SCOPINGS[table].stockroom)

    it('deny, on each table the rules narrow to stockrooms, what its rule would hide', () => {
        expect(stockroomScoped).toContain('alm_hardware')
        expect(rowChecks.map((acl) => acl.records).sort()).toEqual([...stockroomScoped].sort())
        for (const table of stockroomScoped) expect(ruledTables, table).toContain(table)
        for (const acl of rowChecks) expect(acl.script, acl.records).toBe('readsRecord')
    })

    it('take no role: every reader passes them, as the rules narrow whoever reads', () => {
        for (const acl of rowChecks) expect(acl.roles, acl.records).toEqual([])
    })

    it('apply to every record of their table: the script, not Applies To, tells what a reader leaves to the platform', () => {
        for (const acl of rowChecks.filter((acl) => acl.table === acl.records)) expect(acl.appliesTo, acl.table).toBe('')
    })
})

describe('read ACLs for Customer contacts', () => {
    const contactReads = reads.filter((acl) => !acl.deny && acl.roles.some((role) => role === 'customerAdmin' || role === 'siteContact'))

    it('cover the tables a Customer contact reads', () => {
        expect(contactReads.map((acl) => acl.records).sort()).toEqual(
            expect.arrayContaining(['alm_hardware', 'x_daas_ham_order', 'x_daas_ham_order_line', 'x_daas_ham_return_order', 'x_daas_ham_shipment']),
        )
    })

    it("grant a record only through the shared decision: no ACL lets a contact in without it, or decides for itself", () => {
        for (const acl of contactReads) {
            expect(acl.script, acl.records).toBe(acl.records === 'alm_hardware' ? 'grantsFleetAsset' : 'grantsCustomerRecord')
        }
        expect(acls.filter((acl) => acl.script === 'inline')).toEqual([])
    })

    it('sit on a scoped table with a Customer field, and with a Site field where they admit site contacts', () => {
        for (const acl of contactReads) {
            expect(SCOPINGS[acl.records]?.customer, acl.records).toBeTruthy()
            if (acl.roles.includes('siteContact')) expect(SCOPINGS[acl.records]?.site, acl.records).toBeTruthy()
        }
    })

    it('are the only check on a scoped table with no before-query rule, so each of those has one', () => {
        const granted = contactReads.map((acl) => acl.records)
        for (const table of scopedTables.filter((table) => !ruledTables.includes(table))) expect(granted, table).toContain(table)
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

    it('grant only fleet assets: the Allow-If ones leave other hardware to the platform', () => {
        for (const acl of hardware.filter((acl) => !acl.deny)) expect(acl.script, `${acl.roles}`).toBe('grantsFleetAsset')
    })
})
