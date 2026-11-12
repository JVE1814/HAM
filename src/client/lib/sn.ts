import { queryOptions } from '@tanstack/react-query'
import { andEachClause, type Ordering } from '../../server/domain/encoded-query'
import { platformGet } from '../api'

/*
 * The platform's REST APIs as the pages read them: column metadata (ui/meta), records (Table API) and counts and sums
 * (Stats API). The payloads are parsed here; no signature below carries one. The rows a user gets are what the ACLs
 * and the app's before-query rules (ADR 0005) let them read: nothing here filters for visibility.
 */

export type FieldKind = 'text' | 'number' | 'boolean' | 'reference'

/** A column of a table, possibly dot-walked (`agreement.currency`), as a grid shows it. */
export interface Field {
    name: string
    /** The dictionary's label in the user's language; a dot-walk reads "Agreement › Currency". */
    label: string
    kind: FieldKind
    /** The table a reference points at, so its cell links to that record's form. */
    references: string | null
    /** The field searched for a reference's text (`company.name`); the field itself for text. Null: not searchable. */
    searchAs: string | null
    sortable: boolean
}

/** One record: its sys_id and, per field, the text the platform formats for this user and the stored value. */
export interface SnRow {
    id: string
    display: Readonly<Record<string, string>>
    value: Readonly<Record<string, string>>
}

export interface Page<T> {
    rows: T[]
    total: number
}

/** What a list or a count reads: a table and an encoded query of conditions only (no ORDERBY). */
export interface Source {
    table: string
    filter: string
}

/** What a user asks of a server list: which page, which one column to sort by (null: the list's own order), what to find. */
export interface ListView {
    page: number
    size: number
    sort: Ordering | null
    search: string
}

/**
 * The page of `view` to show of `total` rows: its own, or the last one with rows when the list has shrunk since the
 * address was written (a work queue does, and Back returns to `?page=2` of it).
 */
export function pageWithin(view: ListView, total: number): number {
    return Math.min(view.page, Math.max(0, Math.ceil(total / view.size) - 1))
}

/** The classic form of a record, which carries every UI action and all form logic. */
export function recordHref(table: string, id: string): string {
    return `/${table}.do?sys_id=${encodeURIComponent(id)}`
}

interface MetaColumn {
    label?: string
    type?: string
    internal_type?: string
    reference?: string
    reference_display_field?: string
    cansort?: boolean
}

const NUMBER_TYPES = new Set(['integer', 'longint', 'decimal', 'float', 'currency', 'price', 'percent_complete'])

function kindOf(column: MetaColumn): FieldKind {
    const type = column.internal_type ?? column.type ?? ''
    if (type === 'reference') return 'reference'
    if (type === 'boolean') return 'boolean'
    return NUMBER_TYPES.has(type) ? 'number' : 'text'
}

const metaQuery = (table: string) =>
    queryOptions({
        queryKey: ['sn', 'meta', table],
        staleTime: Infinity,
        queryFn: async ({ signal }) => {
            const { result } = await platformGet(`/ui/meta/${encodeURIComponent(table)}`, {}, signal)
            return ((result as { columns?: Record<string, MetaColumn> }).columns ?? {}) as Readonly<Record<string, MetaColumn>>
        },
    })

/**
 * The Fields `names` name on `table`, in that order. A dot-walk follows each reference's table. A name the metadata
 * lacks (a column the user may not read) is shown under its own name rather than failing the list.
 */
export const fieldsQuery = (table: string, names: readonly string[]) =>
    queryOptions({
        queryKey: ['sn', 'fields', table, names],
        staleTime: Infinity,
        queryFn: async ({ client }) =>
            Promise.all(
                names.map(async (name): Promise<Field> => {
                    const labels: string[] = []
                    let on = table
                    let column: MetaColumn | undefined
                    for (const part of name.split('.')) {
                        column = on ? (await client.ensureQueryData(metaQuery(on)))[part] : undefined
                        labels.push(column?.label ?? part)
                        on = column?.reference ?? ''
                    }
                    const kind = column ? kindOf(column) : 'text'
                    const display = column?.reference_display_field
                    return {
                        name,
                        label: labels.join(' › '),
                        kind,
                        references: kind === 'reference' ? (column?.reference ?? null) : null,
                        searchAs: kind === 'text' ? name : kind === 'reference' && display ? `${name}.${display}` : null,
                        sortable: column?.cansort ?? false,
                    }
                }),
            ),
    })

/**
 * The encoded query a page of `source` sends: its conditions, narrowed by the search in every ^NQ clause (a condition
 * after ^NQ binds to the last clause only), then ordered by the view's sort if it names a sortable field shown,
 * otherwise by `order`. The searched text cannot add a condition: its `^`, which separates terms, is dropped.
 */
