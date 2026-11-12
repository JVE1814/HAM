import { compare, matchesQuery } from './encoded-query.ts'

/**
 * The one in-memory stand-in for `@servicenow/glide` in unit tests of the platform and entry layers:
 *
 *     vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)
 *     import { platform } from '../test-support/fake-glide.ts'
 *     beforeEach(() => platform.reset())
 *
 * `platform` is the instance a test sets up and reads back: its tables, what the tables refuse, the clock, the user,
 * the queued events and the log. `glide` is what the code under test imports.
 *
 * Where the platform's behaviour is known the fake keeps it; where a test asks for something the fake does not know it
 * throws, so that a test never passes on a guess:
 *   - every query runs through the tests' one encoded-query evaluator (encoded-query.ts), which throws on an operator
 *     or term it does not know; conditions added one by one are AND-ed;
 *   - `getValue` gives null for a blank field and for a dot-walked name (a scoped GlideRecord does not dot-walk there);
 *     `getElement` and queries dot-walk through the references the test declared, and throw on one it did not;
 *   - `update` saves the fields changed since the record was read, does nothing when none was, and throws for a record
 *     that is not stored: on the platform that inserts one, which no code here means to do;
 *   - a refused insert, update or delete returns what the platform returns (null, false) and leaves the reason in
 *     `getLastErrorMessage`;
 *   - `setValue` of a journal field (work_notes, comments) throws: the platform stores nothing for it. Assigning one
 *     queues an entry that the next insert or update stores in `platform.journal`, even with no other field changed.
 * A Glide method the fake does not have fails the test with a TypeError: add it here, once, with the platform's
 * behaviour.
 */

export type Row = Record<string, string>
export type Operation = 'insert' | 'update' | 'delete'

export interface QueuedEvent {
    name: string
    /** The sys_id of the record the event was queued on. */
    record: string
    parm1: string
    parm2: string
    /** Queued for later (gs.eventQueueScheduled) rather than now. */
    delayed: boolean
}

const JOURNAL_FIELDS = new Set(['work_notes', 'comments'])
interface JournalEntry {
    table: string
    record: string
    field: string
    value: string
}

const UNIQUE_KEY_VIOLATION = 'Unique Key violation detected by database'
/** 2025-11-09 12:00:00 UTC. */
const CLOCK_START = 1762689600000

function state() {
    return {
        /**
         * The stored rows by table; a test seeds and reads them directly. Rows of a table that extends another
         * (`parents`) live in the table at the root of its hierarchy, each with its `sys_class_name`.
         */
        tables: {} as Record<string, Row[]>,
        /** The field behind a table's unique index: a second row with the same value is refused. */
        uniqueKeys: {} as Record<string, string>,
        /** The table a reference field points at, by `table.field`: what a dot-walk follows. */
        references: {} as Record<string, string>,
        /** The tables a table extends, nearest first. */
        parents: {} as Record<string, string[]>,
        /** What GlideTableHierarchy#getTables gives for a table, where it is not the array of the table and its parents. */
        hierarchy: {} as Record<string, () => unknown>,
        /** What the platform fills in on an insert into a table (a number, a default), for the fields the row leaves blank. */
        defaults: {} as Record<string, (row: Row) => Row>,
        /** Why a table's own rules refuse a row ('' when they do not), given the other rows stored. */
        constraints: {} as Record<string, (row: Row, others: Row[]) => string>,
        /** Why an insert, update or delete of `row` is refused beyond those ('' lets it through). */
        refuses: (() => '') as (table: string, row: Row, operation: Operation) => string,
        /**
         * Whether the user may create a record of a table (GlideRecord#canCreate): the answer of its create ACLs, which
         * the fake does not work out, so a test that reaches it says.
         */
        creatable: ((table) => {
            throw new Error(`fake Glide: canCreate is asked of ${table} but platform.creatable is not set`)
        }) as (table: string) => boolean,
        /** Called with each row as it is inserted or updated, once nothing refused it and before it is stored. */
        onSave: (() => undefined) as (table: string, row: Row, operation: Exclude<Operation, 'delete'>) => void,
        /** The journal entries saved (sys_journal_field), oldest first: a journal field reads blank on the record. */
        journal: [] as JournalEntry[],
        events: [] as QueuedEvent[],
        /** What was logged, as `<level> <message>`. */
        logs: [] as string[],
        /** What the user was told (gs.addErrorMessage, gs.addInfoMessage), as `<error|info> <message>`. */
        messages: [] as string[],
        properties: {} as Record<string, string>,
        /** The content of each attachment written (GlideSysAttachment#write), by the sys_id of its sys_attachment row. */
        attachments: {} as Record<string, string>,
        /** The time now, in epoch ms. */
        clock: CLOCK_START,
        user: { id: '', name: '', company: '', roles: [] as string[], interactive: true },
        ids: 0,
    }
}

