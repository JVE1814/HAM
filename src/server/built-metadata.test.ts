import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, matchesGlob, relative } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
    CURRENT_IS_FLEET,
    FLEET_CONDITION,
    FLEET_FIELD,
    NAAS_MODEL_CONDITION,
    NAAS_STOCKROOM_CONDITION,
    OEM_PID_FIELD,
    STOCKROOM_TYPE_FIELD,
} from './domain/fleet'
import { billingCsvRow, billingLineJson } from './domain/billing'
import { replacementStep } from './domain/breakfix'
import { CANCELLABLE_ORDER_STAGES } from './domain/fulfilment'
import { LOCK_NAME_LENGTH } from './domain/lock-names'
import { claimRoutes, CLAIM_VENDORS, OEM_ADAPTERS } from './domain/oem/adapters'
import { REST_MESSAGE } from './domain/rest-message-names'
import { RMA_AT_OEM } from './domain/oem-rma'
import { buyLabel, labelVoidable, SHIPPING_MESSAGE } from './domain/shipping'
import { stagingClosing } from './domain/staging'
import { SCOPED_TABLES, type TableScoping } from './domain/visibility'
import {
    BROAD_STAFF,
    MONEY_READERS as MONEY_READERS_IN_ORDER,
    PLATFORM_ROLE,
    PROVIDER_STAFF as PROVIDER_STAFF_IN_ORDER,
    ROLE,
} from './domain/roles'
import {
    ORDER_STAGE_CHOICES,
    REPLACEMENT_TIER_CHOICES,
    RMA_STATE_CHOICES,
    SHIPMENT_DIRECTION_CHOICES,
    SHIPMENT_STATUS_CHOICES,
    STAGE_FIELDS,
    TASK_STATE,
    type OrderStage,
    type RmaState,
    type ShipmentStatus,
} from './domain/vocabulary'
import { clearVoidedWipeEvidence, explainLifecycleRefusal, refusesLifecycleChange } from './entry/assets'
import { onAssetServiceChange } from './entry/billing'
import { explainWorkWindowRefusal, refusesWorkWindow } from './entry/delivery'
import { completeInstallOfWork } from './platform/delivery'
import { onDisposalApprovalDecision } from './entry/disposal'
import { onModelLifecycleChanged } from './entry/models'
import { onAllocatedAssetStageChange, onOrderApprovalDecision } from './entry/orders'
import { explainRackRefusal, refusesKeptPlacement, refusesRackPlacement } from './entry/racks'
import { recheckRacksOf } from './platform/racks'
import { takeBackStageAfterTransfer } from './platform/transfers'
import { scopeRecords } from './entry/visibility'
import { EVENT } from './domain/events'
import { takeFailedAssetTerms } from './platform/breakfix'
import { giveToLessor } from './platform/leases'
import { PROPERTY, type PropertyOf } from './domain/properties'
import type { ForeignRecord } from './platform/records'
import { restMessagePort } from './platform/rest-messages'

// The registries the metadata imports from platform modules are plain constants; Glide itself is not needed to read
// them. A property reads as its declared value.
vi.mock('@servicenow/glide', () => ({
    gs: { getProperty: (_name: string, fallback = '') => fallback, warn: () => undefined },
    GlideRecord: class {},
    GlideDateTime: class {},
}))

const sentToRest = vi.hoisted(() => ({ calls: [] as Array<{ message: string; fn: string; variables: string[] }> }))

// Every call is answered 200 with a body each adapter finds what it goes on with in (a session id, a device).
vi.mock('@servicenow/glide/sn_ws', () => ({
    RESTMessageV2: class {
        private readonly call: { message: string; fn: string; variables: string[] }
        constructor(message: string, fn: string) {
            this.call = { message, fn, variables: [] }
            sentToRest.calls.push(this.call)
        }
        setStringParameterNoEscape(name: string) {
            this.call.variables.push(name)
        }
        setRequestHeader() {}
        setRequestBody() {}
        execute() {
            return { getStatusCode: () => 200, getBody: () => JSON.stringify({ sid: 'session', items: [{ id: 'device' }] }) }
        }
    },
}))

/*
 * What the instance is given: the metadata `now-sdk build` writes to dist/app, read as built. The Fluent sources import
 * their vocabulary from the server code, so a copy can no longer drift; what is left to check is what the build and the
 * instance do not: a value the SDK's evaluator could not read (it writes a placeholder and builds on), a text longer
 * than the column the instance stores it in (cut off without a warning), and the conventions the app's metadata keeps
 * on the tables it shares with the Provider's IT (ADR 0016).
 */

const ROOT = new URL('../../', import.meta.url).pathname
const BUILT = join(ROOT, 'dist/app')
const UPDATES = join(BUILT, 'update')

function filesUnder(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name)
        return entry.isDirectory() ? filesUnder(path) : [path]
    })
}

function sources(): string[] {
    const fluent = filesUnder(join(ROOT, 'src/fluent')).filter((path) => !path.includes('/generated/'))
    const testCode = (JSON.parse(readFileSync(join(ROOT, 'now.config.json'), 'utf8')) as { serverModulesExcludePatterns: string[] })
        .serverModulesExcludePatterns
    const isTestCode = (path: string) => testCode.some((pattern) => matchesGlob(relative(join(ROOT, 'src/server'), path), pattern))
    const server = filesUnder(join(ROOT, 'src/server')).filter((path) => path.endsWith('.ts') && !isTestCode(path))
    return [...fluent, ...server, join(ROOT, 'package.json'), join(ROOT, 'now.config.json')]
}

function staleness(): string | null {
    const instruction = 'Run `npx now-sdk build` first (`npm run check` does)'
    if (!existsSync(UPDATES)) return `${instruction}: dist/app is missing.`
    const builtAt = statSync(UPDATES).mtimeMs
    const newer = sources().find((source) => statSync(source).mtimeMs > builtAt)
    return newer ? `${instruction}: dist/app is older than ${relative(ROOT, newer)}.` : null
}

beforeAll(() => {
    const stale = staleness()
    if (stale) throw new Error(stale)
})

const unescapeXml = (text: string) =>
    text
        .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&')

/**
 * One built record: the table it is a record of (`$table`), and each of its fields as the instance stores it ('' for an
 * empty one). A reference built with the name of what it points at has that under `<field>.name`.
 */
interface BuiltRecord {
    $table: string
    [field: string]: string
}

let allRecords: BuiltRecord[] | undefined

function builtRecords(): BuiltRecord[] {
    allRecords ??= readdirSync(UPDATES).flatMap((name) => {
        const xml = readFileSync(join(UPDATES, name), 'utf8')
        const table = /<record_update table="(\w+)">/.exec(xml)?.[1]
        if (!table) return []
        const record: BuiltRecord = { $table: table }
        for (const [, field = '', attributes = '', value] of xml.matchAll(/^ {4}<(\w+)((?: [^>]*)?)(?:\/>|>([\s\S]*?)<\/\1>)$/gm)) {
            record[field] = unescapeXml(value ?? '')
            // A reference is built as the record's id, with what it names beside it.
            const named = / name="([^"]*)"/.exec(attributes)?.[1]
            if (named !== undefined) record[`${field}.name`] = unescapeXml(named)
        }
        return [record]
    })
    return allRecords
}

const records = (table: string): BuiltRecord[] => builtRecords().filter((record) => record.$table === table)

// Reads every built record from disk: a few hundred milliseconds alone, but seconds while other builds run.
const READS_EVERY_RECORD = 30_000

