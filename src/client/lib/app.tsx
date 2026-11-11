import { MutationCache, QueryClient, QueryClientProvider, type QueryKey } from '@tanstack/react-query'
import { createHashHistory, createRouter, RouterProvider, type AnyRoute, type ErrorComponentProps } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { toast } from 'sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Empty, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Toaster } from '@/components/ui/sonner'
import { Spinner } from '@/components/ui/spinner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ApiError } from '../api'
import '../app.css'

/**
 * What a mutation says about itself, read by the one MutationCache below: `done` is the toast on success, `refresh`
 * the queries it makes stale. A failure toasts its error. No page keeps its own busy, message or reload state.
 */
declare module '@tanstack/react-query' {
    interface Register {
        mutationMeta: { done?: (data: never) => string; refresh?: readonly QueryKey[] }
    }
}

/** The context every route's loader and beforeLoad receive. */
export interface AppContext {
    queryClient: QueryClient
}

/** A failed load or action, in the words the server gave. */
export function Failure({ error, reset }: { error: unknown; reset?: () => void }) {
    return (
        <Alert variant="destructive">
            <AlertTitle>Something went wrong</AlertTitle>
            <AlertDescription>
                {error instanceof Error ? error.message : String(error)}
                {reset && (
                    <Button variant="outline" size="sm" className="mt-2" onClick={reset}>
                        Try again
                    </Button>
                )}
            </AlertDescription>
        </Alert>
    )
}

function RouteError({ error, reset }: ErrorComponentProps) {
    return <Failure error={error} reset={reset} />
}

function Pending() {
    return (
        <div className="flex justify-center p-8">
            <Spinner />
        </div>
    )
}

function NotFound() {
    return (
        <Empty>
            <EmptyHeader>
                <EmptyTitle>Nothing here</EmptyTitle>
            </EmptyHeader>
        </Empty>
    )
}

/** A client error will not pass on a retry; a network or server one may. */
const retry = (failures: number, error: unknown) => !(error instanceof ApiError && error.status < 500) && failures < 2

/** Mounts a page: its route tree under hash history (a UI page is one .do address), Query, toasts and tooltips. */
export function startApp(routeTree: AnyRoute): void {
    const queryClient: QueryClient = new QueryClient({
        defaultOptions: { queries: { staleTime: 30_000, retry } },
        mutationCache: new MutationCache({
            onSuccess: (data, _variables, _context, mutation) => {
                const { done, refresh } = mutation.meta ?? {}
                if (done) toast.success(done(data as never))
                for (const queryKey of refresh ?? []) void queryClient.invalidateQueries({ queryKey })
            },
            onError: (error) => void toast.error(error.message),
        }),
    })
    const router = createRouter({
        routeTree,
        history: createHashHistory(),
        context: { queryClient } satisfies AppContext,
        defaultPreload: 'intent',
        defaultPreloadStaleTime: 0,
        defaultPendingComponent: Pending,
        defaultErrorComponent: RouteError,
        defaultNotFoundComponent: NotFound,
    })

    const dark = window.matchMedia('(prefers-color-scheme: dark)')
    const followScheme = () => document.documentElement.classList.toggle('dark', dark.matches)
    followScheme()
    dark.addEventListener('change', followScheme)

    const root = document.getElementById('root')
    if (!root) return
    createRoot(root).render(
        <StrictMode>
            <QueryClientProvider client={queryClient}>
                <TooltipProvider>
                    <RouterProvider router={router} />
                    <Toaster richColors />
                </TooltipProvider>
            </QueryClientProvider>
        </StrictMode>,
    )
}
