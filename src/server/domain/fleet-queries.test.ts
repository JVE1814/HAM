import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { fleetCondition, fleetStagesQuery, inFleet, naasModelCondition, naasStockroomCondition } from './fleet.ts'
import type { Stage } from './lifecycle.ts'

/*
 * The workspace dashboard, the workspace lists and the navigator modules count and list fleet assets, NaaS Models and
 * NaaS stockrooms only, and an Asset, Model or Stockroom picker on the app's forms and catalog items offers fleet
 * assets, NaaS Models or NaaS stockrooms only (ADR 0016): the platform tables they read hold the Provider IT's records
 * too. Fluent metadata cannot call domain/fleet, so their encoded queries and reference qualifiers are literals, which
 * this checks against it.
 */

const fluent = new URL('../../fluent/', import.meta.url)
const read = (file: string) => readFileSync(new URL(file, fluent), 'utf8')
const nowFiles = (dir: string, prefix = '') =>
    readdirSync(new URL(dir, fluent))
        .filter((name) => name.startsWith(prefix) && name.endsWith('.now.ts'))
        .map((name) => `${dir}${name}`)

/** The workspace (its dashboard and lists), the navigator menu and the form and list layouts. */
const FILES = [...nowFiles('workspace/'), 'ui/menu.now.ts', ...nowFiles('ui/', 'forms')]

/** What a read of each shared table must keep to, in every ^NQ clause. */
const REQUIRED: Readonly<Record<string, string>> = {
    alm_hardware: fleetCondition(),
    cmdb_model: naasModelCondition(),
    // The platform's Model lifecycle table (ADR 0017) holds the milestones of the Provider IT's Models too.
    cmdb_model_lifecycle: naasModelCondition('model.'),
    alm_stockroom: naasStockroomCondition(),
}

interface Query {
    file: string
    /** The data source's id (dashboard) or the Now.ID key (workspace list, navigator module). */
    id: string
    table: string
    query: string
}

const quoted = (source: string, key: string): string | undefined => new RegExp(`\\b${key}:\\s*'([^']*)'`).exec(source)?.[1]

/** Dashboard data sources: flat object literals with a tableOrViewName and a filterQuery. */
function dataSources(file: string, source: string): Query[] {
    return [...source.matchAll(/\{[^{}]*\btableOrViewName:[^{}]*\}/g)].map(([object]) => ({
        file,
        id: quoted(object, 'id') ?? '',
        table: quoted(object, 'tableOrViewName') ?? '',
        query: quoted(object, 'filterQuery') ?? '',
    }))
}

/**
 * Workspace lists (a table and a condition) and navigator modules (a sys_app_module record naming a table, with a
 * filter or, for a LIST module, none), each up to the next Now.ID.
 */
function listsAndModules(file: string, source: string): Query[] {
    return source
        .split("$id: Now.ID['")
        .slice(1)
        .flatMap((entry) => {
            const id = entry.slice(0, entry.indexOf("'"))
            const table = quoted(entry, 'table')
            if (table === 'sys_app_module') {
                const name = quoted(entry, 'name')
                return name ? [{ file, id, table: name, query: quoted(entry, 'filter') ?? '' }] : []
            }
            const condition = quoted(entry, 'condition')
            return table && condition !== undefined ? [{ file, id, table, query: condition }] : []
        })
}

const queries: Query[] = FILES.flatMap((file) => {
    const source = read(file)
    return [...dataSources(file, source), ...listsAndModules(file, source)]
})
const onShared = queries.filter((query) => query.table in REQUIRED)
const byId = (id: string): string => queries.find((query) => query.id === id)?.query ?? `<no query ${id}>`
/** A workspace list's condition without its end-of-query marker. */
const bare = (query: string) => query.replace(/\^EQ$/, '')

/** A term that is ORed to the one before it (`^OR`), unlike an ordering (`^ORDERBY`). */
const isOrTerm = (term: string) => term.startsWith('OR') && !term.startsWith('ORDERBY')