describe('the built metadata', () => {
    // The SDK evaluates the Fluent sources without running them. A value it cannot read (a function call, an array
    // element, an object where a text is expected) is no build error: the record is built with a placeholder in it.
    // Nor is a computed key ({ [FLEET_FIELD]: true } in an ATF step's field values), built as the text `[FLEET_FIELD]=true`.
    it('holds no value the SDK could not evaluate', () => {
        // The client bundles (sys_ux_lib_asset) are code, which may well hold such a text.
        const placeholders = filesUnder(BUILT)
            .filter((path) => path.endsWith('.xml') && !path.includes('/sys_ux_lib_asset_'))
            .filter((path) => /Symbol\(|\[object Object\]|\[[A-Za-z_]\w*\]=/.test(readFileSync(path, 'utf8')))
            .map((path) => relative(BUILT, path))
        expect(placeholders).toEqual([])
    }, READS_EVERY_RECORD)
})

/*
 * The instance stores a text in a column of fixed length and cuts a longer one off without a warning: the build and
 * the install pass, and the rule list then shows "NaaS - start or stop billing on service " with no way to tell two
 * such rules apart, or a condition that never holds because its script was cut short. The lengths are the instance's
 * (sys_dictionary).
 */
const TEXT_LIMITS: ReadonlyArray<{ table: string; field: string; limit: number }> = [
    { table: 'sys_script', field: 'name', limit: 40 },
    { table: 'sys_ui_action', field: 'name', limit: 40 },
    { table: 'sysevent_script_action', field: 'name', limit: 40 },
    { table: 'sysevent_email_action', field: 'name', limit: 40 },
    { table: 'contract_sla', field: 'name', limit: 40 },
    { table: 'sys_rest_message', field: 'name', limit: 40 },
    { table: 'sys_ws_definition', field: 'name', limit: 40 },
    { table: 'sys_ws_operation', field: 'name', limit: 40 },
    { table: 'sysauto_script', field: 'name', limit: 100 },
    { table: 'sys_properties', field: 'name', limit: 100 },
    { table: 'sysevent_register', field: 'description', limit: 100 },
    { table: 'sys_atf_test', field: 'name', limit: 100 },
    { table: 'sys_atf_test', field: 'description', limit: 1000 },
    // A condition is a script the platform runs as written: one cut off never holds, and its rule or action is gone.
    { table: 'sys_script', field: 'condition', limit: 254 },
    { table: 'sys_ui_action', field: 'condition', limit: 254 },
]

// A generated Billing line is written field by field (platform/billing), so a field its exports name that the table
// lacks is no build error: the instance drops the value.
describe('a Billing line as its exports read it', () => {
    it('names only columns of x_daas_ham_billing_line', () => {
        const prefix = 'sys_dictionary_x_daas_ham_billing_line_'
        const columns = readdirSync(UPDATES)
            .filter((name) => name.startsWith(prefix))
            .map((name) => name.slice(prefix.length, -'.xml'.length))
        const read = new Set<string>()
        const reading = (field: string) => (read.add(field), '')
        billingLineJson('', { value: reading, display: reading })
        billingCsvRow('', { value: reading, display: reading })
        expect(read.size).toBeGreaterThan(5)
        expect(columns).toEqual(expect.arrayContaining([...read]))
    })
})

describe('texts of the built records', () => {
    it('fit the column the instance stores them in', () => {
        const tooLong = TEXT_LIMITS.flatMap(({ table, field, limit }) => {
            const found = records(table)
            expect(found.length, table).toBeGreaterThan(0)
            return found
                .filter((record) => (record[field] ?? '').length > limit)
                .map((record) => `${table}.${field} '${record[field]}' (${(record[field] ?? '').length} > ${limit})`)
        })
        expect(tooLong).toEqual([])
    }, READS_EVERY_RECORD)
})

/** The server module and function a built script calls, from the header the SDK writes on the wrapper it generates. */
function wrapped(script: string): { fn: string; path: string; call: string } | null {
    const header = /^\/\/ @fluent-module (\w+);\w+;(\S+)$/m.exec(script)
    if (!header) return null
    const call = new RegExp(`^${header[1]}\\(([^)]*)\\);?$`, 'm').exec(script)?.[1] ?? ''
    return { fn: header[1] ?? '', path: header[2] ?? '', call }
}

function andTerms(condition: string): string[] {
    const terms: string[] = []
    let depth = 0
    let quote = ''
    let term = ''
    for (let i = 0; i < condition.length; i++) {
        const char = condition[i] ?? ''
        if (quote) {
            if (char === quote) quote = ''
        } else if (char === "'" || char === '"') quote = char
        else if (char === '(') depth++
        else if (char === ')') depth--
        else if (depth === 0 && condition.startsWith('&&', i)) {
            terms.push(term)
            term = ''
            i++
            continue
        }
        term += char
    }
    return [...terms, term].map((found) => found.replace(/\s+/g, ''))
}

describe('scripts wired to server modules', () => {
    const SCRIPTED = ['sys_script', 'sys_ui_action', 'sysevent_script_action', 'sysauto_script', 'sys_ws_operation', 'sys_security_acl']
    const SCRIPT_FIELDS = ['script', 'operation_script', 'post_insert_script']
    const calls = () =>
        SCRIPTED.flatMap((table) => records(table)).flatMap((record) =>
            SCRIPT_FIELDS.flatMap((field) => {
                const call = wrapped(record[field] ?? '')
                return call ? [{ record: `${record.$table} ${record.name ?? record.sys_id}`, ...call }] : []
            }),
        )

    /*
     * The SDK's generated wrapper calls a module entry point with the function's own parameter names (e.g.
     * `sourceOrder(event, current)`), so they must be the globals the platform provides to that script.
     */
    it('call each entry point with the globals the platform provides', () => {
        const PLATFORM_GLOBALS = new Set(['current', 'previous', 'event', 'producer', 'request', 'response'])
        const found = calls()
        expect(found.length).toBeGreaterThan(100)
        const unknown = found.flatMap(({ record, fn, call }) =>
            call
                .split(',')
                .map((argument) => argument.trim())
                .filter((argument) => argument && !PLATFORM_GLOBALS.has(argument))
                .map((argument) => `${record}: ${fn}(${argument})`),
        )
        expect(unknown).toEqual([])
    })
})

/*
 * alm_hardware and wm_order are other scopes' tables: from this scope the platform ignores current.setAbortAction on
 * their records and writes them anyway, so a before rule there refuses with its Abort action, its check being the
 * condition, a script the platform runs as written on every save of the table. A condition loads the module that holds
 * its check by the path the SDK installs it under.
 */

/**
 * The entry points the rules on other scopes' tables call, from their script or their condition, by module (its path
 * under src/server). Each takes its record as a ForeignRecord (platform/records): a GlideRecord without setAbortAction
 * and setWorkflow. Neither it nor a helper it hands the record to can then call one, as the compiler follows the
 * record; an entry point that takes a GlideRecord does not compile here.
 */
const ON_FOREIGN_TABLES = {
    'entry/assets.ts': { clearVoidedWipeEvidence, explainLifecycleRefusal, refusesLifecycleChange },
    'entry/billing.ts': { onAssetServiceChange },
    'entry/delivery.ts': { explainWorkWindowRefusal, refusesWorkWindow },
    'entry/disposal.ts': { onDisposalApprovalDecision },
    'entry/models.ts': { onModelLifecycleChanged },
    'entry/orders.ts': { onAllocatedAssetStageChange, onOrderApprovalDecision },
    'entry/racks.ts': { explainRackRefusal, refusesKeptPlacement, refusesRackPlacement },
    'entry/visibility.ts': { scopeRecords },
    'platform/breakfix.ts': { takeFailedAssetTerms },
    'platform/delivery.ts': { completeInstallOfWork },
    'platform/leases.ts': { giveToLessor },
    'platform/racks.ts': { recheckRacksOf },
    'platform/transfers.ts': { takeBackStageAfterTransfer },
} satisfies Record<string, Record<string, (current: ForeignRecord, previous: ForeignRecord) => unknown>>

describe('business rule conditions', () => {
    const rules = () => records('sys_script')
    const loading = () => rules().filter((rule) => (rule.condition ?? '').includes('require('))
    const modules = () => new Map(records('sys_module').map((module) => [module.path ?? '', module.content ?? '']))

    it('load a module by its installed path and call what it exports', () => {
        expect(loading().length).toBeGreaterThan(0)
        for (const { name, condition } of loading()) {
            for (const [, path, fn] of (condition ?? '').matchAll(/require\('([^']+)'\)\.(\w+)\(/g)) {
                expect(modules().has(path ?? ''), `${name}: ${path}`).toBe(true)
                expect(modules().get(path ?? ''), `${name}: ${fn}`).toMatch(new RegExp(`^export function ${fn}\\(`, 'm'))
            }
        }
    })

    it('load a module only once a field they check has changed', () => {
        for (const { name, condition = '' } of loading()) {
            expect(condition.slice(0, condition.indexOf('require(')), name).toMatch(/\.changes\(\)[\s\S]*&&\s*$/)
        }
    })

    it('are what an aborting rule checks: one without a condition would refuse every save', () => {
        const aborting = rules().filter((rule) => rule.abort_action === 'true')
        expect(aborting.length).toBeGreaterThan(0)
        for (const { name, condition } of aborting) expect(condition, name).toMatch(/require\('[^']+'\)\.\w+\(/)
    })

    it("call only entry points that cannot abort a save on another scope's table, which is left to the rule's Abort action", () => {
        const elsewhere = rules().filter((rule) => !(rule.collection ?? '').startsWith('x_daas_ham_'))
        const entryPoint = (path: string, fn: string) => `${path.split('/src/server/')[1]} ${fn}`
        const called = elsewhere.flatMap((rule) => {
            const script = wrapped(rule.script ?? '')
            // An inline script would be read by no compiler.
            expect(script, rule.name).not.toBeNull()
            const inCondition = [...(rule.condition ?? '').matchAll(/require\('([^']+)'\)\.(\w+)\(/g)]
            return [entryPoint(script?.path ?? '', script?.fn ?? ''), ...inCondition.map(([, path = '', fn = '']) => entryPoint(path, fn))]
        })
        const typed = Object.entries(ON_FOREIGN_TABLES).flatMap(([module, entryPoints]) => Object.keys(entryPoints).map((fn) => `${module} ${fn}`))
        expect([...new Set(called)].sort()).toEqual(typed.sort())
    })

    // alm_hardware also holds the Provider IT's equipment, which the app leaves alone (ADR 0016).
    it('test the Fleet flag right after their change test on alm_hardware, before anything else they check or load', () => {
        const onSaves = rules().filter((rule) => rule.collection === 'alm_hardware' && rule.action_query !== 'true')
        expect(onSaves.length).toBeGreaterThanOrEqual(9)
        for (const { name, condition } of onSaves) {
            const [change, fleet] = andTerms(condition ?? '')
            expect({ name, change: /\.changes\(\)/.test(change ?? '') }).toEqual({ name, change: true })
            expect({ name, fleet }).toEqual({ name, fleet: CURRENT_IS_FLEET.replace(/\s+/g, '') })
        }
    })
})

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

/*
 * The platform tables the app shares with the Provider's IT (ADR 0016) hold its records too. So whatever lists or
 * counts one of them (a navigator module, a workspace list, a dashboard tile) keeps to fleet assets, NaaS Models or
 * NaaS stockrooms in every ^NQ clause of its query, and a picker on one (a reference column of the app's tables, a
 * catalog variable) offers only those: a qualifier only filters what a picker offers, so a column the app itself
 * writes takes one as well.
 */
const SHARED: Readonly<Record<string, string>> = {
    alm_hardware: FLEET_CONDITION,
    cmdb_model: NAAS_MODEL_CONDITION,
    // The platform's Model lifecycle table (ADR 0017) holds the milestones of the Provider IT's Models too.
    cmdb_model_lifecycle: `model.${NAAS_MODEL_CONDITION}`,
    alm_stockroom: NAAS_STOCKROOM_CONDITION,
}

interface SharedQuery {
    what: string
    table: string
    query: string | undefined
}

function dashboardSources(): SharedQuery[] {
    return records('par_dashboard_widget').flatMap((widget) => {
        const props = JSON.parse(widget.component_props || '{}') as {
            dataSources?: Array<{ id?: string; tableOrViewName?: string; filterQuery?: string }>
        }
        return (props.dataSources ?? []).map((source) => ({
            what: `dashboard source ${source.id}`,
            table: source.tableOrViewName ?? '',
            query: source.filterQuery,
        }))
    })
}

/**
 * The encoded query a reference qualifier applies. A `javascript:` one applies the string literal it starts with,
 * followed by a value of the form (such as `current.variables.site`) that completes the literal's last term, which is
 * therefore never a condition; a script of any other shape counts as no query.
 */
function qualifierQuery(qualifier: string): string {
    if (!qualifier.startsWith('javascript:')) return qualifier
    const script = /^javascript:\s*'([^']*)'\s*(\+?)/.exec(qualifier)
    if (!script) return ''
    return script[2] ? `${script[1]}<form value>` : (script[1] ?? '')
}

interface BuiltColumn {
    table: string
    name: string
    indexed: boolean
    [attribute: string]: string | boolean | undefined
}

/** Every column the app declares, on its own tables and on the platform's (dist/app/dictionary, one file per table). */
function builtColumns(): BuiltColumn[] {
    return filesUnder(join(BUILT, 'dictionary')).flatMap((path) => {
        const xml = readFileSync(path, 'utf8')
        const table = /<element name="(\w+)" type="collection"/.exec(xml)?.[1] ?? relative(BUILT, path)
        return [...xml.matchAll(/<element name="(\w+)" type="(?!collection)([^>]*)>/g)].map(([, name = '', attributes = '']) => ({
            ...Object.fromEntries([...` type="${attributes}`.matchAll(/ (\w+)="([^"]*)"/g)].map(([, key, value = '']) => [key, unescapeXml(value)])),
            table,
            name,
            indexed: new RegExp(`<index[^>]*>\\s*<element name="${name}"/>`).test(xml),
        }))
    })
}

function references(): SharedQuery[] {
    const columns = builtColumns().flatMap((column) => {
        if (typeof column.reference !== 'string') return []
        const qualifier = column.reference_qual
        return [{ what: `${column.table}.${column.name}`, table: column.reference, query: typeof qualifier === 'string' ? qualifier : undefined }]
    })
    const variables = records('item_option_new').map((variable) => ({
        what: `catalog variable ${variable.name}`,
        table: variable.reference || variable.list_table || variable.lookup_table || '',
        query: variable.reference_qual_condition || variable.reference_qual || undefined,
    }))
    return [...columns, ...variables].map((found) => ({ ...found, query: found.query === undefined ? undefined : qualifierQuery(found.query) }))
}

describe('what the metadata reads of the tables shared with the Provider IT', () => {
    const outside = (found: SharedQuery[]) =>
        found
            .filter(({ table }) => table in SHARED)
            .filter(({ table, query }) => !holdsInEveryClause(query ?? '', SHARED[table] ?? ''))
            .map(({ what, table, query }) => `${what} (${table}): ${query === undefined ? 'no query' : `'${query}'`}`)
    const onShared = (found: SharedQuery[]) => found.filter(({ table }) => table in SHARED).map(({ what }) => what)

    it('lists fleet assets, NaaS Models and NaaS stockrooms only, in the navigator and the workspace', () => {
        // A module's `name` is the table it opens: one on a shared table with no filter would open it whole.
        const modules = records('sys_app_module').map((module) => ({ what: `module ${module.title}`, table: module.name ?? '', query: module.filter }))
        const lists = records('sys_ux_list').map((list) => ({ what: `workspace list ${list.title}`, table: list.table ?? '', query: list.condition }))
        expect(onShared(modules).length).toBeGreaterThanOrEqual(4)
        expect(onShared(lists).length).toBeGreaterThanOrEqual(10)
        expect(outside([...modules, ...lists])).toEqual([])
    })

    it('counts fleet assets only on the dashboard', () => {
        expect(onShared(dashboardSources()).length).toBeGreaterThanOrEqual(7)
        expect(outside(dashboardSources())).toEqual([])
    })

    it('offers fleet assets, NaaS Models and NaaS stockrooms only in the pickers of the app’s tables and catalog items', () => {
        expect(onShared(references())).toEqual(
            expect.arrayContaining([
                'x_daas_ham_order_line.replaces_asset',
                'x_daas_ham_oem_rma.defective_asset',
                'sn_customerservice_case.x_daas_ham_failed_asset',
                'x_daas_ham_site_template_item.model',
                'cmdb_model.x_daas_ham_normalized_to',
                'x_daas_ham_audit.stockroom',
                'x_daas_ham_shipment.stockroom',
                'catalog variable model',
                'catalog variable assets',
            ]),
        )
        expect(outside(references())).toEqual([])
    })
})

describe('the columns the app adds to the shared tables', () => {
    const column = (table: string, name: string) => builtColumns().find((found) => found.table === table && found.name === name)

    it('flag an Asset as outside the fleet until the app takes it in: default false, read-only and indexed', () => {
        expect(column('alm_hardware', FLEET_FIELD)).toMatchObject({ type: 'boolean', default_value: 'false', read_only: 'true', indexed: true })
    })

    it('stamp no NaaS value on the rows the Provider IT creates', () => {
        expect(column('alm_hardware', 'x_daas_ham_legal_owner')).toMatchObject({ type: 'choice' })
        expect(column('alm_hardware', 'x_daas_ham_legal_owner')?.default_value).toBeUndefined()
        expect(column('alm_stockroom', STOCKROOM_TYPE_FIELD)).toMatchObject({ type: 'choice' })
        expect(column('alm_stockroom', STOCKROOM_TYPE_FIELD)?.default_value).toBeUndefined()
        expect(column('cmdb_model', OEM_PID_FIELD)).toMatchObject({ type: 'string' })
        expect(column('cmdb_model', OEM_PID_FIELD)?.default_value).toBeUndefined()
    })
})

describe('the Job lock name column', () => {
    it('holds a name as long as the server code cuts lock names to: one the instance cut shorter would be another lock', () => {
        const name = builtColumns().find((column) => column.table === 'x_daas_ham_job_lock' && column.name === 'name')
        expect(Number(name?.max_length)).toBeGreaterThanOrEqual(LOCK_NAME_LENGTH)
    })
})

/*
 * A form or a list names its fields as texts, which the build takes as they are: one that is on no table of the record
 * leaves a gap in the form and a blank column in the list, on the instance only; a record producer's variable mapped to
 * one writes nothing. The columns of the app's tables, and those it adds to the platform's, are read from the built
 * dictionary; those of a platform table from the definition the SDK ships for it, which the build checks an index's
 * columns against.
 */
describe('fields the forms, lists and record producers name', () => {
    const SDK_TABLES = join(ROOT, 'node_modules/@servicenow/sdk-core/src/fluent/tables')
    /** The columns the app shows of a platform table the SDK has no definition of: the Model lifecycle table (ADR 0017). */
    const UNDEFINED_BY_SDK: Readonly<Record<string, readonly string[]>> = {
        cmdb_model_lifecycle: ['model', 'lifecycle_phase', 'start_date', 'source', 'description'],
    }

    interface Shown {
        where: string
        table: string
        field: string
    }

    let builtDictionary: { columns: Map<string, Set<string>>; parents: Map<string, string> } | undefined

    function dictionary() {
        if (builtDictionary) return builtDictionary
        const columns = new Map<string, Set<string>>()
        for (const column of builtColumns()) columns.set(column.table, (columns.get(column.table) ?? new Set()).add(column.name))
        const parents = new Map(records('sys_db_object').map((table) => [table.name ?? '', table['super_class.name'] ?? '']))
        return (builtDictionary = { columns, parents })
    }

    function sdkTable(table: string): { columns: Set<string>; parent: string } | null {
        const path = join(SDK_TABLES, `${table}.now.ts`)
        if (!existsSync(path)) return null
        const source = readFileSync(path, 'utf8')
        return {
            columns: new Set([...source.matchAll(/^ {8}(\w+): \w+\(/gm)].map(([, column = '']) => column)),
            parent: /^ {4}extends: '(\w+)'/m.exec(source)?.[1] ?? '',
        }
    }

    /** Every table has the platform's sys_ columns. */
    function hasColumn(table: string, column: string): boolean {
        if (column.startsWith('sys_') || dictionary().columns.get(table)?.has(column) || UNDEFINED_BY_SDK[table]?.includes(column)) return true
        const sdk = sdkTable(table)
        if (sdk?.columns.has(column)) return true
        const parent = dictionary().parents.get(table) || sdk?.parent
        return parent ? hasColumn(parent, column) : false
    }

    /** The elements of the files the build writes one form section or one list in (`<sys_ui_section>`, `<sys_ui_list>`). */
    function elementsOf(prefix: string, tag: string): Array<{ table: string; element: string; type: string }> {
        return readdirSync(UPDATES)
            .filter((name) => name.startsWith(prefix))
            .flatMap((name) => {
                const xml = readFileSync(join(UPDATES, name), 'utf8')
                const table = new RegExp(`<${prefix.slice(0, -1)} [^>]*table="(\\w+)"`).exec(xml)?.[1] ?? name
                return [...xml.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'g'))].map(([, body = '']) => ({
                    table,
                    element: /<element>([^<]*)<\/element>/.exec(body)?.[1] ?? '',
                    type: /<type>([^<]*)<\/type>/.exec(body)?.[1] ?? '',
                }))
            })
    }

    function shown(): Shown[] {
        const onForms = elementsOf('sys_ui_section_', 'sys_ui_element').flatMap(({ table, element, type }): Shown[] => {
            // A related list is named 12M.<table>.<listed table>.<its reference to the table>.
            if (type === 'list') return [{ where: `form ${table}`, table: element.split('.')[2] ?? '', field: element.split('.')[3] ?? '' }]
            // Formatters and the splits of a two-column layout are no fields.
            return type ? [] : [{ where: `form ${table}`, table, field: element }]
        })
        const onLists = elementsOf('sys_ui_list_', 'sys_ui_list_element').map(({ table, element }) => ({ where: `list ${table}`, table, field: element }))
        const onWorkspaceLists = records('sys_ux_list').flatMap((list) =>
            (list.columns ?? '').split(',').map((field) => ({ where: `workspace list ${list.title}`, table: list.table ?? '', field })),
        )
        // A record producer's variable writes the column it maps to.
        const mappedByVariables = records('item_option_new')
            .filter((variable) => variable.map_to_field === 'true')
            .map((variable) => ({ where: `catalog variable ${variable.name}`, table: variable.record_producer_table ?? '', field: variable.field ?? '' }))
        return [...onForms, ...onLists, ...onWorkspaceLists, ...mappedByVariables]
    }

    it('are columns of the table, or of one it extends: of a dot-walked field, the reference it starts from', () => {
        expect(shown().length).toBeGreaterThan(800)
        const missing = shown()
            .filter(({ table, field }) => !hasColumn(table, field.split('.')[0] ?? ''))
            .map(({ where, table, field }) => `${where}: ${table}.${field}`)
        expect(missing).toEqual([])
    })
})