export function listQuery(source: Source, order: readonly Ordering[], view: ListView, fields: readonly Field[]): string {
    const searchable = fields.flatMap((field) => (field.searchAs ? [field.searchAs] : []))
    const term = view.search.replace(/\^/g, '').trim()
    const filter = term && searchable.length ? andEachClause(source.filter, searchable.map((name) => `${name}LIKE${term}`).join('^OR')) : source.filter
    const sort = view.sort
    const chosen = sort && fields.some((field) => field.name === sort.id && field.sortable) ? [sort] : order
    return filter + chosen.map(({ id, desc }) => `^ORDERBY${desc ? 'DESC' : ''}${id}`).join('')
}

type Cell = { value?: unknown; display_value?: unknown } | string | undefined

const text = (value: unknown) => (value === null || value === undefined ? '' : String(value))

export const listPageQuery = (source: Source, order: readonly Ordering[], view: ListView, fields: readonly Field[]) => {
    const query = listQuery(source, order, view, fields)
    const names = fields.map((field) => field.name)
    return queryOptions({
        queryKey: ['sn', 'table', source.table, query, names, view.page, view.size],
        queryFn: async ({ signal }): Promise<Page<SnRow>> => {
            const { result, total } = await platformGet(
                `/table/${encodeURIComponent(source.table)}`,
                {
                    sysparm_query: query,
                    sysparm_fields: ['sys_id', ...names].join(','),
                    sysparm_display_value: 'all',
                    sysparm_exclude_reference_link: 'true',
                    sysparm_limit: String(view.size),
                    sysparm_offset: String(view.page * view.size),
                },
                signal,
            )
            const rows = (result as Array<Record<string, Cell>>).map((record): SnRow => {
                const display: Record<string, string> = {}
                const value: Record<string, string> = {}
                for (const name of ['sys_id', ...names]) {
                    const cell = record[name]
                    value[name] = typeof cell === 'object' ? text(cell.value) : text(cell)
                    display[name] = typeof cell === 'object' ? text(cell.display_value) : text(cell)
                }
                return { id: value.sys_id, display, value }
            })
            return { rows, total }
        },
    })
}

/** Counts per group, largest first; one entry with key '' when ungrouped. */
export type Tally = Array<{ key: string; label: string; count: number }>

/** Sums per group and currency. It has no total on purpose: entries in two currencies are never added. */
export type MoneyTally = Array<{ key: string; label: string; currency: string; amount: number }>

/** A field of amounts and the field holding their currency: a sum is never asked for without it. */
export interface Money {
    amount: string
    currency: string
}

interface StatsGroup {
    stats?: { count?: string; sum?: Record<string, string> }
    groupby_fields?: Array<{ field: string; value: string; display_value?: string }>
}

async function stats(source: Source, groupBy: string[], params: Record<string, string>, signal: AbortSignal): Promise<StatsGroup[]> {
    const { result } = await platformGet(
        `/stats/${encodeURIComponent(source.table)}`,
        { sysparm_query: source.filter, sysparm_display_value: 'all', ...(groupBy.length ? { sysparm_group_by: groupBy.join(',') } : {}), ...params },
        signal,
    )
    return Array.isArray(result) ? result : [result as StatsGroup]
}

const groupOf = (group: StatsGroup, field: string) => group.groupby_fields?.find((entry) => entry.field === field)

/** How many rows of `source` there are, per value of `by` when given. */
export const countQuery = (source: Source, by?: string) =>
    queryOptions({
        queryKey: ['sn', 'count', source, by ?? null],
        queryFn: async ({ signal }): Promise<Tally> =>
            (await stats(source, by ? [by] : [], { sysparm_count: 'true' }, signal))
                .map((group) => {
                    const entry = by ? groupOf(group, by) : undefined
                    return { key: entry?.value ?? '', label: entry?.display_value || entry?.value || '(empty)', count: Number(group.stats?.count ?? 0) }
                })
                .sort((a, b) => b.count - a.count),
    })

/** The sum of `money.amount` over `source` per currency, and per value of `by` when given. */
export const sumQuery = (source: Source, money: Money, by?: string) =>
    queryOptions({
        queryKey: ['sn', 'sum', source, money, by ?? null],
        queryFn: async ({ signal }): Promise<MoneyTally> =>
            (await stats(source, by ? [by, money.currency] : [money.currency], { sysparm_sum_fields: money.amount }, signal)).map((group) => {
                const entry = by ? groupOf(group, by) : undefined
                const currency = groupOf(group, money.currency)
                return {
                    key: entry?.value ?? '',
                    label: entry?.display_value || entry?.value || '(empty)',
                    currency: currency?.display_value || currency?.value || '',
                    amount: Number(group.stats?.sum?.[money.amount] ?? 0),
                }
            }),
    })