/**
 * Whether `condition` holds in every ^NQ clause of `query`: one of the clause's AND terms, not one side of an `^OR`.
 * A condition after an ^NQ binds to the last clause only.
 */
function holdsInEveryClause(query: string, condition: string): boolean {
    return query.split('^NQ').every((clause) => {
        const terms = clause.split('^')
        return terms.some((term, i) => term === condition && !isOrTerm(terms[i + 1] ?? ''))
    })
}

describe('holdsInEveryClause', () => {
    it("takes what domain/fleet's inFleet builds", () => {
        expect(holdsInEveryClause(fleetCondition(), fleetCondition())).toBe(true)
        expect(holdsInEveryClause(inFleet('install_status=1^NQinstall_status=6'), fleetCondition())).toBe(true)
        expect(holdsInEveryClause(`install_status=1^${fleetCondition()}^ORDERBYasset_tag^EQ`, fleetCondition())).toBe(true)
    })

    it('refuses a condition missing from a clause, bound to the last clause only, or ORed', () => {
        expect(holdsInEveryClause('install_status=1', fleetCondition())).toBe(false)
        expect(holdsInEveryClause(`install_status=1^NQinstall_status=6^${fleetCondition()}`, fleetCondition())).toBe(false)
        expect(holdsInEveryClause(`install_status=1^${fleetCondition()}^ORinstall_status=6`, fleetCondition())).toBe(false)
        expect(holdsInEveryClause(`install_status=1^OR${fleetCondition()}`, fleetCondition())).toBe(false)
        expect(holdsInEveryClause(`install_status=1^x_daas_ham_fleet=false`, fleetCondition())).toBe(false)
    })
})

describe('queries of the workspace, dashboard, navigator and forms on shared tables', () => {
    it('are all read here: every mention of a shared table in these files is a query this test checks', () => {
        const mention = new RegExp(`\\b(?:tableOrViewName|table|name):\\s*'(${Object.keys(REQUIRED).join('|')})'`, 'g')
        for (const file of FILES) {
            const mentions = [...read(file).matchAll(mention)].map(([, table]) => table)
            const checked = onShared.filter((query) => query.file === file).map((query) => query.table)
            expect({ file, tables: checked.sort() }).toEqual({ file, tables: mentions.sort() })
        }
        // Not vacuous: the dashboard tiles, the workspace lists and the navigator modules are all found.
        expect(onShared.map((query) => query.id)).toEqual(
            expect.arrayContaining(['unbilled', 'ended_line', 'dash_w_no_coverage_ds', 'ws_assets_in_service', 'ws_models_canonical', 'ws_models_lifecycle', 'module_model_lifecycle', 'module_spare_pools']),
        )
    })

    it('count and list fleet assets only, NaaS Models only and NaaS stockrooms only', () => {
        const outside = onShared
            .filter((query) => !holdsInEveryClause(query.query, REQUIRED[query.table] ?? ''))
            .map(({ file, id, table, query }) => `${file} ${id} (${table}): '${query}'`)
        expect(outside).toEqual([])
    })

    it("are domain/fleet's fleetStagesQuery where they list one stage", () => {
        const stageQueries: ReadonlyArray<[string, readonly Stage[], string?]> = [
            ['pending_in_service', ['pending_in_service']],
            ['spares_by_customer', ['spare_pool']],
            ['unbilled', ['in_service'], 'x_daas_ham_subscription_lineISEMPTY'],
            ['ws_assets_in_service', ['in_service']],
            ['ws_assets_pending_in_service', ['pending_in_service']],
            ['ws_stock_available', ['available']],
            ['ws_stock_spare_pools', ['spare_pool']],
            ['ws_stock_in_transit', ['in_transit']],
            ['module_assets_in_service', ['in_service']],
            ['module_assets_pending', ['pending_in_service']],
            ['module_spare_pools', ['spare_pool']],
        ]
        for (const [id, stages, base] of stageQueries) {
            expect({ id, query: bare(byId(id)) }).toEqual({ id, query: fleetStagesQuery(stages, base) })
        }
    })

    it('count on the dashboard what the workspace list of the same name shows', () => {
        const pairs: ReadonlyArray<[string, string]> = [
            ['pending_in_service', 'ws_assets_pending_in_service'],
            ['dash_w_past_support_ds', 'ws_risk_past_support'],
            ['dash_w_no_coverage_ds', 'ws_risk_no_coverage'],
        ]
        for (const [tile, list] of pairs) expect({ tile, query: byId(tile) }).toEqual({ tile, query: bare(byId(list)) })
    })

    it('count as without OEM coverage an installed fleet asset whose coverage is missing or ended before today', () => {
        const noCoverage = 'x_daas_ham_coverage_endISEMPTY^ORx_daas_ham_coverage_end<javascript:gs.beginningOfToday()'
        expect(byId('dash_w_no_coverage_ds')).toBe(inFleet(`install_status=1^${noCoverage}`))
    })
})