/*
 * A UI action's condition is a script in the metadata, so one that offers the action exactly where a rule of the
 * server code allows it is that rule written a second time, from the same named values. The built condition is run
 * here against each value and held to the rule.
 */
describe('UI action and business rule conditions that restate a rule of the server code', () => {
    const conditionOf = (actionName: string): string => {
        const action = records('sys_ui_action').find((found) => found.action_name === actionName)
        expect(action?.condition, actionName).toBeTruthy()
        return action?.condition ?? ''
    }
    const holds = (condition: string, current: Record<string, unknown>) => new Function('current', `return ${condition}`)(current) as boolean
    const orderStages = Object.keys(ORDER_STAGE_CHOICES) as OrderStage[]

    it('offer Cancel order in the cancellable stages', () => {
        const condition = conditionOf('x_daas_ham_cancel_order')
        expect(orderStages.filter((stage) => holds(condition, { stage }))).toEqual(CANCELLABLE_ORDER_STAGES)
    })

    it('offer Raise replacement while no replacement goes ahead for the case', () => {
        const condition = conditionOf('x_daas_ham_raise_replacement')
        const caseWith = (replacement: unknown) => ({ x_daas_ham_failed_asset: 'a1', active: true, x_daas_ham_replacement_order: replacement })
        expect(holds(condition, caseWith(''))).toBe(replacementStep(null) === 'raise')
        for (const stage of orderStages) expect({ stage, offered: holds(condition, caseWith({ stage })) }).toEqual({ stage, offered: replacementStep(stage) === 'raise' })
        expect(holds(condition, { ...caseWith(''), active: false })).toBe(false)
        expect(holds(condition, { ...caseWith(''), x_daas_ham_failed_asset: '' })).toBe(false)
    })

    it('offer Defective returned to OEM on the RMAs open with the OEM', () => {
        const condition = conditionOf('x_daas_ham_rma_defective_returned')
        const states = Object.keys(RMA_STATE_CHOICES) as RmaState[]
        expect(states.filter((state) => holds(condition, { state }))).toEqual(RMA_AT_OEM)
    })

    it('offer Mark label voided on return and outbound Shipments alike, in the statuses labelVoidable allows', () => {
        const condition = conditionOf('x_daas_ham_mark_label_voided')
        const statuses = Object.keys(SHIPMENT_STATUS_CHOICES) as ShipmentStatus[]
        for (const direction of Object.keys(SHIPMENT_DIRECTION_CHOICES)) {
            expect({ direction, statuses: statuses.filter((status) => holds(condition, { direction, status })) }).toEqual({
                direction,
                statuses: statuses.filter(labelVoidable),
            })
        }
        expect(statuses.filter((status) => holds(condition, { direction: '', status }))).toEqual([])
    })

    it('run the Staging task closure rules on the states stagingClosing closes a task with', () => {
        const ruleConditionOf = (name: string): string => {
            const rule = records('sys_script').find((found) => found.name === name)
            expect(rule?.condition, name).toBeTruthy()
            return rule?.condition ?? ''
        }
        const states = Object.values(TASK_STATE).map(String)
        const saved = (state: string, changed: boolean) => ({ state: { changes: () => changed, toString: () => state } })
        const firing = (name: string) => {
            const condition = ruleConditionOf(name)
            expect(states.filter((state) => holds(condition, saved(state, false))), name).toEqual([])
            return states.filter((state) => holds(condition, saved(state, true)))
        }
        expect(firing('NaaS - staging steps done before close')).toEqual(states.filter((state) => stagingClosing(state) !== null))
        expect(firing('NaaS - staged asset on staging closure')).toEqual(states.filter((state) => stagingClosing(state) === 'complete'))
    })
})

