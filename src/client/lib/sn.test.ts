import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { holdsInEveryClause } from '../../server/domain/encoded-query'
import { countQuery, fieldsQuery, listPageQuery, listQuery, pageWithin, sumQuery, type Field, type ListView } from './sn'

const field = (name: string, overrides: Partial<Field> = {}): Field => ({
    name,
    label: name,
    kind: 'text',
    references: null,
    searchAs: name,
    sortable: true,
    ...overrides,
})

const FIELDS = [field('number'), field('company', { kind: 'reference', references: 'core_company', searchAs: 'company.name' }), field('quantity', { kind: 'number', searchAs: null })]
const VIEW: ListView = { page: 0, size: 50, sort: null, search: '' }
const SOURCE = { table: 'alm_hardware', filter: 'install_status=1^x_daas_ham_fleet=true^NQinstall_status=6^x_daas_ham_fleet=true' }

describe('listQuery', () => {
    it("orders by the list's own order when the user picked none", () => {
        expect(listQuery(SOURCE, [{ id: 'number', desc: true }], VIEW, FIELDS)).toBe(`${SOURCE.filter}^ORDERBYDESCnumber`)
    })

    it("orders by the user's sort instead, when it names a sortable column shown", () => {
        expect(listQuery(SOURCE, [{ id: 'number', desc: true }], { ...VIEW, sort: { id: 'quantity', desc: false } }, FIELDS)).toBe(`${SOURCE.filter}^ORDERBYquantity`)
    })

    it("ignores a sort on a column the list does not show or the platform cannot sort", () => {
        const unsortable = [field('number', { sortable: false })]
        expect(listQuery(SOURCE, [], { ...VIEW, sort: { id: 'sys_id', desc: false } }, FIELDS)).toBe(SOURCE.filter)
        expect(listQuery(SOURCE, [], { ...VIEW, sort: { id: 'number', desc: false } }, unsortable)).toBe(SOURCE.filter)
    })

    it('searches the text and reference columns in every ^NQ clause, so the search keeps to the fleet', () => {
        const query = listQuery(SOURCE, [], { ...VIEW, search: 'cisco' }, FIELDS)
        const search = 'numberLIKEcisco^ORcompany.nameLIKEcisco'
        expect(query).toBe(`install_status=1^x_daas_ham_fleet=true^${search}^NQinstall_status=6^x_daas_ham_fleet=true^${search}`)
        expect(holdsInEveryClause(query, 'x_daas_ham_fleet=true')).toBe(true)
    })

    it('drops a ^ typed into the search, so it adds no condition or clause', () => {
        const query = listQuery(SOURCE, [], { ...VIEW, search: 'x^NQactive=true' }, [field('number')])
        expect(query.split('^NQ')).toHaveLength(2)
        expect(holdsInEveryClause(query, 'x_daas_ham_fleet=true')).toBe(true)
    })
})

describe('pageWithin', () => {
    it.each([
        { page: 0, total: 0, shown: 0 },
        { page: 0, total: 120, shown: 0 },
        { page: 2, total: 120, shown: 2 },
        { page: 1, total: 51, shown: 1 },
    ])('keeps page $page of $total rows', ({ page, total, shown }) => {
        expect(pageWithin({ ...VIEW, page }, total)).toBe(shown)
    })

    it.each([
        { page: 1, total: 50, shown: 0 },
        { page: 1, total: 12, shown: 0 },
        { page: 3, total: 120, shown: 2 },
        { page: 2, total: 100, shown: 1 },
        { page: 4, total: 0, shown: 0 },
        { page: 1e9, total: 51, shown: 1 },
    ])('shows the last page with rows for page $page of a list shrunk to $total', ({ page, total, shown }) => {
        expect(pageWithin({ ...VIEW, page }, total)).toBe(shown)
    })
})

/** Answers each platform GET with `replies(url)` under `result`, and returns the URLs asked for. */
function answer(replies: (url: URL) => { body: unknown; total?: number }): URL[] {
    const calls: URL[] = []
    vi.stubGlobal('window', {})
    vi.stubGlobal(
        'fetch',
        vi.fn(async (to: string) => {
            const url = new URL(to, 'http://instance')
            calls.push(url)
            const { body, total } = replies(url)
            return new Response(JSON.stringify({ result: body }), { headers: total === undefined ? {} : { 'X-Total-Count': String(total) } })
        }),
    )
    return calls
}

afterEach(() => vi.unstubAllGlobals())