/** The table definitions: the app's tables and its columns on platform tables. */
const DATA_FILES = nowFiles('data/')
/** The UI metadata, where the catalog items (the record producers) and their variable sets are defined. */
const UI_FILES = nowFiles('ui/')

/** A column or a catalog variable that references a shared table, with the query its reference qualifier applies. */
interface SharedReference {
    file: string
    /** `<table>.<column>`, or `<catalog item or variable set id>.<variable>` */
    field: string
    table: string
    /** The encoded query its reference qualifier applies, if it has one. */
    qualifier: string | undefined
}

/** The keys that name the table a column or catalog variable references (a list collector's, a lookup's). */
const TABLE_KEYS = ['referenceTable', 'listTable', 'lookupTable'] as const
const SHARED_TABLES = Object.keys(REQUIRED).join('|')

const doubleQuoted = (source: string, key: string): string | undefined => new RegExp(`\\b${key}:\\s*"([^"]*)"`).exec(source)?.[1]

/** The value a `javascript:` qualifier appends to its literal: the term it completes is never a condition. */
const FORM_VALUE = '<form value>'

/**
 * The encoded query a reference qualifier applies: its condition (`referenceQualCondition`), or its `referenceQual`. A
 * `javascript:` one applies the string literal it starts with, followed by a value of the form (such as
 * `current.variables.site`), which completes the literal's last term; a script of any other shape counts as no query.
 */
function qualifierOf(config: string): string | undefined {
    const qualifier = quoted(config, 'referenceQualCondition') ?? quoted(config, 'referenceQual') ?? doubleQuoted(config, 'referenceQual')
    if (!qualifier?.startsWith('javascript:')) return qualifier
    const script = /^javascript:\s*'([^']*)'\s*(\+?)/.exec(qualifier)
    if (!script) return ''
    return script[2] ? `${script[1]}${FORM_VALUE}` : (script[1] ?? '')
}

/**
 * What a reference at `index` of `source` belongs to: the `Table({` before it (by its name or what it augments), or the
 * catalog item or variable set whose `Now.ID` comes before it, whichever is nearer.
 */
function ownerAt(source: string, index: number): string {
    const table = source.lastIndexOf('Table({', index)
    const id = source.lastIndexOf("Now.ID['", index)
    if (table > id) {
        const head = source.slice(table, index)
        return quoted(head, 'augments') ?? quoted(head, 'name') ?? '<no table>'
    }
    const start = id + "Now.ID['".length
    return id >= 0 ? source.slice(start, source.indexOf("'", start)) : '<no owner>'
}

/** Every column or catalog variable (a flat object literal) that references a shared table, with its qualifier. */
function sharedReferences(file: string, source: string): SharedReference[] {
    return [...source.matchAll(/\b(\w+):\s*\w+\(\{([^{}]*)\}\)/g)].flatMap((match) => {
        const config = match[2] ?? ''
        const table = TABLE_KEYS.map((key) => quoted(config, key)).find((name) => name !== undefined)
        if (!table || !(table in REQUIRED)) return []
        return [{ file, field: `${ownerAt(source, match.index)}.${match[1]}`, table, qualifier: qualifierOf(config) }]
    })
}