export const platform = {
    ...state(),
    reset(): void {
        Object.assign(platform, state())
    },
    /** The work notes saved on a record, oldest first. */
    notesOn(record: string | undefined): string[] {
        if (!record) throw new Error('fake Glide: notesOn is asked of a record with no sys_id')
        return platform.journal.filter((entry) => entry.record === record && entry.field === 'work_notes').map((entry) => entry.value)
    },
    get warnings(): string[] {
        return platform.logs.filter((line) => line.startsWith('warn ')).map((line) => line.slice('warn '.length))
    },
}

function stamp(ms: number): string {
    return new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
}

function rootOf(table: string): string {
    return platform.parents[table]?.at(-1) ?? table
}

function inHierarchy(table: string): boolean {
    return rootOf(table) !== table || Object.values(platform.parents).some((parents) => parents.includes(table))
}

function isA(row: Row, table: string): boolean {
    const rowClass = row.sys_class_name || rootOf(table)
    return rowClass === table || (platform.parents[rowClass] ?? []).includes(table)
}

function store(table: string): Row[] {
    return (platform.tables[rootOf(table)] ??= [])
}

/** The stored rows a GlideRecord of `table` sees: its own and those of the tables that extend it. */
function rowsOf(table: string): Row[] {
    const rows = store(table)
    return rootOf(table) === table ? rows : rows.filter((row) => isA(row, table))
}

function referenceOf(table: string, field: string): string {
    const declared = [table, ...(platform.parents[table] ?? [])].map((owner) => platform.references[`${owner}.${field}`]).find(Boolean)
    if (!declared) throw new Error(`fake Glide: ${table}.${field} is dot-walked but not declared in platform.references`)
    return declared
}

function walk(table: string, row: Row, path: string): string {
    const [field = '', ...rest] = path.split('.')
    const value = row[field] ?? ''
    if (rest.length === 0) return value
    const target = referenceOf(table, field)
    const referenced = value ? store(target).find((other) => other.sys_id === value) : undefined
    return referenced ? walk(referenced.sys_class_name || target, referenced, rest.join('.')) : ''
}

function displayOf(row: Row): string {
    return row.display_name || row.number || row.name || row.sys_id || ''
}

/** The `javascript:` operands the app's queries use, on the fake's clock. */
function scriptValue(expression: string): string {
    if (expression === 'gs.beginningOfToday()') return `${stamp(platform.clock).slice(0, 10)} 00:00:00`
    const minutesAgo = /^gs\.minutesAgoStart\((\d+)\)$/.exec(expression)
    if (minutesAgo) return `${stamp(platform.clock - Number(minutesAgo[1]) * 60000).slice(0, 16)}:00`
    throw new Error(`fake Glide: no value for the query operand javascript:${expression}`)
}

const ADD_QUERY_OPERATORS: Record<string, string> = {
    '=': '=',
    '!=': '!=',
    '<': '<',
    '<=': '<=',
    '>': '>',
    '>=': '>=',
    IN: 'IN',
    'NOT IN': 'NOT IN',
    STARTSWITH: 'STARTSWITH',
    CONTAINS: 'LIKE',
    LIKE: 'LIKE',
}

function term(field: string, operatorOrValue: unknown, value?: unknown): string {
    if (value === undefined) return `${field}=${String(operatorOrValue ?? '')}`
    const operator = ADD_QUERY_OPERATORS[String(operatorOrValue)]
    if (!operator) throw new Error(`fake Glide: addQuery operator "${String(operatorOrValue)}" is not known`)
    return `${field}${operator}${String(value ?? '')}`
}

/** The conditions of a query on one table, as GlideRecord and GlideAggregate build them. */
class Conditions {
    protected conditions: string[] = []
    constructor(protected readonly table: string) {}

