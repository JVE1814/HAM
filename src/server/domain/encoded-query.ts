/**
 * Add `condition` to every top-level OR group of `query`. A condition appended after `^NQ` binds
 * only to the last group, so it has to be repeated in each one.
 */
export function andEachClause(query: string, condition: string): string {
    if (!query) return condition
    return query
        .split('^NQ')
        .map((clause) => (clause ? `${clause}^${condition}` : condition))
        .join('^NQ')
}

/**
 * `field` IN `values` (or NOT IN), blanks and repeats left out; null when no value is left. An encoded query with an
 * empty list is no condition at all, so an IN on nothing would match every record: a caller says what nothing means.
 */
export function anyOf(field: string, values: readonly string[], operator: 'IN' | 'NOT IN' = 'IN'): string | null {
    const unique = [...new Set(values.filter(Boolean))]
    return unique.length > 0 ? `${field}${operator}${unique.join(',')}` : null
}
