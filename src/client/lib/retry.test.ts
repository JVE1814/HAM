import { QueryClient } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { describe, expect, it } from 'vitest'
import { retryRoute } from './retry'

/** A page as startApp mounts one: a route whose loader reads a query, here one that fails `failures` times. */
async function loadedPage(failures: number) {
    let fetches = 0
    const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: false } } })
    const query = {
        queryKey: ['page'],
        queryFn: async () => {
            fetches += 1
            if (fetches <= failures) throw new Error(`failure ${fetches}`)
            return 'loaded'
        },
    }
    const rootRoute = createRootRoute()
    const pageRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', loader: () => queryClient.ensureQueryData(query) })
    const router = createRouter({ routeTree: rootRoute.addChildren([pageRoute]), history: createMemoryHistory({ initialEntries: ['/'] }) })
    await router.load()
    const page = () => router.state.matches.find((match) => match.routeId === pageRoute.id)
    return { router, status: () => page()?.status, error: () => (page()?.error as Error | undefined)?.message, fetches: () => fetches }
}

describe('retryRoute', () => {
    it('loads a route whose loader failed, once the server answers', async () => {
        const page = await loadedPage(1)
        expect([page.status(), page.error(), page.fetches()]).toEqual(['error', 'failure 1', 1])
        await retryRoute(page.router)
        expect([page.status(), page.error(), page.fetches()]).toEqual(['success', undefined, 2])
    })

    it('shows the new failure when the server still fails', async () => {
        const page = await loadedPage(2)
        await retryRoute(page.router)
        expect([page.status(), page.error(), page.fetches()]).toEqual(['error', 'failure 2', 2])
        await retryRoute(page.router)
        expect([page.status(), page.fetches()]).toEqual(['success', 3])
    })

    it('fetches nothing again on a route that loaded', async () => {
        const page = await loadedPage(0)
        await retryRoute(page.router)
        expect([page.status(), page.fetches()]).toEqual(['success', 1])
    })
})