    addQuery(field: string, operatorOrValue: unknown, value?: unknown): { addOrCondition(field: string, operatorOrValue: unknown, value?: unknown): unknown } {
        const at = this.conditions.push(term(field, operatorOrValue, value)) - 1
        const condition = {
            addOrCondition: (other: string, otherOperatorOrValue: unknown, otherValue?: unknown) => {
                this.conditions[at] += `^OR${term(other, otherOperatorOrValue, otherValue)}`
                return condition
            },
        }
        return condition
    }
    addEncodedQuery(query: string): void {
        if (query) this.conditions.push(query)
    }
    addNullQuery(field: string): void {
        this.conditions.push(`${field}ISEMPTY`)
    }
    addNotNullQuery(field: string): void {
        this.conditions.push(`${field}ISNOTEMPTY`)
    }
    addActiveQuery(): void {
        this.conditions.push('active=true')
    }

    protected matching(): Row[] {
        // How the platform joins a ^NQ query with further conditions is not something a test should lean on.
        if (this.conditions.length > 1 && this.conditions.some((condition) => condition.includes('^NQ'))) {
            throw new Error(`fake Glide: a ^NQ query is combined with other conditions on ${this.table}: ${this.conditions.join(' AND ')}`)
        }
        return rowsOf(this.table).filter((row) =>
            this.conditions.every((condition) => matchesQuery(condition, (field) => walk(this.table, row, field), scriptValue)),
        )
    }
}

class GlideRecord extends Conditions {
    private ordering: Array<{ field: string; descending: boolean }> = []
    /** The rows of the ordered result a query gives: from `first` up to, not including, `last`. */
    private window = { first: 0, last: Infinity }
    private found: Row[] = []
    private at = -1
    private row: Row = {}
    /** The row as it was read or last saved; null for a record that is not stored. */
    private read: Row | null = null
    private fresh = false
    private error = ''
    private notes: Array<{ field: string; value: string }> = []

    hold(row: Row, fresh: boolean): this {
        this.row = { ...row }
        this.notes = []
        this.read = fresh ? null : { ...row }
        this.fresh = fresh
        return this
    }

    orderBy(field: string): void {
        this.ordering.push({ field, descending: false })
    }
    orderByDesc(field: string): void {
        this.ordering.push({ field, descending: true })
    }
    /** The platform's setLimit is chooseWindow(0, limit): whichever of the two is called last decides the rows. */
    setLimit(limit: number): void {
        this.window = { first: 0, last: limit }
    }
    chooseWindow(first: number, last: number, _forceCount?: boolean): void {
        this.window = { first, last }
    }
    /** An encoded query's `ORDERBY<field>` and `ORDERBYDESC<field>` terms order the rows, as orderBy and orderByDesc do. */
    override addEncodedQuery(query: string): void {
        const conditions: string[] = []
        for (const term of query.split('^')) {
            const order = /^ORDERBY(DESC)?(.+)$/.exec(term)
            if (order) this.ordering.push({ field: order[2] ?? '', descending: order[1] !== undefined })
            else conditions.push(term)
        }
        super.addEncodedQuery(conditions.join('^'))
    }
    setWorkflow(): void {}

    query(): void {
        const found = this.matching()
        for (const { field, descending } of [...this.ordering].reverse()) {
            found.sort((a, b) => compare(walk(this.table, a, field), walk(this.table, b, field)) * (descending ? -1 : 1))
        }
        this.found = found.slice(this.window.first, this.window.last)
        this.at = -1
    }
    hasNext(): boolean {
        return this.at + 1 < this.found.length
    }
    next(): boolean {
        this.at++
        const row = this.found[this.at]
        if (row) this.hold(row, false)
        return row !== undefined
    }
    get(fieldOrId: string, value?: string): boolean {
        const [field, wanted] = value === undefined ? ['sys_id', fieldOrId] : [fieldOrId, value]
        const row = wanted ? rowsOf(this.table).find((candidate) => walk(this.table, candidate, field) === String(wanted)) : undefined
        if (row) this.hold(row, false)
        return row !== undefined
    }

