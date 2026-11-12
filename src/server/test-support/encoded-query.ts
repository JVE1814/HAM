/**
 * The one encoded-query evaluator of the unit tests: whether a record matches a ServiceNow encoded query, so a test of
 * a query says which records it finds instead of spelling the query out again.
 *
 * It knows what the app's queries use and throws on everything else — an operator it has never heard of must fail the
 * test, not match every record:
 *   - terms joined by `^` (AND), `^OR` (OR, which binds tighter than `^`) and `^NQ` (a new query, OR-ed with the ones
 *     before it; it binds loosest);
 *   - `=`, `!=`, `<`, `<=`, `>`, `>=`, `IN`, `NOT IN`, `LIKE` (contains), `STARTSWITH`, `ISEMPTY`, `ISNOTEMPTY`;
 *   - field names as written, dot-walks included (`order.agreement`): `valueOf` resolves them;
 *   - a `javascript:` operand only when `script` gives its value.
 *
 * A blank value ('') matches `ISEMPTY` and `=` against a blank operand, and no other term: neither `!=`, `NOT IN` nor a
 * comparison, as in SQL. The app's queries never leave a blank to those operators (they say `^OR…ISEMPTY`), and under
 * this reading a query that forgets to loses the blank record in its test.
 *
 * Text is compared exactly, except by `LIKE` and `STARTSWITH`, which ignore case as the platform does. `<`, `<=`, `>`
 * and `>=` compare as numbers when both sides are written as numbers and as text otherwise (Glide dates sort as text).
 */

/** The value of a field of the record under test ('' for blank), by the name the query uses — a dot-walk as written. */
export type ValueOf = (field: string) => string

/** The value of a `javascript:` operand, by its expression (`gs.beginningOfToday()`). */
export type ScriptValue = (expression: string) => string

const TERM = /^([a-z][a-z0-9_.]*)(NOT IN|IN|ISNOTEMPTY|ISEMPTY|STARTSWITH|LIKE|!=|>=|<=|=|>|<)(.*)$/s
const NUMBER = /^-?\d{1,15}(\.\d+)?$/
const SCRIPT = 'javascript:'

function noScript(expression: string): never {
    throw new Error(`encoded query: no value given for the operand ${SCRIPT}${expression}`)
}

/** How the platform orders two stored values: as numbers when both are numbers, else as text. Sorts use it too. */
export function compare(value: string, operand: string): number {
    if (NUMBER.test(value) && NUMBER.test(operand)) return Number(value) - Number(operand)
    return value < operand ? -1 : value > operand ? 1 : 0
}

function holds(term: string, valueOf: ValueOf, script: ScriptValue): boolean {
    const [, field, operator, written] = TERM.exec(term) ?? []
    // INSTANCEOF is the one operator that starts like one this evaluator knows.
    if (!field || (operator === 'IN' && written.startsWith('STANCEOF'))) throw new Error(`encoded query: unknown term "${term}"`)
    const value = valueOf(field)
    if (operator === 'ISEMPTY' || operator === 'ISNOTEMPTY') {
        if (written) throw new Error(`encoded query: unknown term "${term}"`)
        return (value === '') === (operator === 'ISEMPTY')
    }
    const operand = written.startsWith(SCRIPT) ? script(written.slice(SCRIPT.length)) : written
    if (operator === '=') return value === operand
    if (value === '') return false
    switch (operator) {
        case '!=':
            return value !== operand
        case 'IN':
            return operand.split(',').includes(value)
        case 'NOT IN':
            return !operand.split(',').includes(value)
        case 'LIKE':
            return value.toLowerCase().includes(operand.toLowerCase())
        case 'STARTSWITH':
            return value.toLowerCase().startsWith(operand.toLowerCase())
        case '<':
            return compare(value, operand) < 0
        case '<=':
            return compare(value, operand) <= 0
        case '>':
            return compare(value, operand) > 0
        case '>=':
            return compare(value, operand) >= 0
        default:
            throw new Error(`encoded query: unknown operator in "${term}"`)
    }
}

/**
 * Whether the record `valueOf` reads matches `query`. The empty query matches every record. Throws on a term or an
 * operator it does not know, whether or not the terms before it already decided the answer.
 */
export function matchesQuery(query: string, valueOf: ValueOf, script: ScriptValue = noScript): boolean {
    if (!query) return true
    // Each ^NQ query is its AND-ed groups; each group is the OR-ed terms of one `^OR` run.
    const queries: string[][][] = [[]]
    for (const token of query.split('^')) {
        const groups = queries[queries.length - 1]
        if (token.startsWith('NQ')) queries.push([[token.slice(2)]])
        else if (token.startsWith('OR')) {
            if (groups.length === 0) throw new Error(`encoded query: "^${token}" has no term before it in "${query}"`)
            groups[groups.length - 1].push(token.slice(2))
        } else groups.push([token])
    }
    const verdicts = queries.map((groups) => {
        if (groups.length === 0) throw new Error(`encoded query: nothing before ^NQ in "${query}"`)
        return groups.map((group) => group.map((term) => holds(term, valueOf, script)).some(Boolean)).every(Boolean)
    })
    return verdicts.some(Boolean)
}

/** `matchesQuery` over a plain record of field values: a field the record does not name is blank. */
export function recordMatches(query: string, record: Readonly<Record<string, string>>, script?: ScriptValue): boolean {
    return matchesQuery(query, (field) => record[field] ?? '', script)
}
