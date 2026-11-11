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
