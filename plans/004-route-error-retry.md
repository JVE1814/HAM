# Plan 004: Make "Try again" on a failed page reload the page

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 1864b17..HEAD -- src/client/lib/app.tsx src/client/lib/retry.ts src/client/lib/retry.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding. On a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-lint-tracked-sources.md
- **Category**: bug
- **Planned at**: commit `1864b17`, 2026-11-12

## Why this matters

Every React page of the app (workspace, customer, rack, warehouse) loads its data in a route loader. When that load fails, for example on a network drop or an expired session, the page shows a "Something went wrong" alert with a "Try again" button. The button does nothing useful. It clears the error boundary, the router renders the same failed match, and the same alert comes back without any request being sent. The user has to know to reload the browser tab. After this plan, "Try again" runs the failed load again and shows the page when the server answers.

## Current state

- `src/client/lib/app.tsx` mounts every page (`startApp`) and holds the shared error view. It is the only file with the bug.
- `src/client/lib/retry.ts` and `src/client/lib/retry.test.ts` do not exist. You create them.

`src/client/lib/app.tsx:1-4`:

```tsx
import { MutationCache, QueryClient, QueryClientProvider, type QueryKey } from '@tanstack/react-query'
import { createHashHistory, createRouter, RouterProvider, type AnyRoute, type ErrorComponentProps } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
```

`src/client/lib/app.tsx:12-13`:

```tsx
import { ApiError } from '../api'
import '../app.css'
```

`src/client/lib/app.tsx:29-48` (the shared failure view and the route error component):

```tsx
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
```

`src/client/lib/app.tsx:91` registers it for every route: `defaultErrorComponent: RouteError,`.

Why `reset` is not enough (read from the installed `@tanstack/react-router` 1.170.46):

- `node_modules/@tanstack/react-router/dist/esm/CatchBoundary.js:10-12`: `reset` only does `this.setState({ error: 0 })`.
- `node_modules/@tanstack/react-router/dist/esm/Match.js:113-123`: while `match.status === "error"` the match rethrows `match.error` on every render.
- `node_modules/@tanstack/router-core/dist/esm/router.js:510-537`: `router.invalidate()` sets a match with `status === "error"` back to `"pending"` and runs its `beforeLoad` and loader again. The TanStack Router data-loading guide says to call `router.invalidate()` when the error came from a route load, and that it also resets the error boundary.

The loaders that fail this way all read through the Query client, for example `src/client/workspace/routes.tsx:21`:

```tsx
    loader: ({ context }) => context.queryClient.ensureQueryData(sessionQuery),
```

`ensureQueryData` fetches again when the query holds no data, so a rerun loader sends a new request. A query that already holds fresh data is not fetched again.

Conventions that apply:

- Client tests run under vitest in the `node` environment (`vitest.config.ts`). There is no DOM test stack (no jsdom, no testing-library). Do not add one. A test cannot render `RouteError`.
- A test file must not import `src/client/lib/app.tsx`. That file imports through the `@/` alias and a CSS file, and vitest has no alias configured. This is why the retry action lives in its own module, `retry.ts`, with relative imports only.
- Tests are `*.test.ts` beside the module. Model the new test on `src/client/api.test.ts` for style (4-space indent, single quotes, no semicolons, `describe`/`it` names that read as sentences).
- Comments only for a non-obvious why.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Lint | `npm run lint` | exit 0 (needs plan 001; before it, use `npx eslint src`) |
| The new test | `npx vitest run src/client/lib/retry.test.ts` | 3 tests pass |
| Build | `npm run build` | exit 0 |
| Full gate | `npm run check` | exit 0, all tests pass |
| Dev server | `npm run dev` | logs `UI pages served at http://localhost:<port>/`; needs SDK credentials for a ServiceNow instance |

## Scope

**In scope** (the only files you should modify):

- `src/client/lib/retry.ts` (create)
- `src/client/lib/retry.test.ts` (create)
- `src/client/lib/app.tsx`
- `src/fluent/generated/keys.ts`, only if `npm run build` rewrites it

**Out of scope** (do NOT touch):

- `Failure` in `app.tsx`. `src/client/components/data-grid.tsx:221` and `src/client/workspace/widget.tsx:54` render it without `reset` on purpose. Their queries are not route loads.
- Any `routes.tsx`. The loaders are correct.
- `vitest.config.ts` and `package.json`. Add no test environment and no dependency.
- A `QueryErrorResetBoundary` or `useQueryErrorResetBoundary`. See "Maintenance notes" for why it is not needed today.

## Git workflow

- Branch: `advisor/004-route-error-retry`
- One commit. Subject in the repo's style, an imperative sentence under 72 characters, for example: `Reload a failed route when its Try again is pressed`. The body says what was wrong and why (the button cleared the boundary but the router kept the failed match, so no request was sent).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the retry action and its test

Create `src/client/lib/retry.ts` with exactly this content:

```ts
import type { AnyRouter } from '@tanstack/react-router'

/**
 * "Try again" on a failed route. The router keeps a failed match failed and rethrows its error on every render, so
 * clearing the error boundary alone shows the same failure. Invalidating runs the failed `beforeLoad` and loader
 * again and clears the boundary; a query that is still fresh is not fetched again.
 */
export function retryRoute(router: Pick<AnyRouter, 'invalidate'>): Promise<void> {
    return router.invalidate()
}
```

