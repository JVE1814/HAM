import {
    columnFilteringFeature,
    createFilteredRowModel,
    createPaginatedRowModel,
    createSortedRowModel,
    filterFn_includesString,
    functionalUpdate,
    globalFilteringFeature,
    rowPaginationFeature,
    rowSelectionFeature,
    rowSortingFeature,
    sortFn_alphanumeric,
    tableFeatures,
    useTable,
    type ColumnDef,
    type PaginationState,
    type RowData,
    type SortingState,
    type TableOptions,
    type Updater,
} from '@tanstack/react-table'
import { ArrowDownIcon, ArrowUpIcon, ChevronLeftIcon, ChevronRightIcon, ChevronsUpDownIcon, SearchIcon } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Empty, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Failure } from '@/lib/app'
import type { ListView } from '@/lib/sn'
import { cn } from '@/lib/utils'

/*
 * The app's one data grid: a shadcn Table driven by TanStack Table. No caller sees a TanStack type: a column is a
 * GridColumn, and the shape of `data` decides who processes the rows.
 */

export interface GridColumn<T> {
    /** Unique among the columns; for server rows, the field the server sorts by. */
    id: string
    header: string
    /** What the column sorts and searches by among rows in memory, and shows when it has no `cell`. */
    value: (row: T) => string | number
    cell?: (row: T) => ReactNode
    align?: 'start' | 'end'
    /** Default true. */
    sortable?: boolean
    /** Hidden on screens narrower than this, so a phone does not scroll sideways for it. */
    hideBelow?: 'sm' | 'md' | 'lg'
}

/** One page its owner already searched, sorted and cut: the grid shows it and reports the view the user asks for next. */
export interface ServerRows<T> {
    rows: readonly T[]
    total: number
    view: ListView
    /** Called with `page: 0` whenever the sort or the search changes. */
    onViewChange: (next: ListView) => void
    /** The rows are the previous view's while the next one loads. */
    stale: boolean
}

export interface DataGridProps<T> {
    /** The table's accessible name. */
    caption: string
    /** Stable identity (a module constant or a memo): a new array rebuilds the table. */
    columns: readonly GridColumn<T>[]
    /** Rows in memory, which the grid sorts, searches and pages; one server page; or undefined while loading. */
    data: readonly T[] | ServerRows<T> | undefined
    /** Shown in place of the rows when they failed to load. */
    error?: unknown
    rowId: (row: T) => string
    search?: boolean
    /** Rows per page in memory; absent shows them all. */
    pageSize?: number
    /** Adds a checkbox to each row it accepts. */
    selectable?: (row: T) => boolean
    /** Under the grid. `chosen` is the selected rows that are still shown and still selectable. */
    actions?: (chosen: readonly T[], clear: () => void) => ReactNode
    empty?: string
}

const features = tableFeatures({
    rowSortingFeature,
    sortedRowModel: createSortedRowModel(),
    sortFns: { alphanumeric: sortFn_alphanumeric },
    columnFilteringFeature,
    globalFilteringFeature,
    filteredRowModel: createFilteredRowModel(),
    filterFns: { includesString: filterFn_includesString },
    rowPaginationFeature,
    paginatedRowModel: createPaginatedRowModel(),
    rowSelectionFeature,
})

const NO_ROWS: never[] = []

const SELECT = 'select'

const HIDDEN_BELOW = { sm: 'hidden sm:table-cell', md: 'hidden md:table-cell', lg: 'hidden lg:table-cell' } as const

function isServer<T>(data: DataGridProps<T>['data']): data is ServerRows<T> {
    return data !== undefined && !Array.isArray(data)
}