const REFERENCE_FILES = [...DATA_FILES, ...UI_FILES]
const references = REFERENCE_FILES.flatMap((file) => sharedReferences(file, read(file)))

/*
 * The forms and catalog items show each of these for a user to fill or change, and a reference qualifier only filters
 * what a picker offers, so a column the app itself writes takes one as well: a user editing the record cannot pick an
 * IT laptop, an IT storeroom or a Model without an OEM PID either. Server code that writes these columns finds fleet
 * assets on its own (platform/assets), and a record producer checks what was submitted again.
 */
describe("the Asset, Model and Stockroom references on the app's tables and catalog items", () => {
    it('are all read here: every reference to a shared table in the table definitions and UI metadata is checked', () => {
        const mention = new RegExp(`\\b(?:${TABLE_KEYS.join('|')}):\\s*'(?:${SHARED_TABLES})'`, 'g')
        for (const file of REFERENCE_FILES) {
            const mentions = read(file).match(mention)?.length ?? 0
            expect({ file, references: references.filter((reference) => reference.file === file).length }).toEqual({ file, references: mentions })
        }
        // Not vacuous: the app's own lines, the case's Failed asset, the Model and Stockroom references and the catalog
        // items' variables are found.
        expect(references.map((reference) => reference.field)).toEqual(
            expect.arrayContaining([
                'x_daas_ham_order_line.replaces_asset',
                'x_daas_ham_disposal_line.asset',
                'x_daas_ham_return_order_line.asset',
                'x_daas_ham_fee_event.asset',
                'x_daas_ham_oem_rma.defective_asset',
                'sn_customerservice_case.x_daas_ham_failed_asset',
                'x_daas_ham_order_line.model',
                'x_daas_ham_site_template_item.model',
                'x_daas_ham_norm_exception.resolved_model',
                'cmdb_model.x_daas_ham_normalized_to',
                'x_daas_ham_stockroom_member.stockroom',
                'x_daas_ham_audit.stockroom',
                'x_daas_ham_shipment.stockroom',
                'vs_order_devices.model',
                'rp_request_return.assets',
            ]),
        )
    })

    it("offer fleet assets, NaaS Models and NaaS stockrooms only: each qualifier holds domain/fleet's condition", () => {
        const unqualified = references
            .filter((reference) => !holdsInEveryClause(reference.qualifier ?? '', REQUIRED[reference.table] ?? ''))
            .map(({ file, field, table, qualifier }) => `${file} ${field} (${table}): ${qualifier === undefined ? 'no qualifier' : `'${qualifier}'`}`)
        expect(unqualified).toEqual([])
    })
})

describe('qualifierOf', () => {
    it("reads a condition, an encoded query and a javascript qualifier's leading literal", () => {
        expect(qualifierOf("referenceQualCondition: 'a=1^b=2'")).toBe('a=1^b=2')
        expect(qualifierOf("referenceQual: 'a=1'")).toBe('a=1')
        expect(qualifierOf(`referenceQual: "javascript:'a=1^b=' + current.variables.site"`)).toBe(`a=1^b=${FORM_VALUE}`)
        expect(qualifierOf(`referenceQual: "javascript:'a=1'"`)).toBe('a=1')
        expect(qualifierOf("label: 'Asset'")).toBeUndefined()
    })

    it('never takes the term a form value completes, or a script of another shape, for a condition', () => {
        const condition = fleetCondition()
        expect(holdsInEveryClause(qualifierOf(`referenceQual: "javascript:'${condition}' + current.variables.x"`) ?? '', condition)).toBe(false)
        expect(holdsInEveryClause(qualifierOf(`referenceQual: "javascript:'${condition}^OR' + current.variables.x"`) ?? '', condition)).toBe(false)
        expect(qualifierOf(`referenceQual: "javascript:new Qualifier().get('${condition}')"`)).toBe('')
    })
})