Create `src/client/lib/retry.test.ts` with exactly this content:

```ts
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
```

This test builds a real router and a real Query client in node. It needs no DOM. It was run against the installed versions when this plan was written and passed.

**Verify**: `npx vitest run src/client/lib/retry.test.ts` → `3 passed`.

### Step 2: Call the retry action from the route error component

Edit `src/client/lib/app.tsx`:

1. On line 2, add `useRouter` to the `@tanstack/react-router` import:

   ```tsx
   import { createHashHistory, createRouter, RouterProvider, useRouter, type AnyRoute, type ErrorComponentProps } from '@tanstack/react-router'
   ```

2. After the line `import '../app.css'`, add:

   ```tsx
   import { retryRoute } from './retry'
   ```

3. Replace the `RouteError` function (lines 46-48) with:

   ```tsx
   function RouteError({ error }: ErrorComponentProps) {
       const router = useRouter()
       return <Failure error={error} reset={() => void retryRoute(router)} />
   }
   ```

Change nothing else in the file.

**Verify**: `npm run typecheck` → exit 0. `npm run lint` → exit 0. `grep -n "reset={reset}" src/client/lib/app.tsx` → no matches.

### Step 3: Run the full gate

Run `npm run check`. It builds the app. Then run `git status --short`.

If `src/fluent/generated/keys.ts` is listed as modified, include it in the commit. The build names emitted page files by content, so a client change can rewrite it.

**Verify**: `npm run check` → exit 0. `git status --short` lists only files from the in-scope list.

### Step 4: Check the button in a browser (needs an instance)

This step needs SDK credentials for a ServiceNow instance with the app installed. If you have none, skip it, and say in your report that the browser check was not run.

1. Run `npm run dev`. Note the URL it logs.
2. In Chrome, open DevTools, then the Network tab's request blocking, and block the pattern `*/api/x_daas_ham/naas/me*`.
3. Open `<logged URL>workspace.html`. After a few seconds (the client retries a network failure twice) the page shows the "Something went wrong" alert with "Try again".
4. Click "Try again" with the block still on. Expected: the Network tab shows new blocked `me` requests, then the alert shows again.
5. Remove the block. Click "Try again". Expected: the workspace loads with its sidebar and the Overview tabs.

**Verify**: steps 4 and 5 behave as written. On the code before this plan, step 4 sends no request and step 5 leaves the alert on screen.

## Test plan

- New file `src/client/lib/retry.test.ts`, 3 tests, given in full in step 1:
  - a route whose loader failed loads after `retryRoute` once the server answers (the regression);
  - a second failure replaces the first, and a later retry still recovers;
  - a route that loaded is not fetched again.
- The node test covers the retry action. It does not render `RouteError`, so it does not prove the button calls the action. Step 2's `grep` and step 4's browser check cover the wiring.
- Verification: `npx vitest run src/client/lib/retry.test.ts` → 3 pass. `npm run check` → exit 0.

## Done criteria

Local. ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm run lint` exits 0
- [ ] `npx vitest run src/client/lib/retry.test.ts` reports 3 passed
- [ ] `npm run check` exits 0
- [ ] `grep -n "reset={reset}" src/client/lib/app.tsx` returns no matches
- [ ] `grep -n "retryRoute(router)" src/client/lib/app.tsx` returns one match
- [ ] `git status --short` lists only in-scope files
- [ ] `plans/README.md` status row updated

Needs an instance (report as "not run" if you have none; the local criteria suffice to hand the work back):

- [ ] Step 4 browser check behaves as written

## STOP conditions

Stop and report back (do not improvise) if:

- `src/client/lib/app.tsx` does not match the excerpts in "Current state".
- The step 1 test fails as written. That means the installed router or Query version behaves differently from 1.170.46 and 5.107.1 (`router.invalidate()` no longer reloads a failed match, or `ensureQueryData` no longer refetches a failed query). Do not change the assertions to make it pass.
- `npm run typecheck` rejects `Pick<AnyRouter, 'invalidate'>` or the `useRouter()` argument. Report the error text.
- In step 4, "Try again" sends a request but the page stays on the alert after the block is removed.
- The fix seems to need a change to `Failure`, a `routes.tsx`, or the vitest configuration.

## Maintenance notes

- Today every `useSuspenseQuery` in the pages reads a query that a route loader or `beforeLoad` already loaded (`workspace/routes.tsx:21,112`, `customer/routes.tsx:21`, `rack/routes.tsx:24,35,58`). So a query error reaches `RouteError` only through a failed route load, which `router.invalidate()` reruns. If a page ever reads a suspense query that no loader loaded, its error is thrown during render. TanStack Router's external-data-loading guide then also asks for `useQueryErrorResetBoundary().reset()` in an effect inside the error component. Add it at that point, not before.
- `retry.test.ts` pins router and Query behaviour the pages depend on. Run it after upgrading `@tanstack/react-router` or `@tanstack/react-query`.
- Reviewer: check that `Failure` itself did not change, and that the grid and widget failures still render without a button.
