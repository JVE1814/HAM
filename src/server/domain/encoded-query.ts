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

/** A term that is ORed to the one before it (`^OR`), unlike an ordering (`^ORDERBY`). */
const isOrTerm = (term: string) => term.startsWith('OR') && !term.startsWith('ORDERBY')

/**
 * Whether `condition` holds in every ^NQ clause of `query`: one of the clause's AND terms, not one side of an `^OR`.
 * A condition after an ^NQ binds to the last clause only.
 */
export function holdsInEveryClause(query: string, condition: string): boolean {
    return query.split('^NQ').every((clause) => {
        const terms = clause.split('^')
        return terms.some((term, i) => term === condition && !isOrTerm(terms[i + 1] ?? ''))
    })
}

/** One ordering of an encoded query, in the shape TanStack Table sorts by. */
export interface Ordering {
    id: string
    desc: boolean
}

/** `query`'s conditions and its orderings, split apart: `a=1^ORDERBYDESCb^EQ` is `a=1` ordered by `b` descending. */
export function splitOrder(query: string): { filter: string; order: Ordering[] } {
    const filter: string[] = []
    const order: Ordering[] = []
    for (const term of query.split('^')) {
        if (term.startsWith('ORDERBYDESC')) order.push({ id: term.slice('ORDERBYDESC'.length), desc: true })
        else if (term.startsWith('ORDERBY')) order.push({ id: term.slice('ORDERBY'.length), desc: false })
        else if (term !== 'EQ' && term !== '') filter.push(term)
    }
    return { filter: filter.join('^'), order }
}
