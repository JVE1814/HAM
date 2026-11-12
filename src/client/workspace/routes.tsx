import { keepPreviousData, useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { createRootRouteWithContext, createRoute, notFound } from '@tanstack/react-router'
import { CheckIcon } from 'lucide-react'
import { useMemo, type ReactNode } from 'react'
import { AppShell, type NavGroup } from '@/components/app-shell'
import { DataGrid, type GridColumn } from '@/components/data-grid'
import { Empty, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { AppContext } from '@/lib/app'
import { sessionQuery } from '@/lib/session'
import { fieldsQuery, listPageQuery, recordHref, type Field, type ListView, type SnRow } from '@/lib/sn'
import { listById, menuFor, type ListId, type WorkspaceList } from './catalog'
import { tabsFor } from './dashboard'
import { WidgetCard } from './widget'

const PAGE_SIZE = 50

const listPath = (id: ListId) => `/lists/${id}`

const rootRoute = createRootRouteWithContext<AppContext>()({
    loader: ({ context }) => context.queryClient.ensureQueryData(sessionQuery),
    component: WorkspaceShell,
})

function WorkspaceShell() {
    const session = useSuspenseQuery(sessionQuery).data
    const nav = useMemo(
        (): NavGroup[] => [
            { items: [{ label: 'Overview', to: '/' }] },
            ...menuFor(session).map((category) => ({ title: category.title, items: category.lists.map((list) => ({ label: list.title, to: listPath(list.id) })) })),
        ],
        [session],
    )
    return <AppShell title="NaaS Asset Workspace" layout="sidebar" nav={nav} />
}

const dashboardRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    validateSearch: (search: Record<string, unknown>): { tab?: string } => (typeof search.tab === 'string' ? { tab: search.tab } : {}),
    component: DashboardPage,
})

function DashboardPage() {
    const { tab } = dashboardRoute.useSearch()
    const navigate = dashboardRoute.useNavigate()
    const tabs = tabsFor(useSuspenseQuery(sessionQuery).data)
    const first = tabs[0]
    if (!first) return <Nothing title="Nothing to show for your roles" />
    const current = tabs.find((found) => found.id === tab) ?? first
    return (
        <Tabs value={current.id} onValueChange={(next: string) => void navigate({ search: next === first.id ? {} : { tab: next } })}>
            <TabsList className="max-w-full overflow-x-auto overflow-y-hidden">
                {tabs.map((found) => (
                    <TabsTrigger key={found.id} value={found.id}>
                        {found.title}
                    </TabsTrigger>
                ))}
            </TabsList>
            {tabs.map((found) => (
                <TabsContent key={found.id} value={found.id} className="grid grid-cols-12 gap-4 pt-2">
                    {found.widgets.map((widget) => (
                        <WidgetCard key={widget.id} widget={widget} />
                    ))}
                </TabsContent>
            ))}
        </Tabs>
    )
}

/** A list's view in its address: `?page=2&sort=-ends&q=cisco`, each left out at its default. */
interface ListSearch {
    page?: number
    /** A field, `-` first for descending. */
    sort?: string
    q?: string
}

function parseListSearch(search: Record<string, unknown>): ListSearch {
    const page = Number(search.page)
    const sort = typeof search.sort === 'string' && /^-?[\w.]+$/.test(search.sort) ? search.sort : undefined
    const q = typeof search.q === 'string' || typeof search.q === 'number' ? String(search.q) : ''
    return { ...(Number.isInteger(page) && page > 1 ? { page } : {}), ...(sort ? { sort } : {}), ...(q ? { q } : {}) }
}

function viewOf({ page, sort, q }: ListSearch): ListView {
    return {
        page: (page ?? 1) - 1,
        size: PAGE_SIZE,
        sort: sort ? { id: sort.replace(/^-/, ''), desc: sort.startsWith('-') } : null,
        search: q ?? '',
    }
}

function searchOf(view: ListView): ListSearch {
    return {
        ...(view.page > 0 ? { page: view.page + 1 } : {}),
        ...(view.sort ? { sort: `${view.sort.desc ? '-' : ''}${view.sort.id}` } : {}),
        ...(view.search ? { q: view.search } : {}),
    }
}

const listRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/lists/$listId',
    validateSearch: parseListSearch,
    beforeLoad: ({ params }) => {
        const list = listById(params.listId)
        if (!list) throw notFound()
        return { list }
    },
    loader: ({ context: { queryClient, list } }) => queryClient.ensureQueryData(fieldsQuery(list.table, list.columns)),
    component: function ListPage() {
        const { list } = listRoute.useRouteContext()
        // A list of its own per id, so the previous page kept on screen while the next loads is never another list's.
        return <RecordList key={list.id} list={list} />
    },
})

function RecordList({ list }: { list: WorkspaceList }) {
    const search = listRoute.useSearch()
    const navigate = listRoute.useNavigate()
    const fields = useSuspenseQuery(fieldsQuery(list.table, list.columns)).data
    const columns = useMemo(() => recordColumns(list.table, fields), [list.table, fields])
    const view = viewOf(search)
    const page = useQuery({ ...listPageQuery(list, list.order, view, fields), placeholderData: keepPreviousData })
    return (
        <>
            <h1 className="font-heading text-xl font-semibold">{list.title}</h1>
            <DataGrid
                caption={list.title}
                columns={columns}
                rowId={(row) => row.id}
                search
                error={page.error ?? undefined}
                data={page.data && { ...page.data, view, stale: page.isPlaceholderData, onViewChange: (next) => void navigate({ search: searchOf(next), replace: true }) }}
            />
        </>
    )
}

const LINK = 'font-medium underline-offset-4 hover:underline'

/** A record's first column opens its classic form in this tab, so Back returns to the same page of the list. */
function recordColumns(table: string, fields: readonly Field[]): GridColumn<SnRow>[] {
    return fields.map((field, i) => ({
        id: field.name,
        header: field.label,
        value: (row) => row.display[field.name] ?? '',
        cell: (row) => recordCell(table, field, row, i === 0),
        align: field.kind === 'number' ? 'end' : 'start',
        sortable: field.sortable,
        hideBelow: i >= 4 ? 'md' : undefined,
    }))
}

function recordCell(table: string, field: Field, row: SnRow, opensRecord: boolean): ReactNode {
    const display = row.display[field.name] ?? ''
    const value = row.value[field.name] ?? ''
    if (opensRecord) {
        return (
            <a className={LINK} href={recordHref(table, row.id)}>
                {display || <span className="text-muted-foreground">(empty)</span>}
            </a>
        )
    }
    if (field.kind === 'boolean') return value === 'true' ? <CheckIcon className="size-4" aria-label={display} /> : <span className="sr-only">{display}</span>
    if (field.kind === 'reference' && field.references && value) {
        return (
            <a className={LINK} href={recordHref(field.references, value)}>
                {display}
            </a>
        )
    }
    return display
}

function Nothing({ title }: { title: string }) {
    return (
        <Empty>
            <EmptyHeader>
                <EmptyTitle>{title}</EmptyTitle>
            </EmptyHeader>
        </Empty>
    )
}

export const routeTree = rootRoute.addChildren([dashboardRoute, listRoute])
