import { GlideAggregate, GlideRecord } from '@servicenow/glide'

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

/** How many records match an encoded query (one aggregate query). */
export function count(table: string, encodedQuery: string): number {
    const ga = new GlideAggregate(table)
    ga.addEncodedQuery(encodedQuery)
    ga.addAggregate('COUNT', '')
    ga.query()
    return ga.next() ? Number(ga.getAggregate('COUNT', '')) : 0
}

export function str(gr: GlideRecord, field: string): string {
    const value = gr.getValue(field)
    return value === null || value === undefined ? '' : String(value)
}

export function num(gr: GlideRecord, field: string): number {
    const value = Number(gr.getValue(field))
    return Number.isFinite(value) ? value : 0
}

export function bool(gr: GlideRecord, field: string): boolean {
    const value = gr.getValue(field)
    return value === '1' || value === 'true' || value === (true as unknown)
}