    initialize(): void {
        this.hold(inHierarchy(this.table) ? { sys_class_name: this.table } : {}, true)
    }
    isNewRecord(): boolean {
        return this.fresh
    }
    getTableName(): string {
        return this.table
    }
    getUniqueValue(): string {
        return this.row.sys_id ?? ''
    }
    getValue(field: string): string | null {
        return field.includes('.') ? null : this.row[field] || null
    }
    getElement(path: string): { getValue(): string | null; getDisplayValue(): string; toString(): string } {
        const value = () => walk(this.table, this.row, path)
        return { getValue: () => value() || null, getDisplayValue: () => this.getDisplayValue(path), toString: value }
    }
    getDisplayValue(path?: string): string {
        if (!path) return displayOf(this.row)
        const value = walk(this.table, this.row, path)
        const owner = path.includes('.') ? null : this.table
        const target = owner && [owner, ...(platform.parents[owner] ?? [])].map((table) => platform.references[`${table}.${path}`]).find(Boolean)
        const referenced = target && value ? store(target).find((row) => row.sys_id === value) : undefined
        return referenced ? displayOf(referenced) : value
    }
    set work_notes(value: string) {
        this.notes.push({ field: 'work_notes', value: String(value) })
    }
    set comments(value: string) {
        this.notes.push({ field: 'comments', value: String(value) })
    }
    private saveNotes(): void {
        for (const note of this.notes) platform.journal.push({ table: this.table, record: this.getUniqueValue(), ...note })
        this.notes = []
    }
    setValue(field: string, value: unknown): void {
        if (JOURNAL_FIELDS.has(field)) throw new Error(`fake Glide: setValue('${field}') on ${this.table} stores nothing on the platform: assign the journal field`)
        this.row[field] = value === null || value === undefined ? '' : String(value)
    }
    getLastErrorMessage(): string {
        return this.error
    }
    canCreate(): boolean {
        return platform.creatable(this.table)
    }

    private refusal(operation: Operation, stored: Row | undefined): string {
        const others = store(this.table).filter((row) => row !== stored)
        if (operation !== 'delete') {
            const key = platform.uniqueKeys[rootOf(this.table)]
            if (key && others.some((row) => (row[key] ?? '') === (this.row[key] ?? ''))) return UNIQUE_KEY_VIOLATION
            const constraint = platform.constraints[rootOf(this.table)]?.(this.row, others)
            if (constraint) return constraint
        }
        return platform.refuses(this.table, this.row, operation)
    }

    // The hooks of a save may change the tables themselves (another transaction's write landing meanwhile), so the
    // row is put where the table is once they have run.
    insert(): string | null {
        this.error = this.refusal('insert', undefined)
        if (this.error) return null
        const taken = (sysId: string) => store(this.table).some((row) => row.sys_id === sysId)
        if (!this.row.sys_id || taken(this.row.sys_id)) this.row.sys_id = `id${String(++platform.ids).padStart(4, '0')}`
        if (inHierarchy(this.table)) this.row.sys_class_name ||= this.table
        this.row.sys_created_on = this.row.sys_updated_on = stamp(platform.clock)
        for (const [field, value] of Object.entries(platform.defaults[this.table]?.(this.row) ?? {})) this.row[field] ||= value
        platform.onSave(this.table, this.row, 'insert')
        store(this.table).push({ ...this.row })
        this.saveNotes()
        this.hold(this.row, false)
        return this.row.sys_id
    }
    private stored(): Row {
        const stored = this.read && store(this.table).find((row) => row.sys_id === this.read?.sys_id)
        if (!stored) throw new Error(`fake Glide: update of a ${this.table} record that is not stored (sys_id "${this.getUniqueValue()}")`)
        return stored
    }
    update(): string | null {
        const read = this.read ?? {}
        const sysId = this.stored().sys_id ?? null
        const changed = Object.keys(this.row).filter((field) => (this.row[field] ?? '') !== (read[field] ?? ''))
        if (changed.length === 0 && this.notes.length === 0) return sysId
        this.error = this.refusal('update', this.stored())
        if (this.error) return null
        this.row.sys_updated_on = stamp(platform.clock)
        platform.onSave(this.table, this.row, 'update')
        const stored = this.stored()
        for (const field of [...changed, 'sys_updated_on']) stored[field] = this.row[field] ?? ''
        this.read = { ...this.row }
        this.saveNotes()
        return sysId
    }
    deleteRecord(): boolean {
        const rows = store(this.table)
        const at = rows.findIndex((row) => row.sys_id === this.row.sys_id)
        if (at < 0) return false
        this.error = this.refusal('delete', rows[at])
        if (this.error) return false
        rows.splice(at, 1)
        return true
    }
    deleteMultiple(): void {
        for (const row of this.matching()) new GlideRecord(this.table).hold(row, false).deleteRecord()
    }
}

const AGGREGATES: Record<string, (values: string[]) => string> = {
    COUNT: (values) => String(values.length),
    SUM: (values) => String(values.reduce((sum, value) => sum + (Number(value) || 0), 0)),
}

class GlideAggregate extends Conditions {
    private groups: string[] = []
    private found: Array<{ key: Row; rows: Row[] }> = []
    private at = -1

