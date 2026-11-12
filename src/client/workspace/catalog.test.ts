import { describe, expect, it } from 'vitest'
import { holdsInEveryClause } from '../../server/domain/encoded-query'
import { SHARED_TABLE_CONDITION } from '../../server/domain/fleet'
import { BROAD_STAFF, MONEY_READERS, PROVIDER_STAFF, ROLE } from '../../server/domain/roles'
import { listQuery, type Field, type ListView } from '../lib/sn'
import { AUDIENCE, CATEGORIES, listById, menuFor } from './catalog'
import { DASHBOARD, tabsFor } from './dashboard'

const LISTS = CATEGORIES.flatMap((category) => category.lists)
const WIDGETS = DASHBOARD.flatMap((tab) => tab.widgets)
const onShared = <T extends { table: string }>(found: readonly T[]) => found.filter(({ table }) => table in SHARED_TABLE_CONDITION)

/** Every column searchable and sortable: the most a user's search and sort can reach. */
const fieldsOf = (columns: readonly string[]): Field[] =>
    columns.map((name) => ({ name, label: name, kind: 'text', references: null, searchAs: name, sortable: true }))

const holding = (...roles: string[]) => ({ holdsAny: (group: readonly string[]) => group.some((role) => roles.includes(role)) })

const VIEW: ListView = { page: 0, size: 50, sort: null, search: '' }
const HOSTILE_VIEWS: ListView[] = [
    VIEW,
    { ...VIEW, search: 'cisco' },
    { ...VIEW, search: 'x^NQactive=true' },
    { ...VIEW, search: '^NQ^NQ' },
    { ...VIEW, search: 'a^ORx_daas_ham_fleet=false' },
    { ...VIEW, sort: { id: 'a^NQactive=true', desc: false } },
    { ...VIEW, sort: { id: 'sys_id', desc: true }, search: 'x^NQ' },
    { ...VIEW, page: 1e9, size: 1e9 },
]

/** The Table and Stats APIs run a condition's javascript: for the reader, so only these gs date helpers may appear. */
const DATE_HELPERS = ['gs.beginningOfToday()', 'gs.beginningOfLastMonth()', 'gs.endOfLastMonth()', 'gs.beginningOfLast12Months()']

describe('the workspace catalog', () => {
    it.each(onShared(LISTS))('keeps $id to the app’s records for any search and sort', (list) => {
        for (const view of [...HOSTILE_VIEWS, ...list.columns.map((id) => ({ ...VIEW, sort: { id, desc: false }, search: 'x' }))]) {
            const query = listQuery(list, list.order, view, fieldsOf(list.columns))
            expect(holdsInEveryClause(query, SHARED_TABLE_CONDITION[list.table] ?? ''), `${list.id} ${JSON.stringify(view)}: ${query}`).toBe(true)
        }
    })

    it('has lists on the shared tables to check', () => {
        expect(onShared(LISTS).length).toBeGreaterThanOrEqual(10)
    })

    it('has unique list ids, each found by id', () => {
        expect(new Set(LISTS.map((list) => list.id)).size).toBe(LISTS.length)
        for (const list of LISTS) expect(listById(list.id)).toBe(list)
        expect(listById('no_such_list')).toBeUndefined()
    })

    it('runs no script in a condition but the date helpers', () => {
        const scripts = [...LISTS.map((list) => list.filter), ...WIDGETS.map((widget) => widget.source.filter)].flatMap((filter) =>
            [...filter.matchAll(/javascript:([^@^]*)/g)].map(([, script]) => script),
        )
        expect(scripts.length).toBeGreaterThan(0)
        for (const script of scripts) expect(DATE_HELPERS).toContain(script)
    })

    it('offers each audience to exactly its role group', () => {
        expect(AUDIENCE.staff).toBe(PROVIDER_STAFF)
        expect(AUDIENCE.broadStaff).toBe(BROAD_STAFF)
        expect(AUDIENCE.money).toBe(MONEY_READERS)
        expect(AUDIENCE.admin).toEqual([ROLE.admin])
    })

    it('offers a session only the lists and tabs of the audiences it holds', () => {
        const tech = holding(ROLE.inventoryTech)
        expect(menuFor(tech).flatMap((category) => category.lists).every((list) => list.audience === 'staff')).toBe(true)
        expect(tabsFor(tech).map((tab) => tab.id)).not.toContain('margin')
        expect(tabsFor(holding(ROLE.finance)).map((tab) => tab.id)).toContain('margin')
        expect(menuFor(holding())).toEqual([])
        expect(menuFor(holding(ROLE.admin)).flatMap((category) => category.lists).map((list) => list.id)).toEqual(['admin_jobs'])
    })
})

describe('the workspace dashboard', () => {
    it('counts the app’s records only on the shared tables', () => {
        expect(onShared(WIDGETS.map((widget) => ({ id: widget.id, ...widget.source }))).length).toBeGreaterThanOrEqual(7)
        for (const widget of WIDGETS.filter((found) => found.source.table in SHARED_TABLE_CONDITION)) {
            expect(holdsInEveryClause(widget.source.filter, SHARED_TABLE_CONDITION[widget.source.table] ?? ''), widget.id).toBe(true)
        }
    })

    it('has unique tab and widget ids', () => {
        expect(new Set(DASHBOARD.map((tab) => tab.id)).size).toBe(DASHBOARD.length)
        expect(new Set(WIDGETS.map((widget) => widget.id)).size).toBe(WIDGETS.length)
    })

    it('drills from a widget to the list of the rows it counts, wherever there is one', () => {
        for (const widget of WIDGETS) {
            const same = LISTS.find((list) => list.table === widget.source.table && list.filter === widget.source.filter)
            expect(widget.drill && listById(widget.drill)?.table, widget.id).toBe(widget.drill ? widget.source.table : undefined)
            expect(widget.drill && listById(widget.drill)?.filter, widget.id).toBe(widget.drill ? widget.source.filter : undefined)
            expect(Boolean(widget.drill), widget.id).toBe(Boolean(same))
        }
    })

    it('offers a role only the widgets on tables it reads, and no tab left without one', () => {
        const widgetsFor = (...roles: string[]) => tabsFor(holding(...roles)).flatMap((tab) => tab.widgets.map((widget) => widget.id))
        const broadStaffOnly = ['pending_line_in_service', 'ended_lines_no_end_date', 'pending_lines', 'lines_by_customer', 'open_exceptions', 'exception_types']
        const forTech = widgetsFor(ROLE.inventoryTech)
        for (const id of broadStaffOnly) expect(forTech, id).not.toContain(id)
        expect(forTech).toEqual(expect.arrayContaining(['open_orders', 'unbilled_in_service', 'ended_line_in_service', 'past_support', 'open_returns', 'phase']))
        expect(widgetsFor(ROLE.noc)).toEqual(expect.arrayContaining(broadStaffOnly))
        expect(widgetsFor(ROLE.finance)).toEqual(WIDGETS.map((widget) => widget.id))
        expect(tabsFor(holding(ROLE.admin))).toEqual([])
        for (const tab of tabsFor(holding(ROLE.inventoryTech))) expect(tab.widgets.length, tab.id).toBeGreaterThan(0)
    })

    it('never sums an amount without its currency', () => {
        for (const widget of WIDGETS) if (widget.chart === 'currencyBar' || widget.chart === 'currencyMatrix') expect(widget.sum.currency, widget.id).toBeTruthy()
    })
})