export function DataGrid<T extends RowData>({ caption, columns, data, error, rowId, search, pageSize, selectable, actions, empty }: DataGridProps<T>) {
    const server = isServer(data) ? data : null
    const rows = server ? server.rows : ((data as readonly T[] | undefined) ?? NO_ROWS)
    const [sorting, setSorting] = useState<SortingState>([])
    const [globalFilter, setGlobalFilter] = useState('')
    const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: pageSize ?? Number.MAX_SAFE_INTEGER })

    const columnDefs = useMemo((): ColumnDef<typeof features, T>[] => {
        const shown: ColumnDef<typeof features, T>[] = columns.map((column) => ({
            id: column.id,
            header: column.header,
            accessorFn: (row: T) => column.value(row),
            cell: ({ row }) => (column.cell ? column.cell(row.original) : column.value(row.original)),
            enableSorting: column.sortable ?? true,
            sortFn: 'alphanumeric',
            filterFn: 'includesString',
        }))
        if (!selectable) return shown
        const select: ColumnDef<typeof features, T> = {
            id: SELECT,
            enableSorting: false,
            enableGlobalFilter: false,
            header: ({ table }) => (
                <Checkbox
                    aria-label="Select all"
                    checked={table.getIsAllRowsSelected()}
                    indeterminate={table.getIsSomeRowsSelected()}
                    onCheckedChange={(checked) => table.toggleAllRowsSelected(checked)}
                />
            ),
            cell: ({ row }) =>
                row.getCanSelect() ? <Checkbox aria-label="Select row" checked={row.getIsSelected()} onCheckedChange={(checked) => row.toggleSelected(checked)} /> : null,
        }
        return [select, ...shown]
    }, [columns, selectable])

    const view = server?.view
    const shared: TableOptions<typeof features, T> = {
        features,
        columns: columnDefs,
        data: rows as T[],
        getRowId: (row) => rowId(row),
        enableRowSelection: selectable ? (row) => selectable(row.original) : false,
    }
    const table = useTable<typeof features, T>(
        server && view
            ? {
                  ...shared,
                  manualSorting: true,
                  manualFiltering: true,
                  manualPagination: true,
                  rowCount: server.total,
                  state: {
                      sorting: view.sort ? [view.sort] : [],
                      pagination: { pageIndex: view.page, pageSize: view.size },
                      globalFilter: view.search,
                  },
                  onSortingChange: (update: Updater<SortingState>) =>
                      server.onViewChange({ ...view, sort: functionalUpdate(update, view.sort ? [view.sort] : [])[0] ?? null, page: 0 }),
                  onPaginationChange: (update: Updater<PaginationState>) =>
                      server.onViewChange({ ...view, page: functionalUpdate(update, { pageIndex: view.page, pageSize: view.size }).pageIndex }),
              }
            : {
                  ...shared,
                  state: { sorting, globalFilter, pagination },
                  onSortingChange: setSorting,
                  onGlobalFilterChange: setGlobalFilter,
                  onPaginationChange: setPagination,
              },
    )

    const shown = table.getRowModel().rows
    const chosen = selectable ? table.getSelectedRowModel().rows.map((row) => row.original).filter((row) => selectable(row)) : []
    const total = server ? server.total : table.getFilteredRowModel().rows.length
    const { pageIndex, pageSize: size } = table.state.pagination
    const paged = server ? total > size : pageSize !== undefined && total > pageSize
    const columnOf = (id: string) => columns.find((column) => column.id === id)

    return (
        <div className="flex flex-col gap-3">
            {search && (
                <SearchBox
                    value={server ? server.view.search : globalFilter}
                    onChange={(text) => (server ? server.onViewChange({ ...server.view, search: text, page: 0 }) : table.setGlobalFilter(text))}
                />
            )}
            <div className={cn('rounded-lg border', server?.stale && 'opacity-60 transition-opacity')}>
                <Table>
                    <TableCaption className="sr-only">{caption}</TableCaption>
                    <TableHeader>
                        {table.getHeaderGroups().map((group) => (
                            <TableRow key={group.id}>
                                {group.headers.map((header) => {
                                    const column = columnOf(header.column.id)
                                    const sorted = header.column.getIsSorted()
                                    return (
                                        <TableHead
                                            key={header.id}
                                            aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined}
                                            className={cn(column?.hideBelow && HIDDEN_BELOW[column.hideBelow], column?.align === 'end' && 'text-right', !column && 'w-8')}
                                        >
                                            {header.column.getCanSort() ? (
                                                <Button variant="ghost" size="sm" className="-ml-2.5 text-sm" onClick={header.column.getToggleSortingHandler()}>
                                                    <table.FlexRender header={header} />
                                                    {sorted === 'asc' ? <ArrowUpIcon /> : sorted === 'desc' ? <ArrowDownIcon /> : <ChevronsUpDownIcon className="opacity-40" />}
                                                </Button>
                                            ) : (
                                                <table.FlexRender header={header} />
                                            )}
                                        </TableHead>
                                    )
                                })}
                            </TableRow>
                        ))}
                    </TableHeader>
                    <TableBody>
                        {error ? (
                            <TableRow>
                                <TableCell colSpan={columnDefs.length}>
                                    <Failure error={error} />
                                </TableCell>
                            </TableRow>
                        ) : data === undefined ? (
                            Array.from({ length: 5 }, (_, i) => (
                                <TableRow key={i}>
                                    <TableCell colSpan={columnDefs.length}>
                                        <Skeleton className="h-5 w-full" />
                                    </TableCell>
                                </TableRow>
                            ))
                        ) : shown.length === 0 ? (
                            <TableRow>
                                <TableCell colSpan={columnDefs.length}>
                                    <Empty>
                                        <EmptyHeader>
                                            <EmptyTitle>{empty ?? 'Nothing here'}</EmptyTitle>
                                        </EmptyHeader>
                                    </Empty>
                                </TableCell>
                            </TableRow>
                        ) : (
                            shown.map((row) => (
                                <TableRow key={row.id} data-state={row.getIsSelected() ? 'selected' : undefined}>
                                    {row.getAllCells().map((cell) => {
                                        const column = columnOf(cell.column.id)
                                        return (
                                            <TableCell key={cell.id} className={cn(column?.hideBelow && HIDDEN_BELOW[column.hideBelow], column?.align === 'end' && 'text-right tabular-nums')}>
                                                <table.FlexRender cell={cell} />
                                            </TableCell>
                                        )
                                    })}
                                </TableRow>
                            ))
                        )}
                    </TableBody>
                </Table>
            </div>
            {(actions || paged) && (
                <div className="flex flex-wrap items-center gap-2">
                    {actions?.(chosen, () => table.resetRowSelection())}
                    {paged && (
                        <div className="ml-auto flex items-center gap-2 text-sm text-muted-foreground">
                            <span>
                                {pageIndex * size + 1}–{Math.min((pageIndex + 1) * size, total)} of {total.toLocaleString()}
                            </span>
                            <Button variant="outline" size="icon-sm" aria-label="Previous page" disabled={!table.getCanPreviousPage()} onClick={() => table.previousPage()}>
                                <ChevronLeftIcon />
                            </Button>
                            <Button variant="outline" size="icon-sm" aria-label="Next page" disabled={!table.getCanNextPage()} onClick={() => table.nextPage()}>
                                <ChevronRightIcon />
                            </Button>
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}

/** The search field: it reports what was typed once typing pauses. */
function SearchBox({ value, onChange }: { value: string; onChange: (text: string) => void }) {
    const [text, setText] = useState(value)
    useEffect(() => setText(value), [value])
    useEffect(() => {
        if (text === value) return
        const timer = setTimeout(() => onChange(text), 300)
        return () => clearTimeout(timer)
    }, [text, value, onChange])
    return (
        <div className="relative max-w-sm">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input type="search" aria-label="Search" placeholder="Search" className="pl-8" value={text} onChange={(event) => setText(event.target.value)} />
        </div>
    )
}