/*
 * The platform serves a custom scoped app's workspace under x/<vendor>/<path> and names its route ACLs
 * x.<vendor>.<path>.<route>, the vendor being the second part of the scope (x_daas_ham: daas). The SDK's workspace
 * guide says now/<path>: a now/ link is "Page not found", and a now. route ACL guards nothing.
 */
describe('NaaS Asset Workspace URL', () => {
    const scope = (JSON.parse(readFileSync(join(ROOT, 'now.config.json'), 'utf8')) as { scope: string }).scope
    const vendor = /^x_([a-z0-9]+)_/.exec(scope)?.[1]
    const path = () => records('sys_ux_page_registry').find((registry) => registry.title === 'NaaS Asset Workspace')?.path

    it("names the route ACL after the workspace's routes", () => {
        expect(path()).toBeTruthy()
        expect(records('sys_security_acl').map((acl) => acl.name)).toContain(`x.${vendor}.${path()}.*`)
    })
})

/*
 * What a reader may see is decided in one place (domain/visibility SCOPED_TABLES, tested in visibility.test.ts) and
 * reached through the scripts of entry/visibility (`scopeRecords`, `readsRecord`, `grantsCustomerRecord`, and
 * `grantsFleetAsset` for hardware), each of which finds the table of the record it is handed. What code cannot say is
 * which records call them: that is read here, from the built rules and ACLs. A before-query rule (ADR 0005) narrows
 * lists, but a record reached another way (a dot-walk from a visible record, an `^NQ` clause the rule's filter does not
 * reach, or a table with no rule) is guarded only by its read ACL.
 */
interface BuiltAcl {
    table: string
    field: string
    records: string
    operation: string
    deny: boolean
    roles: string[]
    appliesTo: string
    condition: string
    script: string
}

function aclRoles(): Map<string, string[]> {
    const rolesOf = new Map<string, string[]>()
    for (const grant of records('sys_security_acl_role')) {
        rolesOf.set(grant.sys_security_acl ?? '', [...(rolesOf.get(grant.sys_security_acl ?? '') ?? []), grant['sys_user_role.name'] ?? ''])
    }
    return rolesOf
}

/** The app's ACLs on records and on their fields (a field ACL is built under the name `<table>.<field>`). */
function builtAcls(): BuiltAcl[] {
    const rolesOf = aclRoles()
    return records('sys_security_acl')
        .filter((acl) => acl.type === 'record')
        .map((acl) => {
            const [table = '', field = ''] = (acl.name ?? '').split('.')
            return {
                table,
                field,
                records: /^sys_class_name=(\w+)$/.exec(acl.applies_to ?? '')?.[1] ?? table,
                operation: acl.operation ?? '',
                deny: acl.decision_type === 'deny',
                roles: rolesOf.get(acl.sys_id ?? '') ?? [],
                appliesTo: acl.applies_to ?? '',
                condition: acl.condition ?? '',
                script: wrapped(acl.script ?? '')?.fn ?? (acl.script ? 'inline' : ''),
            }
        })
}

const recordAcls = (): BuiltAcl[] => builtAcls().filter((acl) => !acl.field)

const isCustomerRole = (role: string) => role === ROLE.customerAdmin || role === ROLE.siteContact
/**
 * Every provider-staff role, sorted: domain/roles PROVIDER_STAFF, the one list shared/roles.now.ts
 * `providerStaff` and the rack page (which links a device to its Asset form for these roles only) both are. The checks
 * below hold the built ACLs, audience and dashboard to it, so a role the metadata admits is one the page links for.
 */
const PROVIDER_STAFF = [...PROVIDER_STAFF_IN_ORDER].sort()
const MONEY_READERS = [...MONEY_READERS_IN_ORDER].sort()

describe('the Return write ACL', () => {
    const writers = (table: string) =>
        recordAcls()
            .filter((acl) => acl.table === table && acl.operation === 'write')
            .map((acl) => [...acl.roles].sort())

    it('grants the Order workers but the service desk, which raises Returns and works none', () => {
        expect(writers('x_daas_ham_order')).toHaveLength(1)
        const [orderWorkers = []] = writers('x_daas_ham_order')
        expect(orderWorkers).toContain(PLATFORM_ROLE.serviceDeskAgent)
        expect(writers('x_daas_ham_return_order')).toEqual([orderWorkers.filter((role) => role !== PLATFORM_ROLE.serviceDeskAgent)])
    })
})

