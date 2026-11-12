import { GlideAggregate, type GlideElement, GlideRecord } from '@servicenow/glide'
import { oneOf } from '../domain/exhaustive.ts'
import { beyondVisibility } from './beyond-visibility.ts'
import { log } from './log.ts'

/** Keep this module free of business rules. */

export interface ReadOptions {
    /**
     * Read past the app's visibility rules (platform/beyond-visibility), for server logic that must find the record
     * whoever set it off. A record found this way is saved with every rule.
     */
    beyondVisibility?: boolean
}

export function findById(table: string, sysId: string, options: ReadOptions = {}): GlideRecord | null {
    if (!sysId) return null
    const gr = new GlideRecord(table)
    const found = options.beyondVisibility ? beyondVisibility(gr, () => gr.get(sysId)) : gr.get(sysId)
    return found ? gr : null
}

export function pluck(table: string, encodedQuery: string, field: string, limit = 10000): string[] {
    const gr = new GlideRecord(table)
    gr.addEncodedQuery(encodedQuery)
    gr.setLimit(limit)
    gr.query()
    const values: string[] = []
    while (gr.next()) values.push(String(gr.getValue(field) ?? ''))
    return values
}

/** Each record of `table` with one of `ids`, read with one query, by sys_id; blank ids are skipped and records not found left out. */
export function recordsById<T>(table: string, ids: Iterable<string>, read: (record: GlideRecord) => T): Map<string, T> {
    const found = new Map<string, T>()
    const unique = [...new Set(ids)].filter(Boolean)
    if (unique.length === 0) return found
    const gr = new GlideRecord(table)
    gr.addEncodedQuery(`sys_idIN${unique.join(',')}`)
    gr.query()
    while (gr.next()) found.set(gr.getUniqueValue(), read(gr))
    return found
}

/**
 * Match records whose `field` is any of `values` (at least one). Free-text values such as serial numbers can
 * hold a comma, which would split an IN list, so those are matched one by one with OR conditions.
 */
export function addAnyOf(gr: GlideRecord, field: string, values: readonly string[]): void {
    const listed = values.filter((value) => !value.includes(','))
    const separate = values.filter((value) => value.includes(','))
    const condition = listed.length > 0 ? gr.addQuery(field, 'IN', listed.join(',')) : gr.addQuery(field, separate.shift() ?? '')
    for (const value of separate) condition.addOrCondition(field, value)
}

/**
 * Delete every record matching an encoded query with one set-based delete (business rules run), and return whether
 * none is left (`noneLeft`). deleteMultiple reports nothing and a rule can keep a record, so a caller that must not go
 * on past one checks this.
 */
export function deleteWhere(table: string, encodedQuery: string): boolean {
    const gr = new GlideRecord(table)
    gr.addEncodedQuery(encodedQuery)
    gr.deleteMultiple()
    return noneLeft(table, encodedQuery)
}

/**
 * Whether no record matches an encoded query any more, after a set-based delete. It looks past before-query rules, so
 * a record hidden from the user still counts as left: past every rule on an app table, and past the app's visibility
 * rules on a table of another scope, where the platform refuses setWorkflow from this scope
 * (platform/beyond-visibility).
 */
export function noneLeft(table: string, encodedQuery: string): boolean {
    const left = new GlideRecord(table)
    left.addEncodedQuery(encodedQuery)
    left.setWorkflow(false)
    // One survivor is enough to tell; a full count would read every one (e.g. of a purge).
    left.setLimit(1)
    beyondVisibility(left, () => left.query())
    return !left.hasNext()
}

export function exists(table: string, encodedQuery: string, options: ReadOptions = {}): boolean {
    const gr = new GlideRecord(table)
    gr.addEncodedQuery(encodedQuery)
    gr.setLimit(1)
    if (options.beyondVisibility) beyondVisibility(gr, () => gr.query())
    else gr.query()
    return gr.hasNext()
}

export function count(table: string, encodedQuery: string): number {
    const ga = new GlideAggregate(table)
    ga.addEncodedQuery(encodedQuery)
    ga.addAggregate('COUNT', '')
    ga.query()
    return ga.next() ? Number(ga.getAggregate('COUNT', '')) : 0
}

/** How many records match an encoded query for each value of `field` (one aggregate query); values with none are left out. */
export function countBy(table: string, encodedQuery: string, field: string): Map<string, number> {
    const ga = new GlideAggregate(table)
    ga.addEncodedQuery(encodedQuery)
    ga.addAggregate('COUNT', '')
    ga.groupBy(field)
    ga.query()
    const counts = new Map<string, number>()
    while (ga.next()) counts.set(String(ga.getValue(field) ?? ''), Number(ga.getAggregate('COUNT', '')))
    return counts
}

