import { useQuery } from '@tanstack/react-query'
import { createRootRouteWithContext, createRoute, redirect } from '@tanstack/react-router'
import { AppShell } from '@/components/app-shell'
import type { AppContext } from '@/lib/app'
import { stockroomsQuery } from './api'
import { ModeScreen } from './ModeScreen'
import { MODES, modesFor } from './scans'
import { StationProvider } from './station'

const rootRoute = createRootRouteWithContext<AppContext>()({
    loader: ({ context }) => context.queryClient.prefetchQuery(stockroomsQuery),
    component: function Warehouse() {
        const modes = modesFor(useQuery(stockroomsQuery).data)
        return (
            <StationProvider>
                <AppShell title="NaaS Warehouse" layout="tabs" nav={[{ items: modes.map((m) => ({ label: m.title, to: `/${m.id}` })) }]} />
            </StationProvider>
        )
    },
})

const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    beforeLoad: async ({ context }) => {
        // A failed load opens the first mode, which shows the failure; a field tech's null opens Audit.
        const stockrooms = await context.queryClient.ensureQueryData(stockroomsQuery).catch(() => undefined)
        throw redirect({ to: `/${modesFor(stockrooms)[0].id}` })
    },
})

const modeRoutes = MODES.map((mode) =>
    createRoute({
        getParentRoute: () => rootRoute,
        path: mode.id,
        beforeLoad: async ({ context }) => {
            if (!mode.depot) return
            if ((await context.queryClient.ensureQueryData(stockroomsQuery)) === null) throw redirect({ to: '/audit' })
        },
        component: function Mode() {
            return <ModeScreen mode={mode} />
        },
    }),
)

export const routeTree = rootRoute.addChildren([indexRoute, ...modeRoutes])
