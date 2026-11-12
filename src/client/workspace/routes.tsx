import { keepPreviousData, useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { createRootRouteWithContext, createRoute, notFound } from '@tanstack/react-router'
import { CheckIcon } from 'lucide-react'
import { useEffect, useMemo, type ReactNode } from 'react'
import { AppShell, type NavGroup } from '@/components/app-shell'
import { DataGrid, type GridColumn } from '@/components/data-grid'
import { Empty, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { AppContext } from '@/lib/app'
import { sessionQuery } from '@/lib/session'
import { fieldsQuery, listPageQuery, pageWithin, recordHref, type Field, type SnRow } from '@/lib/sn'
import { listById, menuFor, type ListId, type WorkspaceList } from './catalog'
import { tabsFor } from './dashboard'
import { parseListSearch, searchOf, viewOf, type ListSearch } from './list-search'
import { WidgetCard } from './widget'

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
    // The total of the page asked for, not of the previous view's rows kept on screen meanwhile.
    const shown = page.data && !page.isPlaceholderData ? pageWithin(view, page.data.total) : view.page
    useEffect(() => {
        if (shown !== view.page) void navigate({ search: (current: ListSearch) => searchOf({ ...viewOf(current), page: shown }), replace: true })
    }, [shown, view.page, navigate])
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
