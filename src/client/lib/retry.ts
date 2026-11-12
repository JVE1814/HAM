import type { AnyRouter } from '@tanstack/react-router'

/**
 * "Try again" on a failed route. The router keeps a failed match failed and rethrows its error on every render, so
 * clearing the error boundary alone shows the same failure. Invalidating runs the failed `beforeLoad` and loader
 * again and clears the boundary; a query that is still fresh is not fetched again.
 */
export function retryRoute(router: Pick<AnyRouter, 'invalidate'>): Promise<void> {
    return router.invalidate()
}
