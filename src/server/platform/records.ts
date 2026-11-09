import { GlideAggregate, type GlideElement, GlideRecord } from '@servicenow/glide'

/** Small Glide helpers shared by repositories and gateways. Keep this module free of business rules. */

export function findById(table: string, sysId: string): GlideRecord | null {
    if (!sysId) return null
    const gr = new GlideRecord(table)
    return gr.get(sysId) ? gr : null
}

/** Values of one field for every record matching an encoded query (bounded by `limit`). */
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
 * Delete every record matching an encoded query with one set-based delete (business rules run unless `businessRules`
 * is false), and return whether none is left. deleteMultiple reports nothing and a rule can keep a record, so a
 * caller that must not go on past one checks this. It looks past before-query rules, so a record hidden from the user
 * still counts as left.
 */
export function deleteWhere(table: string, encodedQuery: string, options: { businessRules?: boolean } = {}): boolean {
    const gr = new GlideRecord(table)
    gr.addEncodedQuery(encodedQuery)
    if (options.businessRules === false) gr.setWorkflow(false)
    gr.deleteMultiple()
    const left = new GlideRecord(table)
    left.addEncodedQuery(encodedQuery)
    left.setWorkflow(false)
    // One survivor is enough to tell; a full count would read every one (e.g. of a purge).
    left.setLimit(1)
    left.query()
    return !left.hasNext()
}

/** Whether any record matches an encoded query (stops at the first). */
export function exists(table: string, encodedQuery: string): boolean {
    const gr = new GlideRecord(table)
    gr.addEncodedQuery(encodedQuery)
    gr.setLimit(1)
    gr.query()
    return gr.hasNext()
}

/** How many records match an encoded query (one aggregate query). */
export function count(table: string, encodedQuery: string): number {
    const ga = new GlideAggregate(table)
    ga.addEncodedQuery(encodedQuery)
    ga.addAggregate('COUNT', '')
    ga.query()
    return ga.next() ? Number(ga.getAggregate('COUNT', '')) : 0
}

/** Why the platform refused to save (or delete) `record`: its last error message, or `fallback` when it gave none. */
export function refusal(record: GlideRecord, fallback = 'the save was refused'): string {
    return record.getLastErrorMessage() || fallback
}

/**
 * The value of `field`, which may be dot-walked ('reference.field'). In a scoped script a GlideRecord's getValue does
 * not dot-walk: it gives null for a dotted name, so those are read through getElement, whose value is null when the path
 * crosses an empty reference (and which is null itself for an unknown field). Not for a GlideAggregate: scoped scripts
 * may not call its getElement, and its getValue does give a dotted group-by.
 */
function valueOf(gr: GlideRecord, field: string): string | null {
    if (!field.includes('.')) return gr.getValue(field)
    const element: GlideElement | null = gr.getElement(field)
    return element ? element.getValue() : null
}

export function str(gr: GlideRecord, field: string): string {
    const value = valueOf(gr, field)
    return value === null || value === undefined ? '' : String(value)
}

export function num(gr: GlideRecord, field: string): number {
    const value = Number(valueOf(gr, field))
    return Number.isFinite(value) ? value : 0
}

export function bool(gr: GlideRecord, field: string): boolean {
    const value = valueOf(gr, field)
    return value === '1' || value === 'true' || value === (true as unknown)
}