describe('the rules and ACLs that scope what a reader sees', () => {
    const SCOPINGS: Readonly<Record<string, TableScoping>> = SCOPED_TABLES
    const scopedTables = Object.keys(SCOPINGS)
    const reads = () => recordAcls().filter((acl) => acl.operation === 'read')
    const rules = () =>
        records('sys_script')
            .filter((rule) => rule.action_query === 'true')
            .map((rule) => ({ table: rule.collection ?? '', script: wrapped(rule.script ?? '')?.fn ?? '' }))
    const ruledTables = () => rules().map((rule) => rule.table)

    describe('before-query rules', () => {
        it('run the one script, each on a table that has a scoping for it to find', () => {
            expect(rules().length).toBeGreaterThan(0)
            for (const rule of rules()) {
                expect(rule.script, rule.table).toBe('scopeRecords')
                expect(scopedTables, rule.table).toContain(rule.table)
            }
            expect(new Set(ruledTables()).size).toBe(ruledTables().length)
        })

        it('narrow every scoped table but the lines and Site templates, which their read ACL alone guards', () => {
            expect(scopedTables.filter((table) => !ruledTables().includes(table)).sort()).toEqual([
                'x_daas_ham_attestation_item',
                'x_daas_ham_return_order_line',
                'x_daas_ham_shipment_event',
                'x_daas_ham_site_template',
                'x_daas_ham_site_template_item',
            ])
        })
    })

    describe('row checks of the read ACLs', () => {
        const rowChecks = () => reads().filter((acl) => acl.deny)
        const stockroomScoped = scopedTables.filter((table) => SCOPINGS[table]?.stockroom)

        it('deny, on each table the rules narrow to stockrooms, what its rule would hide', () => {
            expect(stockroomScoped).toContain('alm_hardware')
            expect(rowChecks().map((acl) => acl.records).sort()).toEqual([...stockroomScoped].sort())
            for (const table of stockroomScoped) expect(ruledTables(), table).toContain(table)
            for (const acl of rowChecks()) expect(acl.script, acl.records).toBe('readsRecord')
        })

        it('take no role: every reader passes them, as the rules narrow whoever reads', () => {
            for (const acl of rowChecks()) expect(acl.roles, acl.records).toEqual([])
        })

        it('apply to every record of their table: the script, not Applies To, tells what a reader leaves to the platform', () => {
            for (const acl of rowChecks().filter((acl) => acl.table === acl.records)) expect(acl.appliesTo, acl.table).toBe('')
        })
    })

    describe('read ACLs for Customer contacts', () => {
        const contactReads = () => reads().filter((acl) => !acl.deny && acl.roles.some(isCustomerRole))

        it('cover the tables a Customer contact reads', () => {
            expect(contactReads().map((acl) => acl.records).sort()).toEqual(
                expect.arrayContaining(['alm_hardware', 'x_daas_ham_order', 'x_daas_ham_order_line', 'x_daas_ham_return_order', 'x_daas_ham_shipment']),
            )
        })

        it('grant a record only through the shared decision: no ACL lets a contact in without it, or decides for itself', () => {
            for (const acl of contactReads()) {
                expect(acl.script, acl.records).toBe(acl.records === 'alm_hardware' ? 'grantsFleetAsset' : 'grantsCustomerRecord')
            }
            expect(builtAcls().filter((acl) => acl.script === 'inline')).toEqual([])
        })

        it('sit on a scoped table with a Customer field, and with a Site field where they admit site contacts', () => {
            for (const acl of contactReads()) {
                expect(SCOPINGS[acl.records]?.customer, acl.records).toBeTruthy()
                if (acl.roles.includes(ROLE.siteContact)) expect(SCOPINGS[acl.records]?.site, acl.records).toBeTruthy()
            }
        })

        it('are the only check on a scoped table with no before-query rule, so each of those has one', () => {
            const granted = contactReads().map((acl) => acl.records)
            for (const table of scopedTables.filter((table) => !ruledTables().includes(table))) expect(granted, table).toContain(table)
        })
    })

    describe('ACLs on the hardware the app shares with the Provider IT', () => {
        const hardware = () => recordAcls().filter((acl) => acl.records === 'alm_hardware')
        const onParent = () => builtAcls().filter((acl) => acl.table === 'alm_asset')
        /** The scripts of entry/visibility that pass an Asset of another class first (entry/visibility.test.ts holds each to it). */
        const CLASS_CHECKED = ['readsRecord', 'grantsFleetAsset', 'writesAsset', 'deletesAsset', 'writesAssetCommercialField', 'readsAssetCost']

        it("sit on alm_asset, so alm_hardware inherits the platform's record ACLs there and an alm_asset list is checked too", () => {
            expect(recordAcls().filter((acl) => acl.table === 'alm_hardware')).toEqual([])
            expect(hardware().length).toBeGreaterThanOrEqual(5)
            for (const acl of hardware()) expect(acl.table, `${acl.operation} ${acl.roles}`).toBe('alm_asset')
            expect(onParent().filter((acl) => acl.records !== 'alm_hardware')).toEqual([])
        })

        it('check the class again in their script, in case Applies To is not applied', () => {
            for (const acl of onParent().filter((acl) => acl.deny || !acl.field)) {
                expect(CLASS_CHECKED, `${acl.operation} ${acl.field} ${acl.roles}`).toContain(acl.script)
            }
        })

        it('grant only fleet assets: the Allow-If ones leave other hardware to the platform', () => {
            for (const acl of hardware().filter((acl) => !acl.deny)) expect(acl.script, `${acl.roles}`).toBe('grantsFleetAsset')
        })
    })

    describe('ACLs on changes to hardware by hand', () => {
        const onParent = (operation: string, field = '') =>
            builtAcls().filter((acl) => acl.table === 'alm_asset' && acl.operation === operation && acl.field === field)
        const denyScript = (operation: string, field = '') =>
            onParent(operation, field)
                .filter((acl) => acl.deny)
                .map((acl) => acl.script)

        it("check, beside the platform's asset-role ACLs, who saves and deletes a fleet asset", () => {
            expect(denyScript('write')).toEqual(['writesAsset'])
            expect(denyScript('delete')).toEqual(['deletesAsset'])
            for (const acl of onParent('write').concat(onParent('delete'))) expect(acl.roles, acl.operation).toEqual([])
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
            const denied = builtAcls().filter((acl) => acl.deny && acl.field)
            expect(denied.length).toBeGreaterThan(0)
            for (const acl of denied) {
                const level = `${acl.table}.${acl.field} ${acl.operation}`
                const ours = builtAcls().filter(
                    (other) => !other.deny && other.table === acl.table && other.field === acl.field && other.operation === acl.operation,
                )
                expect(PLATFORM_ALLOW_IF.includes(level) || ours.length > 0, level).toBe(true)
            }
            const costWrite = onParent('write', 'cost').filter((acl) => !acl.deny)
            expect(costWrite.map((acl) => [acl.roles, acl.condition, acl.appliesTo])).toEqual([[['snc_internal'], 'install_status!=10', 'sys_class_name=alm_hardware']])
        })

        // An Asset's Lessor is its lease's Vendor (ADR 0018): it has no column of its own to guard.
        it("leave the app's own Customer and ownership columns on hardware to asset managers, and its Fleet flag to admins", () => {
            const writers = (field: string) => builtAcls().filter((acl) => acl.table === 'alm_hardware' && acl.field === field && acl.operation === 'write')
            for (const field of ['x_daas_ham_agreement', 'x_daas_ham_subscription_line', 'x_daas_ham_lease', 'x_daas_ham_legal_owner']) {
                expect(writers(field).map((acl) => [acl.roles, acl.deny]), field).toEqual([[[ROLE.assetManager], false]])
            }
            expect(writers(FLEET_FIELD).map((acl) => acl.roles)).toEqual([[ROLE.admin]])
            expect(
                builtAcls()
                    .filter((acl) => acl.field === FLEET_FIELD && acl.operation === 'create')
                    .map((acl) => acl.roles),
            ).toEqual([[ROLE.admin]])
        })
    })

    describe("ACLs on the Provider's own fields of records a Customer contact reads", () => {
        const fieldReaders = (table: string, field: string) =>
            builtAcls().filter((acl) => acl.table === table && acl.field === field && acl.operation === 'read' && !acl.deny)

        it('grant them to provider staff, which holds no customer role, so the record a contact reads comes without them', () => {
            const fields: Array<[string, string]> = [
                ['alm_hardware', 'x_daas_ham_support_cost'],
                ['alm_hardware', 'x_daas_ham_claim_code'],
                ['alm_hardware', 'x_daas_ham_lease'],
                ['x_daas_ham_shipment', 'cost'],
            ]
            for (const [table, field] of fields) {
                expect(
                    fieldReaders(table, field).map((acl) => [...acl.roles].sort()),
                    `${table}.${field}`,
                ).toEqual([PROVIDER_STAFF])
            }
            expect(PROVIDER_STAFF.filter(isCustomerRole)).toEqual([])
        })
    })

    describe('create ACLs of Orders, Order lines and Returns', () => {
        const creators = (table: string) => recordAcls().filter((acl) => acl.table === table && acl.operation === 'create')
        const forCustomer = (table: string) => creators(table).filter((acl) => acl.roles.some(isCustomerRole))
        const forStaff = (table: string) => creators(table).filter((acl) => !acl.roles.some(isCustomerRole))

        it('give a customer admin no Order lines: the record producer adds them past the ACLs (platform/orders)', () => {
            expect(forCustomer('x_daas_ham_order_line')).toEqual([])
            expect(forStaff('x_daas_ham_order_line')).toHaveLength(1)
            const raisers = (table: string) => forStaff(table).map((acl) => [...acl.roles].sort())
            expect(raisers('x_daas_ham_order_line')).toEqual(raisers('x_daas_ham_order'))
        })

        it('let a customer admin create an Order only of their own Customer, and a Return of theirs or of none yet', () => {
            const grant = (table: string) => forCustomer(table).map((acl) => [acl.roles, acl.script])
            expect(grant('x_daas_ham_order')).toEqual([[[ROLE.customerAdmin], 'grantsCustomerRecord']])
            expect(grant('x_daas_ham_return_order')).toEqual([[[ROLE.customerAdmin], 'createsCustomerReturn']])
        })
    })

    describe('read ACLs of the service desk', () => {
        it('cover the tables of the Orders and Returns it raises, and no other', () => {
            const read = reads().filter((acl) => !acl.deny && acl.roles.includes(PLATFORM_ROLE.serviceDeskAgent))
            expect(read.map((acl) => acl.table).sort()).toEqual(
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
            for (const acl of read) expect([acl.roles, acl.script], acl.table).toEqual([[PLATFORM_ROLE.serviceDeskAgent], ''])
            for (const table of ['x_daas_ham_order', 'x_daas_ham_return_order']) {
                const raisers = recordAcls()
                    .filter((acl) => acl.table === table && acl.operation === 'create')
                    .flatMap((acl) => acl.roles)
                expect(raisers, table).toContain(PLATFORM_ROLE.serviceDeskAgent)
            }
        })
    })

    describe('read ACLs for inventory techs', () => {
        /**
         * The app tables an inventory tech with no broader role may read: the Assets, Staging tasks and Audits of their
         * Stockrooms, and the ASN imports, Staging steps and templates, Orders, Shipments, Return orders, OEM RMAs and
         * Disposal orders they work on, which are not narrowed to their Stockrooms. Every other table's read ACL leaves
         * inventory techs out: the before-query rules do not hide those from them (ADR 0005).
         */
        const INVENTORY_TECH_TABLES = [
            'alm_hardware',
            'x_daas_ham_asn_import',
            'x_daas_ham_staging_task',
            'x_daas_ham_staging_step',
            'x_daas_ham_staging_template',
            'x_daas_ham_staging_tmpl_item',
            'x_daas_ham_order',
            'x_daas_ham_order_line',
            'x_daas_ham_shipment',
            'x_daas_ham_shipment_event',
            'x_daas_ham_return_order',
            'x_daas_ham_return_order_line',
            'x_daas_ham_audit',
            'x_daas_ham_audit_line',
            'x_daas_ham_oem_rma',
            'x_daas_ham_disposal_order',
            'x_daas_ham_disposal_line',
        ]
        const heldByTech = () =>
            new Set([
                ROLE.inventoryTech,
                ...records('sys_user_role_contains')
                    .filter((link) => link['role.name'] === ROLE.inventoryTech)
                    .map((link) => link['contains.name'] ?? ''),
            ])
        // A Deny-Unless ACL (the row checks) grants nothing: it only takes access away.
        const grants = () => reads().filter((acl) => !acl.deny)
        const readableByTech = () => [...new Set(grants().filter((acl) => acl.roles.some((role) => heldByTech().has(role))).map((acl) => acl.records))]

        it('let an inventory tech read exactly the tables of their stockroom work', () => {
            expect(heldByTech()).toContain(PLATFORM_ROLE.inventoryUser)
            expect(readableByTech().sort()).toEqual([...INVENTORY_TECH_TABLES].sort())
        })

        it('close customer, commercial and configuration tables to an inventory tech with no broader role', () => {
            const closedToTech = [...new Set(grants().map((acl) => acl.records))].filter((table) => !readableByTech().includes(table))
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
                ]),
            )
        })
    })
})