describe('fieldsQuery', () => {
    const META: Record<string, Record<string, object>> = {
        x_daas_ham_order: {
            number: { label: 'Number', type: 'string', cansort: true },
            agreement: { label: 'Agreement', internal_type: 'reference', reference: 'x_daas_ham_agreement', reference_display_field: 'number', cansort: true },
            site: { label: 'Site', internal_type: 'reference', reference: 'cmn_location' },
            quantity: { label: 'Quantity', type: 'integer' },
            active: { label: 'Active', internal_type: 'boolean' },
        },
        x_daas_ham_agreement: { currency: { label: 'Currency', type: 'string' } },
    }

    const fields = (names: string[]) => {
        const calls = answer((url) => ({ body: { columns: META[url.pathname.replace('/api/now/ui/meta/', '')] } }))
        return { calls, fields: new QueryClient().fetchQuery(fieldsQuery('x_daas_ham_order', names)) }
    }

    it('reads a text column as searchable under its own name', async () => {
        expect(await fields(['number']).fields).toEqual([{ name: 'number', label: 'Number', kind: 'text', references: null, searchAs: 'number', sortable: true }])
    })

    it('reads a reference with the table it points at, searched by its display field', async () => {
        const [agreement] = await fields(['agreement']).fields
        expect(agreement).toMatchObject({ kind: 'reference', references: 'x_daas_ham_agreement', searchAs: 'agreement.number', sortable: true })
    })

    it('does not search a reference whose display field the metadata lacks', async () => {
        const [site] = await fields(['site']).fields
        expect(site).toMatchObject({ kind: 'reference', references: 'cmn_location', searchAs: null, sortable: false })
    })

    it('reads number and boolean columns as not searchable', async () => {
        const [quantity, active] = await fields(['quantity', 'active']).fields
        expect(quantity).toMatchObject({ kind: 'number', references: null, searchAs: null })
        expect(active).toMatchObject({ kind: 'boolean', references: null, searchAs: null })
    })

    it('labels a dot-walk with each step and reads the last column', async () => {
        const [currency] = await fields(['agreement.currency']).fields
        expect(currency).toMatchObject({ label: 'Agreement › Currency', kind: 'text', searchAs: 'agreement.currency', sortable: false })
    })

    it('shows a column the metadata lacks under its own name', async () => {
        expect(await fields(['secret']).fields).toEqual([{ name: 'secret', label: 'secret', kind: 'text', references: null, searchAs: 'secret', sortable: false }])
    })

    it("keeps the order of the names and reads each table's metadata once", async () => {
        const { calls, fields: read } = fields(['quantity', 'number', 'agreement.currency', 'agreement'])
        expect((await read).map((field) => field.name)).toEqual(['quantity', 'number', 'agreement.currency', 'agreement'])
        expect(calls.map((url) => url.pathname).sort()).toEqual(['/api/now/ui/meta/x_daas_ham_agreement', '/api/now/ui/meta/x_daas_ham_order'])
    })
})

describe('listPageQuery', () => {
    const fields = [field('number'), field('company'), field('gone')]
    const source = { table: 'x_daas_ham_order', filter: 'active=true' }
    const view = { ...VIEW, page: 2 }
    const RECORDS = [
        { sys_id: { value: 'id1', display_value: 'id1' }, number: { value: 'NORD1', display_value: 'NORD1' }, company: { value: 'c1', display_value: 'Acme' } },
        { sys_id: 'id2', number: 'NORD2', company: { value: null } },
    ]

    const page = (total?: number) => {
        const calls = answer(() => ({ body: RECORDS, total }))
        return { calls, page: new QueryClient().fetchQuery(listPageQuery(source, [], view, fields)) }
    }

    it("reads each cell's stored value and the text shown for it", async () => {
        const { rows } = await page(120).page
        expect(rows[0]).toEqual({
            id: 'id1',
            value: { sys_id: 'id1', number: 'NORD1', company: 'c1', gone: '' },
            display: { sys_id: 'id1', number: 'NORD1', company: 'Acme', gone: '' },
        })
    })

    it('reads a plain cell as both, and a missing or null one as empty', async () => {
        const { rows } = await page(120).page
        expect(rows[1].id).toBe('id2')
        expect([rows[1].value.number, rows[1].display.number]).toEqual(['NORD2', 'NORD2'])
        expect([rows[1].value.company, rows[1].display.company]).toEqual(['', ''])
    })

    it("takes the total from the reply's row count header", async () => {
        expect((await page(120).page).total).toBe(120)
        expect((await page().page).total).toBe(0)
    })

    it('asks for the page by offset, for its fields and sys_id', async () => {
        const { calls, page: read } = page(120)
        await read
        expect(calls[0].pathname).toBe('/api/now/table/x_daas_ham_order')
        expect(Object.fromEntries(calls[0].searchParams)).toMatchObject({
            sysparm_offset: '100',
            sysparm_limit: '50',
            sysparm_fields: 'sys_id,number,company,gone',
            sysparm_display_value: 'all',
            sysparm_query: listQuery(source, [], view, fields),
        })
    })
})