    addAggregate(aggregate: string, _field = ''): void {
        if (!AGGREGATES[aggregate]) throw new Error(`fake Glide: aggregate "${aggregate}" is not known`)
    }
    groupBy(field: string): void {
        this.groups.push(field)
    }
    query(): void {
        const found = new Map<string, { key: Row; rows: Row[] }>()
        const groupOf = (key: Row): Row[] => {
            const id = JSON.stringify(key)
            let group = found.get(id)
            if (!group) found.set(id, (group = { key, rows: [] }))
            return group.rows
        }
        // Without a group-by the platform gives one row, also for no match.
        if (this.groups.length === 0) groupOf({})
        for (const row of this.matching()) {
            groupOf(Object.fromEntries(this.groups.map((field) => [field, walk(this.table, row, field)]))).push(row)
        }
        this.found = [...found.values()]
        this.at = -1
    }
    next(): boolean {
        this.at++
        return this.at < this.found.length
    }
    /** The value of a group-by field: unlike a GlideRecord's getValue, a dotted name is given as grouped. */
    getValue(field: string): string | null {
        return this.found[this.at]?.key[field] || null
    }
    getAggregate(aggregate: string, field = ''): string {
        const compute = AGGREGATES[aggregate]
        if (!compute) throw new Error(`fake Glide: aggregate "${aggregate}" is not known`)
        const rows = this.found[this.at]?.rows ?? []
        return compute(field ? rows.map((row) => walk(this.table, row, field)).filter(Boolean) : rows.map(() => ''))
    }
}

/** Attachments are rows of sys_attachment, saved like any other; their content is kept in `platform.attachments`. */
class GlideSysAttachment {
    write(record: GlideRecord, fileName: string, contentType: string, content: string): string | null {
        const attachment = new GlideRecord('sys_attachment')
        attachment.initialize()
        attachment.setValue('table_name', record.getTableName())
        attachment.setValue('table_sys_id', record.getUniqueValue())
        attachment.setValue('file_name', fileName)
        attachment.setValue('content_type', contentType)
        const id = attachment.insert()
        if (id) platform.attachments[id] = content
        return id
    }
    deleteAttachment(attachmentId: string): void {
        const attachment = new GlideRecord('sys_attachment')
        if (attachment.get(attachmentId) && attachment.deleteRecord()) delete platform.attachments[attachmentId]
    }
}

class GlideDateTime {
    private ms: number
    constructor(value?: string) {
        this.ms = value ? Date.parse(`${value.replace(' ', 'T')}Z`) : platform.clock
    }
    getNumericValue(): number {
        return this.ms
    }
    addSeconds(seconds: number): void {
        this.ms += seconds * 1000
    }
    getValue(): string {
        return stamp(this.ms)
    }
}

class GlideTableHierarchy {
    constructor(private readonly table: string) {}
    getTables(): unknown {
        return platform.hierarchy[this.table]?.() ?? [this.table, ...(platform.parents[this.table] ?? [])]
    }
}

const queue =
    (delayed: boolean) =>
    (name: string, record: { getUniqueValue(): string }, parm1?: string, parm2?: string): void =>
        void platform.events.push({ name, record: record.getUniqueValue(), parm1: String(parm1 ?? ''), parm2: String(parm2 ?? ''), delayed })

const log = (level: string) => (message: string) => void platform.logs.push(`${level} ${message}`)

const gs = {
    eventQueue: queue(false),
    eventQueueScheduled: queue(true),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    addErrorMessage: (message: string) => void platform.messages.push(`error ${message}`),
    addInfoMessage: (message: string) => void platform.messages.push(`info ${message}`),
    getProperty: (name: string, fallback?: string) => platform.properties[name] ?? fallback ?? null,
    setProperty: (name: string, value: string) => void (platform.properties[name] = String(value)),
    getUserID: () => platform.user.id,
    getUserDisplayName: () => platform.user.name,
    getUser: () => ({ getCompanyID: () => platform.user.company }),
    hasRole: (role: string) => platform.user.roles.includes(role),
    isInteractive: () => platform.user.interactive,
}

export const glide = { GlideRecord, GlideAggregate, GlideDateTime, GlideSysAttachment, GlideTableHierarchy, gs }

/**
 * A record of `table` holding `row`, as a rule, an ACL or a script action is handed one: read from the table, or with
 * `fresh` a record not saved yet. The row need not be stored.
 */
export function recordOf<Record = unknown>(table: string, row: Row, options: { fresh?: boolean } = {}): Record {
    return new GlideRecord(table).hold(row, options.fresh === true) as Record
}
