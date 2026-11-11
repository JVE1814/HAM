import { useSuspenseQuery } from '@tanstack/react-query'
import { createRootRouteWithContext, createRoute, redirect } from '@tanstack/react-router'
import { AppShell } from '@/components/app-shell'
import type { AppContext } from '@/lib/app'
import { overviewQuery } from './api'
import { Attestations } from './attestations'
import { Equipment } from './equipment'
import { Orders } from './orders'

function Shell() {
    const { data: overview } = useSuspenseQuery(overviewQuery)
    const items = [
        { label: `Equipment (${overview.assets.length})`, to: '/equipment' },
        { label: 'Orders & returns', to: '/orders' },
        ...(overview.isCustomerAdmin ? [{ label: 'Confirm equipment', to: '/attestations', badge: overview.attestations.length }] : []),
    ]
    return <AppShell title={overview.customer || 'My network equipment'} layout="tabs" nav={[{ items }]} />
}

const rootRoute = createRootRouteWithContext<AppContext>()({
    loader: ({ context }) => context.queryClient.ensureQueryData(overviewQuery),
    component: Shell,
})

const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    beforeLoad: () => {
        throw redirect({ to: '/equipment' })
    },
})

const equipmentRoute = createRoute({ getParentRoute: () => rootRoute, path: '/equipment', component: Equipment })

const ordersRoute = createRoute({ getParentRoute: () => rootRoute, path: '/orders', component: Orders })

const attestationsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/attestations',
    beforeLoad: async ({ context }) => {
        const overview = await context.queryClient.ensureQueryData(overviewQuery)
        if (!overview.isCustomerAdmin) throw redirect({ to: '/equipment' })
    },
    component: Attestations,
})

export const routeTree = rootRoute.addChildren([indexRoute, equipmentRoute, ordersRoute, attestationsRoute])