/**
 * A record of a table of another scope (alm_hardware, wm_order, a platform table) as a business rule there is handed
 * it. From this scope the platform refuses setAbortAction and setWorkflow on such a record and goes on as if neither
 * was called: the save is written, the rules run (rule-api `abortWith`, platform/beyond-visibility). The type leaves
 * both out, so a rule there, and every helper it hands its record to, fails to compile when it calls one. Any
 * GlideRecord is one. (Spelled out key by key: `Omit` on a GlideRecord keeps its field index only, and no method.)
 */
export type ForeignRecord = {
    [Key in keyof GlideRecord as string extends Key ? never : number extends Key ? never : Key extends 'setAbortAction' | 'setWorkflow' ? never : Key]: GlideRecord[Key]
}

/** Why the platform refused to save (or delete) `record`: its last error message, or `fallback` when it gave none. */
export function refusal(record: GlideRecord, fallback = 'the save was refused'): string {
    return record.getLastErrorMessage() || fallback
}

/**
 * Log that the platform refused to save (or delete) `record`, naming what that leaves `undone`: a refused save throws
 * nothing, so unlogged it leaves no trace. Gives why it was refused, for a caller that also tells the user.
 */
export function warnRefused(record: GlideRecord, undone: string): string {
    const reason = refusal(record)
    log.warn(`${undone}: ${reason}`)
    return reason
}

/**
 * `warnRefused` for work that must stop at a refused save rather than go on without the record (a pass of a Billing
 * period, ADR 0013): throws what is `undone` and why, for the pass to record where it stopped.
 */
export function throwRefused(record: GlideRecord, undone: string): never {
    throw new Error(`${undone}: ${refusal(record)}`)
}

/**
 * The value of `field`, which may be dot-walked ('reference.field'). In a scoped script a GlideRecord's getValue does
 * not dot-walk: it gives null for a dotted name, so those are read through getElement, whose value is null when the path
 * crosses an empty reference (and which is null itself for an unknown field). Not for a GlideAggregate: scoped scripts
 * may not call its getElement, and its getValue does give a dotted group-by.
 */
function valueOf(gr: ForeignRecord, field: string): string | null {
    if (!field.includes('.')) return gr.getValue(field)
    const element: GlideElement | null = gr.getElement(field)
    return element ? element.getValue() : null
}

export function str(gr: ForeignRecord, field: string): string {
    const value = valueOf(gr, field)
    return value === null || value === undefined ? '' : String(value)
}

/**
 * The number in `field`; 0 when it is blank. A value that is not a number (a corrupt or hand-edited row, a dot-walk to a
 * text field) reads as 0 too, which would bill or cost nothing without a word, so it is logged as a warning naming the
 * record, the field and the value.
 */
export function num(gr: ForeignRecord, field: string): number {
    const raw = valueOf(gr, field)
    if (raw === null || raw === undefined) return 0
    const value = Number(raw)
    if (Number.isFinite(value)) return value
    log.warn(`${gr.getTableName()} ${gr.getUniqueValue()}: ${field} holds '${String(raw)}', not a number; read as 0`)
    return 0
}

/**
 * The value of a choice `field`.
 *
 * With the list's values (`allowed`) it is checked (domain/exhaustive `oneOf`): the value when it is one of them, else
 * `fallback`, or undefined when none is given. A value the app does not know, such as a choice an administrator added, a
 * corrupt row or a blank not in `allowed`, is never read as one it does, as a cast (`str(...) as T`) would.
 *
 * Without `allowed` it is the value as its list's type (domain/vocabulary; '' when blank), so that comparing it with a
 * value the list does not have fails to compile. That form checks nothing: a value stored past the list reads as it is.
 */
export function choice<T extends string>(gr: ForeignRecord, field: string): T | ''
export function choice<T extends string>(gr: ForeignRecord, field: string, allowed: readonly T[]): T | undefined
export function choice<T extends string>(gr: ForeignRecord, field: string, allowed: readonly T[], fallback: T): T
export function choice<T extends string>(gr: ForeignRecord, field: string, allowed?: readonly T[], fallback?: T): T | '' | undefined {
    const value = str(gr, field)
    if (!allowed) return value as T | ''
    return oneOf(value, allowed) ?? fallback
}

export function bool(gr: ForeignRecord, field: string): boolean {
    const value = valueOf(gr, field)
    return value === '1' || value === 'true' || value === (true as unknown)
}

export interface RowOutcome {
    state: 'inserted' | 'updated' | 'error' | 'ignored'
    comment: string
}

export function rowError(comment: string): RowOutcome {
    return { state: 'error', comment }
}

export function finishImportRow(row: GlideRecord, outcome: RowOutcome): void {
    row.setValue('sys_import_state', outcome.state)
    row.setValue('sys_import_state_comment', outcome.comment)
    // The row was handled all the same; unsaved, it still shows as not imported.
    if (!row.update()) warnRefused(row, `Import row ${row.getUniqueValue()} of ${row.getTableName()}: outcome "${outcome.state}" not saved`)
}