/*
 * A role group is one list of names (shared/roles.now.ts). A workspace audience stores role ids, so it is built from
 * the same roles as records: each audience must name the roles of its group.
 */
describe('workspace audiences', () => {
    const roleNames = () => new Map(records('sys_user_role').map((role) => [role.sys_id ?? '', role.name ?? '']))
    const audience = (name: string) =>
        (records('sys_ux_applicability').find((found) => found.name === name)?.roles ?? '').split(',').map((id) => roleNames().get(id) ?? id)
    const grantedOn = (table: string, operation: string) =>
        recordAcls()
            .filter((acl) => acl.table === table && acl.operation === operation && !acl.deny)
            .flatMap((acl) => acl.roles)

    it('are the role groups the navigator and the ACLs name', () => {
        const workspaceModule = records('sys_app_module').find((module) => module.title === 'NaaS Asset Workspace')
        expect(audience('NaaS provider staff')).toEqual(workspaceModule?.roles?.split(','))
        expect(audience('NaaS provider staff')).toEqual(PROVIDER_STAFF_IN_ORDER)
        expect(audience('NaaS provider staff except inventory techs')).toEqual(BROAD_STAFF)
        expect(audience('NaaS billing and margin readers').sort()).toEqual(grantedOn('x_daas_ham_margin', 'read').sort())
    })
})

describe('the NaaS dashboard', () => {
    const readsOf = (table: string) => recordAcls().filter((acl) => acl.records === table && acl.operation === 'read' && !acl.deny)

    it("is read by the workspace's roles, so the NOC and the techs keep its Operations, Billing and Lifecycle tabs", () => {
        const path = records('sys_ux_page_registry').find((registry) => registry.title === 'NaaS Asset Workspace')?.path
        const route = records('sys_security_acl').filter((acl) => (acl.name ?? '').endsWith(`.${path}.*`))
        const permissions = records('par_dashboard_permission')
        expect(route.map((acl) => [...(aclRoles().get(acl.sys_id ?? '') ?? [])].sort())).toEqual([PROVIDER_STAFF])
        expect(permissions.map((permission) => permission['role.name']).sort()).toEqual(PROVIDER_STAFF)
        for (const permission of permissions) {
            expect([permission.can_read, permission.can_write, permission.can_share, permission.owner], permission['role.name']).toEqual([
                'true',
                'false',
                'false',
                'false',
            ])
        }
    })

    it("leaves each widget's data to its table's read ACL: the Margin tab's to the money readers", () => {
        const tables = [...new Set(dashboardSources().map((source) => source.table))]
        expect(tables).toEqual(expect.arrayContaining(['alm_hardware', 'x_daas_ham_margin', 'x_daas_ham_cost_fact']))
        for (const table of tables) expect(readsOf(table).length, table).toBeGreaterThan(0)
        for (const table of ['x_daas_ham_margin', 'x_daas_ham_cost_fact']) {
            expect(readsOf(table).map((acl) => [...acl.roles].sort()), table).toEqual([MONEY_READERS])
        }
    })
})

/*
 * domain/events EVENT is the one list of the app's events. An event the metadata does not register is dropped by the
 * platform when it is queued, and one nothing answers does nothing: both pass the build.
 */
describe('events', () => {
    const scope = (JSON.parse(readFileSync(join(ROOT, 'now.config.json'), 'utf8')) as { scope: string }).scope
    const registered = () => records('sysevent_register')

    it('are registered, each once, under the name the server code fires it by', () => {
        expect(registered().map((event) => event.event_name).sort()).toEqual(Object.values(EVENT).sort())
        for (const event of registered()) expect(event.event_name).toBe(`${scope}.${event.suffix}`)
    })

    it('are each answered by a script action or a notification, which answer no other event', () => {
        const answered = [...records('sysevent_script_action'), ...records('sysevent_email_action')].map((action) => action.event_name ?? '')
        expect([...new Set(answered)].sort()).toEqual(Object.values(EVENT).sort())
    })
})

/*
 * domain/properties PROPERTY is the one list of the app's system properties. A property the server code reads but
 * the metadata does not declare exists on no instance, and one declared with another value than the reader falls back
 * to behaves differently once an administrator clears it.
 */
describe('system properties', () => {
    type Entry = PropertyOf<string | number | boolean>
    const isEntry = (value: object): value is Entry => 'name' in value && 'default' in value
    const entries: Entry[] = Object.values(PROPERTY).flatMap((value) => (isEntry(value) ? [value] : Object.values(value)))

    it('are declared, each once, with the value the server code falls back to', () => {
        const declared = records('sys_properties').map((property) => ({ name: property.name, value: property.value }))
        const expected = entries.map((entry) => ({ name: entry.name, value: String(entry.default) }))
        const byName = (a: { name?: string }, b: { name?: string }) => (a.name ?? '').localeCompare(b.name ?? '')
        expect(declared.sort(byName)).toEqual(expected.sort(byName))
    })

    it('are of the type their value has', () => {
        const typeOf = new Map(records('sys_properties').map((property) => [property.name ?? '', property.type ?? '']))
        for (const entry of entries) {
            const types = typeof entry.default === 'number' ? ['integer'] : typeof entry.default === 'boolean' ? ['boolean'] : ['string', 'password2']
            expect(types, entry.name).toContain(typeOf.get(entry.name))
        }
    })
})

/*
 * domain/rest-message-names REST_MESSAGE and domain/shipping SHIPPING_MESSAGE list the app's REST messages and their
 * functions. An adapter that calls a function its message does not have gets no answer from RESTMessageV2, on the
 * instance only.
 */
describe('REST messages', () => {
    it('are built with the names and the functions the adapters call them by', () => {
        const messageName = new Map(records('sys_rest_message').map((message) => [message.sys_id ?? '', message.name ?? '']))
        const built = [...messageName.values()].sort().map((name) => ({
            name,
            functions: records('sys_rest_message_fn')
                .filter((fn) => messageName.get(fn.rest_message ?? '') === name)
                .map((fn) => fn.function_name ?? '')
                .sort(),
        }))
        const named = [...Object.values(REST_MESSAGE), SHIPPING_MESSAGE]
            .map((message) => ({ name: message.name as string, functions: (Object.values(message.fn) as string[]).sort() }))
            .sort((a, b) => a.name.localeCompare(b.name))
        expect(built).toEqual(named)
    })

    /*
     * A function names what is put into it at call time as ${variable}, in its endpoint, its headers and its content,
     * and declares each as a variable; the server code sets them by name (the adapters a request's own, platform/
     * rest-messages a message's secrets and settings). RESTMessageV2 sends a ${variable} nobody set as it stands, to
     * the vendor.
     */
    interface BuiltFunction {
        message: string
        fn: string
        used: string[]
        declared: string[]
    }

    const named = (text: string) => [...text.matchAll(/\$\{(\w+)\}/g)].map(([, variable = '']) => variable)
    const unique = (names: string[]) => [...new Set(names)].sort()

    function builtFunctions(): BuiltFunction[] {
        const messageName = new Map(records('sys_rest_message').map((message) => [message.sys_id ?? '', message.name ?? '']))
        return records('sys_rest_message_fn').map((fn) => {
            const ofFunction = (record: BuiltRecord) => record.rest_message_function === fn.sys_id
            const headers = [
                ...records('sys_rest_message_headers').filter((header) => header.rest_message === fn.rest_message),
                ...records('sys_rest_message_fn_headers').filter(ofFunction),
            ]
            return {
                message: messageName.get(fn.rest_message ?? '') ?? '',
                fn: fn.function_name ?? '',
                used: unique([fn.rest_endpoint ?? '', fn.content ?? '', ...headers.map((header) => header.value ?? '')].flatMap(named)),
                declared: unique(records('sys_rest_message_fn_parameters').filter(ofFunction).map((variable) => variable.name ?? '')),
            }
        })
    }

    it('declare in each function the variables its endpoint, headers and content name, and no other', () => {
        expect(builtFunctions().flatMap((fn) => fn.used).length).toBeGreaterThan(20)
        for (const { message, fn, used, declared } of builtFunctions()) expect({ message, fn, declared }).toEqual({ message, fn, declared: used })
    })

    function callEveryFunction(): typeof sentToRest.calls {
        sentToRest.calls.length = 0
        for (const routes of Object.values(OEM_ADAPTERS)) {
            for (const route of [routes.lifecycle, routes.coverage, routes.rmaStatus]) route?.run(['KEY'], { http: restMessagePort(route.api.message), orgIds: ['org'] })
        }
        // Check Point's Zero Touch takes an account of the form <account id>/<template id>; to the others it is any text.
        const target = { stepId: 'step', serial: 'SERIAL', mac: '00:11:22:33:44:55', claimCode: 'CODE', account: '1/2' }
        for (const vendor of CLAIM_VENDORS) {
            for (const route of Object.values(claimRoutes(vendor))) route.run([target], restMessagePort(route.message), 10)
        }
        const address = { name: 'Depot', phone: '+31 20 000 0000', line1: 'Street 1', city: 'Amsterdam', postalCode: '1000 AA', country: 'NL' }
        buyLabel(restMessagePort(SHIPPING_MESSAGE.name), { carrierId: 'se-1', serviceCode: 'standard', from: address, to: address, packages: 1, weightKg: 1, reference: 'R' })
        return [...sentToRest.calls]
    }

    it('are sent every variable the function called names, and none its message declares nowhere', () => {
        const calls = callEveryFunction()
        const key = (call: { message: string; fn: string }) => `${call.message}.${call.fn}`
        expect(unique(calls.map(key))).toEqual(unique(builtFunctions().map(key)))
        const declaredIn = (message: string) => builtFunctions().filter((fn) => fn.message === message).flatMap((fn) => fn.declared)
        for (const call of calls) {
            const declared = builtFunctions().find((fn) => key(fn) === key(call))?.declared ?? []
            expect({ call: key(call), unset: declared.filter((variable) => !call.variables.includes(variable)) }).toEqual({ call: key(call), unset: [] })
            // A message's secrets and settings are set on each of its functions, also on one that names none of them.
            const unknown = call.variables.filter((variable) => !declaredIn(call.message).includes(variable))
            expect({ call: key(call), unknown }).toEqual({ call: key(call), unknown: [] })
        }
    })
})

