import { describe, expect, it } from 'vitest'
import { holdsInEveryClause } from '../../server/domain/encoded-query'
import { listQuery, pageWithin, type Field, type ListView } from './sn'

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
