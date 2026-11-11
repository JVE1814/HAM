import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AUDIENCE, CATEGORIES } from './catalog'
import { DASHBOARD, type Widget } from './dashboard'

/*
 * Temporary: the catalog and the dashboard against the Next Experience workspace's built records (dist/app), which
 * they replace. It goes with the old Fluent files.
 */

const UPDATES = join(new URL('../../../', import.meta.url).pathname, 'dist/app/update')

type Built = Record<string, string> & { $table: string }

const BUILT: Built[] = readdirSync(UPDATES).flatMap((name) => {
    const xml = readFileSync(join(UPDATES, name), 'utf8')
    const table = /<record_update table="(\w+)">/.exec(xml)?.[1]
    if (!table || / action="DELETE"/.test(xml)) return []
    const record: Built = { $table: table }
    for (const [, field = '', attributes = '', value = ''] of xml.matchAll(/^ {4}<(\w+)((?: [^>]*)?)(?:\/>|>([\s\S]*?)<\/\1>)$/gm)) {
        record[field] = value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
        for (const [, name = '', text = ''] of attributes.matchAll(/ (\w+)="([^"]*)"/g)) record[`${field}.${name}`] = text
    }
    return [record]
})

const records = (table: string) => BUILT.filter((record) => record.$table === table)
const byId = (table: string) => new Map(records(table).map((record) => [record.sys_id, record]))
const byOrder = (a: Built, b: Built) => Number(a.order) - Number(b.order)

describe('the catalog against the built workspace lists', () => {
    const categories = records('sys_ux_list_category').sort(byOrder)
    const roles = byId('sys_user_role')
    const applicabilities = byId('sys_ux_applicability')
    const audienceOf = new Map(records('sys_ux_applicability_m2m_list').map((link) => [link.list, applicabilities.get(link.applicability)]))

    it('has the same categories in the same order', () => {
        expect(categories).toHaveLength(10)
        expect(CATEGORIES.map((category) => category.title)).toEqual(categories.map((category) => category.title))
    })

    it('has the same lists in each category, in the same order, with the same table, columns, condition and audience', () => {
        const built = categories.flatMap((category) =>
            records('sys_ux_list')
                .filter((list) => list.category === category.sys_id)
                .sort(byOrder)
                .map((list) => ({
                    category: category.title,
                    title: list.title,
                    table: list.table,
                    columns: list.columns,
                    condition: list.condition,
                    roles: (audienceOf.get(list.sys_id)?.roles ?? '').split(',').map((id) => roles.get(id)?.name ?? id),
                })),
        )
        const ours = CATEGORIES.flatMap((category) =>
            category.lists.map((list) => {
                const query = [list.filter, ...list.order.map(({ id, desc }) => `ORDERBY${desc ? 'DESC' : ''}${id}`)].filter(Boolean).join('^')
                return {
                    category: category.title,
                    title: list.title,
                    table: list.table,
                    columns: list.columns.join(','),
                    condition: query ? `${query}^EQ` : '',
                    roles: [...AUDIENCE[list.audience]],
                }
            }),
        )
        expect(built).toHaveLength(53)
        expect(ours).toEqual(built)
    })
})

describe('the dashboard against the built dashboard', () => {
    const tabs = records('par_dashboard_tab').sort(byOrder)

    const groupFields = (widget: Widget) => {
        switch (widget.chart) {
            case 'score':
                return []
            case 'bar':
            case 'barh':
            case 'donut':
                return [widget.by]
            case 'currencyBar':
                return [widget.sum.currency]
            case 'currencyMatrix':
                return [widget.by, widget.sum.currency]
        }
    }

    it('has the same tabs, widgets, sources, aggregates and groupings, in the same order', () => {
        const built = tabs.flatMap((tab) =>
            records('par_dashboard_widget')
                .filter((widget) => widget['canvas.dashboard_tab'] === tab.sys_id)
                .sort((a, b) => Number(a.y) - Number(b.y) || Number(a.x) - Number(b.x))
                .map((widget) => {
                    const props = JSON.parse(widget.component_props) as {
                        headerTitle: string
                        dataSources: Array<{ tableOrViewName: string; filterQuery: string }>
                        metrics: Array<{ aggregateFunction: string; field?: string }>
                        groupBy?: Array<{ groupBy: Array<{ groupByField: string }>; maxNumberOfGroups: number; showOthers: boolean }>
                    }
                    const group = props.groupBy?.[0]
                    const counted = props.metrics[0]?.aggregateFunction === 'COUNT' && group
                    return {
                        tab: tab.name,
                        title: props.headerTitle,
                        table: props.dataSources[0]?.tableOrViewName,
                        filter: props.dataSources[0]?.filterQuery,
                        aggregate: props.metrics[0]?.aggregateFunction,
                        sum: props.metrics[0]?.field ?? null,
                        groupBy: group?.groupBy.map((field) => field.groupByField) ?? [],
                        top: counted ? group.maxNumberOfGroups : null,
                        others: counted ? group.showOthers : null,
                        span: Number(widget.w) / 4,
                    }
                }),
        )
        const ours = DASHBOARD.flatMap((tab) =>
            tab.widgets.map((widget) => {
                const counted = widget.chart === 'bar' || widget.chart === 'barh' || widget.chart === 'donut'
                const summed = widget.chart === 'currencyBar' || widget.chart === 'currencyMatrix'
                return {
                    tab: tab.title,
                    title: widget.title,
                    table: widget.source.table,
                    filter: widget.source.filter,
                    aggregate: summed ? 'SUM' : 'COUNT',
                    sum: summed ? widget.sum.amount : null,
                    groupBy: groupFields(widget),
                    top: counted ? widget.top : null,
                    others: counted ? widget.others : null,
                    span: widget.span,
                }
            }),
        )
        expect(built).toHaveLength(21)
        expect(ours).toEqual(built)
    })
})