/*
 * The three pages call the scripted REST API by paths written in src/client, which the build of the API knows nothing
 * of: a path the API does not serve is a 404 on the instance only.
 */
describe('the REST calls of the pages', () => {
    const CLIENT = join(ROOT, 'src/client')
    const clientSources = () => filesUnder(CLIENT).filter((path) => /\/api\.ts$/.test(path))

    function clientCalls(): Array<{ where: string; method: string; path: string }> {
        return clientSources().flatMap((source) =>
            [...readFileSync(source, 'utf8').matchAll(/\b(get|post)<[^(]*>\(\s*(?:path)?(['`])(.*?)\2/g)].map(([, method = '', , path = '']) => ({
                where: relative(ROOT, source),
                method: method.toUpperCase(),
                path: path.replace(/\?.*$/, '').replace(/\$\{[^}]*\}/g, '{}'),
            })),
        )
    }

    it('go to the base path the API is built with', () => {
        const base = /^const BASE = '([^']*)'$/m.exec(readFileSync(join(CLIENT, 'api.ts'), 'utf8'))?.[1]
        expect(records('sys_ws_definition').map((api) => api.base_uri)).toEqual([base])
    })

    it('are each a route of the API, by method and path', () => {
        const served = records('sys_ws_operation').map((route) => `${route.http_method} ${(route.relative_path ?? '').replace(/\{\w+\}/g, '{}')}`)
        expect(clientCalls().length).toBeGreaterThanOrEqual(14)
        expect(clientCalls().filter((call) => !served.includes(`${call.method} ${call.path}`))).toEqual([])
    })
})

/*
 * A case's replacement tier starts the SLA whose start condition names it. A tier no SLA names starts none, and the
 * case then runs without a clock.
 */
describe('replacement SLAs', () => {
    it('are one for each replacement tier', () => {
        const tiers = records('contract_sla').map((sla) => /(?:^|\^)x_daas_ham_replacement_tier=(\w+)/.exec(sla.start_condition ?? '')?.[1] ?? sla.name ?? '')
        expect(tiers.sort()).toEqual(Object.keys(REPLACEMENT_TIER_CHOICES).sort())
    })
})

/*
 * A record producer's variable that maps to a field writes its value to that column as it is. Its choices are written
 * in the catalog item, where a value that is no choice of the column still builds, and is then stored on the record.
 */
describe('choices of the record producers', () => {
    function columnChoices(table: string, column: string): string[] | undefined {
        const xml = readFileSync(join(BUILT, 'dictionary', `${table}.xml`), 'utf8')
        const choices = new RegExp(`<element name="${column}" [^>]*>\\s*<choice>([\\s\\S]*?)</choice>`).exec(xml)?.[1]
        return choices === undefined ? undefined : [...choices.matchAll(/<element value="([^"]*)"/g)].map(([, value = '']) => value)
    }

    it('are choices of the column the variable maps to', () => {
        const withChoices = records('item_option_new')
            .filter((variable) => variable.map_to_field === 'true')
            .map((variable) => ({
                variable: `${variable.record_producer_table}.${variable.field}`,
                offered: records('question_choice').filter((choice) => choice.question === variable.sys_id).map((choice) => choice.value ?? ''),
                column: columnChoices(variable.record_producer_table ?? '', variable.field ?? ''),
            }))
            .filter(({ offered }) => offered.length > 0)
        expect(withChoices.length).toBeGreaterThanOrEqual(4)
        for (const { variable, offered, column } of withChoices) {
            expect({ variable, unknown: offered.filter((value) => !(column ?? []).includes(value)) }).toEqual({ variable, unknown: [] })
        }
    })
})

/*
 * The substatus values the app adds to alm_asset.substatus, a field it does not own: the build writes them as one
 * choice set, which must add its own values and delete nothing else of the field's.
 */
describe('built substatus choice set', () => {
    /** Where now-sdk build writes the choice set of a field the app does not own. */
    const SET = join(BUILT, 'author_elective_update/sys_choice_alm_asset_substatus.xml')
    /** Where the build wrote each sys_choice on its own before the sys_choice_set parent existed. */
    const WITHOUT_PARENT = join(UPDATES, 'sys_choice_alm_asset_substatus.xml')

    const ADDED = Object.values(STAGE_FIELDS).flatMap((fields) =>
        'choice' in fields ? [{ value: fields.substatus, label: fields.choice.label, dependentValue: fields.installStatus }] : [],
    )
    const ADDED_VALUES = ADDED.map((choice) => choice.value).sort()

    type BuiltChoice = Record<string, string>

    function choiceSet(): { wrapper: string[]; inserted: BuiltChoice[]; deleted: BuiltChoice[] } {
        const xml = readFileSync(SET, 'utf8')
        const wrapper = /<(sys_choice_v2|sys_choice_set) action="INSERT_OR_UPDATE" field="([^"]*)" table="([^"]*)" version="(\d+)"/.exec(xml)
        const inserted = [...xml.matchAll(/<sys_choice action="INSERT_OR_UPDATE"[^>]*>([\s\S]*?)<\/sys_choice>/g)].map(
            ([, body = '']) => Object.fromEntries([...body.matchAll(/<(\w+)>([^<]*)<\/\1>/g)].map(([, field = '', value = '']) => [field, value])) as BuiltChoice,
        )
        const deleted = [...xml.matchAll(/<sys_choice action="delete_multiple" query="([^"]*)"\s*\/>/g)]
            .flatMap(([, query = '']) => query.split('^NQ'))
            .map((clause) => Object.fromEntries(clause.split('^').map((part) => part.split('=', 2))) as BuiltChoice)
        return { wrapper: wrapper?.slice(1) ?? [], inserted, deleted }
    }

    it('holds every substatus the app adds and deletes nothing else', () => {
        const { wrapper, inserted, deleted } = choiceSet()
        // The v3 sys_choice_set wrapper deletes every choice of the field before inserting; the v4 sys_choice_v2 one
        // deletes only what its delete_multiple queries match.
        expect(wrapper).toEqual(['sys_choice_v2', 'substatus', 'alm_asset', '4'])
        expect(inserted.map((choice) => choice.value).sort()).toEqual(ADDED_VALUES)
        for (const { value, label, dependentValue } of ADDED) {
            expect(inserted, value).toContainEqual(expect.objectContaining({ value, label, dependent_value: dependentValue }))
        }
        expect(deleted.map((choice) => choice.value).sort()).toEqual(ADDED_VALUES)
        expect(deleted.every((choice) => choice.name === 'alm_asset' && choice.element === 'substatus')).toBe(true)
        expect(existsSync(WITHOUT_PARENT)).toBe(false)
    })

    /**
     * The alm_asset.substatus choices a Brazil instance ships, as [value, install status (dependent_value)]: the
     * platform's own choice set (application Global), the first version of sys_choice_alm_asset_substatus the dev
     * instance recorded. A value may sit under several install statuses.
     */
    const OUT_OF_BOX: ReadonlyArray<readonly [string, string]> = [
        ['available', '6'], ['available', '9'], ['disposed', '7'], ['lost', '8'], ['pending_fulfillment', '1'],
        ['pending_retirement', '1'], ['reserved', '6'], ['reserved', '9'], ['sold', '7'], ['stolen', '8'], ['defective', '9'],
        ['defective', '6'], ['donated', '7'], ['end_of_support', '1'], ['pending_install', '9'], ['pending_repair', '1'],
        ['pending_repair', '6'], ['vendor_credit', '7'], ['in_repair', '1'], ['pending_disposal', '7'], ['pending_disposal', '9'],
        ['pending_donation', '9'], ['pending_donation', '6'], ['pending_install', '6'], ['is_shutdown', '1'],
        ['pending_disposal', '6'], ['pre_allocated', '9'], ['pending_transfer', '6'], ['lease_return', '7'], ['pre_allocated', '6'],
        ['pending_evaluation', '6'], ['pending_resale', '9'], ['pending_resale', '7'], ['obsolete', '7'], ['rma', '7'],
        ['buy_out', '7'], ['recalled', '7'], ['pending_resale', '6'], ['on_hold', '6'], ['legal_hold', '6'], ['quarantine', '6'],
        ['pending_return', '6'], ['pending_certificate', '6'], ['test', '6'], ['in_repair', '6'],
    ]
    const pair = (value = '', installStatus = '') => `${value}/${installStatus}`
    const OUT_OF_BOX_PAIRS = new Set(OUT_OF_BOX.map(([value, installStatus]) => pair(value, installStatus)))

    // The v4 delete matches a choice by its value, language and install status together: one of the platform's under
    // the same three would be deleted with the app's own, and come back as the app's.
    it("deletes each choice it inserts by its value, language and install status, none of them one of the platform's", () => {
        const { inserted, deleted } = choiceSet()
        const matched = ({ value, language, dependent_value }: BuiltChoice) => ({ value, language, dependent_value })
        const byValue = (a: BuiltChoice, b: BuiltChoice) => (a.value ?? '').localeCompare(b.value ?? '')
        expect(deleted.map(matched).sort(byValue)).toEqual(inserted.map(matched).sort(byValue))
        expect(inserted.filter((choice) => choice.language !== 'en' || choice.inactive !== 'false').map((choice) => choice.value)).toEqual([])
        expect(inserted.filter((choice) => OUT_OF_BOX_PAIRS.has(pair(choice.value, choice.dependent_value))).map((choice) => choice.value)).toEqual([])
    })

    it("lists each choice it adds at a place of its own, after the platform's", () => {
        const sequences = choiceSet().inserted.map((choice) => Number(choice.sequence))
        expect(sequences.filter((sequence) => !(sequence >= 500))).toEqual([])
        expect(new Set(sequences).size).toBe(sequences.length)
    })

    it('leaves no Lifecycle stage stored as a substatus the installed field has no choice for', () => {
        const added = new Set(choiceSet().inserted.map((choice) => pair(choice.value, choice.dependent_value)))
        const stored = Object.values(STAGE_FIELDS)
            .filter((fields) => fields.substatus)
            .map((fields) => pair(fields.substatus, fields.installStatus))
        expect(stored.length).toBeGreaterThan(15)
        expect(stored.filter((found) => !added.has(found) && !OUT_OF_BOX_PAIRS.has(found))).toEqual([])
    })
})