describe('countQuery', () => {
    const source = { table: 'x_daas_ham_order', filter: 'active=true' }

    const count = (body: unknown, by?: string) => {
        const calls = answer(() => ({ body }))
        return { calls, tally: new QueryClient().fetchQuery(countQuery(source, by)) }
    }

    it('counts a source with no grouping from a reply that is one object', async () => {
        const { calls, tally } = count({ stats: { count: '7' } })
        expect(await tally).toEqual([{ key: '', label: '(empty)', count: 7 }])
        expect(calls[0].searchParams.get('sysparm_group_by')).toBeNull()
        expect(calls[0].searchParams.get('sysparm_count')).toBe('true')
    })

    it('counts per group, largest first, labelled by the text shown, then the value, then (empty)', async () => {
        const { calls, tally } = count(
            [
                { stats: { count: '2' }, groupby_fields: [{ field: 'stage', value: 'draft', display_value: 'Draft' }] },
                { stats: { count: '9' }, groupby_fields: [{ field: 'stage', value: 'x1', display_value: '' }] },
                { stats: { count: '5' }, groupby_fields: [{ field: 'stage', value: '', display_value: '' }] },
            ],
            'stage',
        )
        expect(await tally).toEqual([
            { key: 'x1', label: 'x1', count: 9 },
            { key: '', label: '(empty)', count: 5 },
            { key: 'draft', label: 'Draft', count: 2 },
        ])
        expect(calls[0].searchParams.get('sysparm_group_by')).toBe('stage')
    })

    it('counts a group with no stats as none', async () => {
        const { tally } = count([{ groupby_fields: [{ field: 'stage', value: 'draft', display_value: 'Draft' }] }], 'stage')
        expect(await tally).toEqual([{ key: 'draft', label: 'Draft', count: 0 }])
    })
})

describe('sumQuery', () => {
    const source = { table: 'x_daas_ham_fee', filter: 'active=true' }
    const money = { amount: 'amount', currency: 'currency' }

    const sum = (body: unknown, by?: string) => {
        const calls = answer(() => ({ body }))
        return { calls, tally: new QueryClient().fetchQuery(sumQuery(source, money, by)) }
    }

    it('sums per currency, never across', async () => {
        const { calls, tally } = sum([
            { stats: { sum: { amount: '120.5' } }, groupby_fields: [{ field: 'currency', value: 'EUR', display_value: 'EUR' }] },
            { stats: { sum: { amount: '90' } }, groupby_fields: [{ field: 'currency', value: 'NOK', display_value: 'NOK' }] },
        ])
        expect(await tally).toEqual([
            { key: '', label: '(empty)', currency: 'EUR', amount: 120.5 },
            { key: '', label: '(empty)', currency: 'NOK', amount: 90 },
        ])
        expect(calls[0].searchParams.get('sysparm_group_by')).toBe('currency')
        expect(calls[0].searchParams.get('sysparm_sum_fields')).toBe('amount')
    })

    it('sums per group and currency', async () => {
        const { calls, tally } = sum(
            [
                {
                    stats: { sum: { amount: '40' } },
                    groupby_fields: [
                        { field: 'customer', value: 'cu1', display_value: 'Acme' },
                        { field: 'currency', value: 'EUR', display_value: 'EUR' },
                    ],
                },
            ],
            'customer',
        )
        expect(await tally).toEqual([{ key: 'cu1', label: 'Acme', currency: 'EUR', amount: 40 }])
        expect(calls[0].searchParams.get('sysparm_group_by')).toBe('customer,currency')
    })

    it("reads a missing sum as 0 and a missing currency as ''", async () => {
        const { tally } = sum([{ groupby_fields: [] }])
        expect(await tally).toEqual([{ key: '', label: '(empty)', currency: '', amount: 0 }])
    })
})
