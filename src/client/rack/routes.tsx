import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { createRootRouteWithContext, createRoute, useNavigate } from '@tanstack/react-router'
import { useMemo, type ReactNode } from 'react'
import { AppShell } from '@/components/app-shell'
import { DataGrid, type GridColumn } from '@/components/data-grid'
import { Badge } from '@/components/ui/badge'
import { Field, FieldLabel } from '@/components/ui/field'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { AppContext } from '@/lib/app'
import { sessionQuery } from '@/lib/session'
import type { RackDevice } from '../../server/domain/rest-contracts'
import { PROVIDER_STAFF } from '../../server/domain/roles'
import { stageText } from '../stage'
import { rackQuery, racksQuery, sitesQuery } from './api'
import { assetHref, COLOUR_BY, PowerBar, RackFaces, type ColourBy } from './Elevation'

const rootRoute = createRootRouteWithContext<AppContext>()({
    component: () => <AppShell title="Rack elevations" layout="tabs" nav={[]} />,
})

const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    loader: ({ context }) => context.queryClient.ensureQueryData(sitesQuery),
    component: () => (
        <Pickers>
            <SitePicker />
        </Pickers>
    ),
})

const siteRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: 'sites/$siteId',
    loader: ({ context, params }) => Promise.all([context.queryClient.ensureQueryData(sitesQuery), context.queryClient.ensureQueryData(racksQuery(params.siteId))]),
})

const siteIndexRoute = createRoute({
    getParentRoute: () => siteRoute,
    path: '/',
    component: function SitePage() {
        const { siteId } = siteRoute.useParams()
        return (
            <Pickers>
                <SitePicker siteId={siteId} />
                <RackPicker siteId={siteId} />
            </Pickers>
        )
    },
})

const rackRoute = createRoute({
    getParentRoute: () => siteRoute,
    path: 'racks/$rackId',
    validateSearch: (search: Record<string, unknown>): { colour: ColourBy } => ({
        colour: typeof search.colour === 'string' && search.colour in COLOUR_BY ? (search.colour as ColourBy) : 'stage',
    }),
    loader: ({ context, params }) => {
        void context.queryClient.prefetchQuery(sessionQuery)
        return context.queryClient.ensureQueryData(rackQuery(params.rackId))
    },
    component: RackPage,
})

export const routeTree = rootRoute.addChildren([indexRoute, siteRoute.addChildren([siteIndexRoute, rackRoute])])

function Pickers({ children }: { children: ReactNode }) {
    return <div className="flex flex-wrap gap-3 *:w-full sm:*:w-56">{children}</div>
}

function SitePicker({ siteId }: { siteId?: string }) {
    const { data: sites } = useSuspenseQuery(sitesQuery)
    const navigate = useNavigate()
    const items = sites.map((s) => ({ value: s.id, label: `${s.name} (${s.customer})` }))
    return (
        <Field>
            <FieldLabel htmlFor="site">Site</FieldLabel>
            <Select items={items} value={siteId ?? null} onValueChange={(id) => id && void navigate({ to: '/sites/$siteId', params: { siteId: id } })}>
                <SelectTrigger id="site" className="w-full">
                    <SelectValue placeholder="Choose a site" />
                </SelectTrigger>
                <SelectContent>
                    {items.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                            {item.label}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        </Field>
    )
}

function RackPicker({ siteId, rackId, colour }: { siteId: string; rackId?: string; colour?: ColourBy }) {
    const { data: racks } = useSuspenseQuery(racksQuery(siteId))
    const navigate = useNavigate()
    const items = racks.map((r) => ({ value: r.id, label: r.room ? `${r.name} · ${r.room}` : r.name }))
    return (
        <Field>
            <FieldLabel htmlFor="rack">Rack</FieldLabel>
            <Select
                items={items}
                value={rackId ?? null}
                disabled={racks.length === 0}
                onValueChange={(id) => id && void navigate({ to: '/sites/$siteId/racks/$rackId', params: { siteId, rackId: id }, search: { colour: colour ?? 'stage' } })}
            >
                <SelectTrigger id="rack" className="w-full">
                    <SelectValue placeholder={racks.length ? 'Choose a rack' : 'No racks'} />
                </SelectTrigger>
                <SelectContent>
                    {items.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                            {item.label}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        </Field>
    )
}

const COLOUR_ITEMS = Object.entries(COLOUR_BY).map(([value, label]) => ({ value, label }))

function ColourPicker({ colour }: { colour: ColourBy }) {
    const navigate = rackRoute.useNavigate()
    return (
        <Field>
            <FieldLabel htmlFor="colour">Colour by</FieldLabel>
            <Select items={COLOUR_ITEMS} value={colour} onValueChange={(next) => next && void navigate({ search: { colour: next as ColourBy } })}>
                <SelectTrigger id="colour" className="w-full">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    {COLOUR_ITEMS.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                            {item.label}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        </Field>
    )
}

function deviceColumns(linkAssets: boolean): GridColumn<RackDevice>[] {
    return [
        { id: 'unit', header: 'Unit', value: (d) => d.ruStart, cell: (d) => `${d.ruStart} · ${d.face}`, align: 'end' },
        { id: 'model', header: 'Model', value: (d) => d.model, hideBelow: 'sm' },
        {
            id: 'serial',
            header: 'Serial',
            value: (d) => d.serial,
            cell: (d) =>
                linkAssets ? (
                    <a href={assetHref(d)} target="_blank" rel="noreferrer" className="underline-offset-4 hover:underline">
                        {d.serial}
                    </a>
                ) : (
                    d.serial
                ),
        },
        { id: 'stage', header: 'Stage', value: (d) => stageText(d.stage), cell: (d) => <Badge variant="secondary">{stageText(d.stage)}</Badge>, hideBelow: 'sm' },
        { id: 'customer', header: 'Customer', value: (d) => d.customer, hideBelow: 'md' },
    ]
}

function RackPage() {
    const { siteId, rackId } = rackRoute.useParams()
    const { colour } = rackRoute.useSearch()
    const { data: detail } = useSuspenseQuery(rackQuery(rackId))
    // The ACLs guard the Asset form; the role only decides whether a link is offered. No answer from /me, no link.
    const linkAssets = useQuery(sessionQuery).data?.holdsAny(PROVIDER_STAFF) ?? false
    const columns = useMemo(() => deviceColumns(linkAssets), [linkAssets])

    return (
        <>
            <Pickers>
                <SitePicker siteId={siteId} />
                <RackPicker siteId={siteId} rackId={rackId} colour={colour} />
                <ColourPicker colour={colour} />
            </Pickers>
            <PowerBar power={detail.rack.power} />
            <RackFaces detail={detail} colourBy={colour} linkAssets={linkAssets} />
            <DataGrid caption={`Devices in ${detail.rack.name}`} columns={columns} data={detail.devices} rowId={(d) => d.id} search empty="No devices in this rack" />
        </>
    )
}