/*
 * The ATF tests (each feature's tests.now.ts) run on an instance only, after an install. Read here, from the built tests, is what
 * goes wrong before that. A test in no suite is never run (`now-sdk cicd testsuite run` runs suites). A "Run Server
 * Side Script" step's script is text to the build: it loads server modules by the path the instance keeps them under,
 * which names the package version (fluent/shared/server-modules.now.ts), and what it calls of them is checked by no compiler.
 */
describe('ATF tests', () => {
    const tests = () => records('sys_atf_test')

    it('are each in one suite, which is what runs them', () => {
        const inSuites = records('sys_atf_test_suite_test').map((member) => member.test ?? '')
        expect(tests().length).toBeGreaterThan(15)
        expect(inSuites.sort()).toEqual(tests().map((test) => test.sys_id ?? '').sort())
    })

    it('have each a name of their own and a description', () => {
        const names = tests().map((test) => test.name ?? '')
        expect(names.filter((name, i) => !name || names.indexOf(name) !== i)).toEqual([])
        expect(tests().filter((test) => !test.description).map((test) => test.name)).toEqual([])
    })

    interface StepScript {
        step: string
        script: string
    }

    /** The script of every "Run Server Side Script" step: the one input of the step that is a function. */
    function stepScripts(): StepScript[] {
        const testName = new Map(tests().map((test) => [test.sys_id ?? '', test.name ?? '']))
        return readdirSync(UPDATES)
            .filter((name) => name.startsWith('sys_atf_step_'))
            .flatMap((name) => {
                const xml = readFileSync(join(UPDATES, name), 'utf8')
                if (!xml.includes('<display_name>Run Server Side Script</display_name>')) return []
                const field = (tag: string) => new RegExp(`^ {4}<${tag}>([^<]*)</${tag}>$`, 'm').exec(xml)?.[1] ?? ''
                const inputs = [...xml.matchAll(/<sys_variable_value action="INSERT_OR_UPDATE"[^>]*>([\s\S]*?)<\/sys_variable_value>/g)].map(
                    ([, input = '']) => unescapeXml(/<value>([\s\S]*?)<\/value>/.exec(input)?.[1] ?? ''),
                )
                return [{ step: `${testName.get(field('test'))} step ${field('order')}`, script: inputs.find((input) => input.startsWith('(function')) ?? '' }]
            })
    }

    const loaded = (script: string) => [...script.matchAll(/\bvar\s+(\w+)\s*=\s*require\('([^']+)'\)/g)].map(([, binding = '', path = '']) => ({ binding, path }))

    it('have server-side scripts to read', () => {
        expect(stepScripts().length).toBeGreaterThanOrEqual(8)
        expect(stepScripts().filter(({ script }) => !script).map(({ step }) => step)).toEqual([])
    })

    it('load in their scripts server modules by the path the build installs them under, and call what those export', () => {
        const modules = new Map(records('sys_module').map((module) => [module.path ?? '', module.content ?? '']))
        for (const { step, script } of stepScripts()) {
            // A script that calls a REST route over HTTP reaches the app through the route, not a module.
            if (!/\bsn_ws\.RESTMessageV2\b/.test(script)) expect(loaded(script).length, step).toBeGreaterThan(0)
            expect([...script.matchAll(/\brequire\(/g)].length, `${step}: every require is read`).toBe(loaded(script).length)
            const code = script.replace(/'[^'\n]*'/g, "''")
            for (const { binding, path } of loaded(script)) {
                expect(modules.has(path), `${step}: ${path}`).toBe(true)
                const called = [...code.matchAll(new RegExp(`\\b${binding}\\.(\\w+)`, 'g'))].map(([, fn = '']) => fn)
                expect(called.length, `${step}: ${binding}`).toBeGreaterThan(0)
                const exported = (fn: string) => new RegExp(`^export function ${fn}\\(`, 'm').test(modules.get(path) ?? '')
                expect({ step, path, unknown: called.filter((fn) => !exported(fn)) }).toEqual({ step, path, unknown: [] })
            }
        }
    })

    it('name in their scripts only system properties the app declares', () => {
        const scope = (JSON.parse(readFileSync(join(ROOT, 'now.config.json'), 'utf8')) as { scope: string }).scope
        const declared = records('sys_properties').map((property) => property.name)
        const named = stepScripts().flatMap(({ script }) => [...script.matchAll(new RegExp(`'(${scope}\\.[\\w.]+)'`, 'g'))].map(([, name = '']) => name))
        expect(named.length).toBeGreaterThan(0)
        expect(named.filter((name) => !declared.includes(name))).toEqual([])
    })

    // The platform puts a step's output into the other inputs of a later step, never into its script: there the
    // placeholder the build writes for `${step.record_id}` stays as text.
    it('are given no step output in their scripts', () => {
        expect(stepScripts().filter(({ script }) => script.includes('{{')).map(({ step }) => step)).toEqual([])
    })

    class FoundRecord {
        private found = false
        addQuery() {
            return { addOrCondition: () => undefined }
        }
        addEncodedQuery() {}
        addActiveQuery() {}
        setLimit() {}
        query() {}
        next() {
            this.found = !this.found
            return this.found
        }
        hasNext() {
            return true
        }
        get() {
            return true
        }
        getUniqueValue() {
            return 'a'.repeat(32)
        }
        getValue() {
            return 'FOUND'
        }
        getRowCount() {
            return 1
        }
    }

    class StandInRest {
        setEndpoint() {}
        setHttpMethod() {}
        setRequestHeader() {}
        setRequestBody() {}
        execute() {
            return { getStatusCode: () => 599, getBody: () => '{"result":{"error":"stand-in"}}' }
        }
    }

    function standInModule(): unknown {
        return new Proxy(
            {},
            {
                get:
                    (_target, name) =>
                    (...args: unknown[]): unknown => {
                        if (name === 'beyondVisibility') return (args[1] as () => unknown)()
                        const response = args[1] as { setStatus?: (status: number) => void; setBody?: (body: unknown) => void } | undefined
                        response?.setStatus?.(599)
                        response?.setBody?.({ error: 'stand-in' })
                        return undefined
                    },
            },
        )
    }

    function run(script: string): { verdict: unknown; message: string } {
        let message = ''
        const stepResult = { setOutputMessage: (text: string) => void (message = text) }
        const properties = new Map<string, string>()
        const gs = {
            getProperty: (name: string, fallback = '') => (name === 'glide.servlet.uri' ? 'https://instance.example/' : properties.get(name) || fallback),
            setProperty: (name: string, value: string) => void properties.set(name, value),
            generateGUID: () => 'b'.repeat(32),
        }
        const body = script.replace(/^\(function/, 'return (function')
        const step = new Function('outputs', 'steps', 'params', 'stepResult', 'assertEqual', 'require', 'GlideRecord', 'gs', 'sn_ws', body)
        return { verdict: step({}, () => ({}), {}, stepResult, () => undefined, standInModule, FoundRecord, gs, { RESTMessageV2: StandInRest }), message }
    }

    // A step passes or fails by what its script returns. Run here, a script fails only on the reply it checks, which a
    // stand-in answers HTTP 599: one that fails for another reason, or returns nothing, has an error of its own.
    it('run their scripts to a verdict', () => {
        for (const { step, script } of stepScripts()) {
            const { verdict, message } = run(script)
            expect({ step, verdict: typeof verdict }).toEqual({ step, verdict: 'boolean' })
            if (verdict === false) expect(message, step).toMatch(/expected HTTP/)
            expect(message, step).not.toMatch(/TypeError|ReferenceError|is not a function|is not defined|undefined/)
        }
    })
})
