# Plan 015: Show the last page of a workspace list when its address is past the end

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 1864b17..HEAD -- src/client/lib/sn.ts src/client/lib/sn.test.ts src/client/workspace/routes.tsx`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding. On a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-lint-tracked-sources.md
- **Category**: bug
- **Planned at**: commit `1864b17`, 2026-11-12

## Why this matters

A workspace list keeps its page in the address (`?page=2`). Work queues shrink while people work them, for example *Awaiting approval*. A user on page 2 opens a record, approves it, and presses Back. The list now has 50 rows or fewer, the address still says page 2, and the grid shows "Nothing here" with no pager to leave by. The rows exist, on page 1. After this plan the list moves to the last page that has rows and corrects its address.

## Current state

- `src/client/lib/sn.ts` holds the pure list helpers and the `ListView` type. Its test is `src/client/lib/sn.test.ts`.
- `src/client/workspace/routes.tsx` holds `RecordList`, the component that reads the address and asks for one page.
- `src/client/components/data-grid.tsx` draws the grid. It is the place the symptom shows. You do not change it.

`src/client/lib/sn.ts:44-55`:

```ts
/** What a user asks of a server list: which page, which one column to sort by (null: the list's own order), what to find. */
export interface ListView {
    page: number
    size: number
    sort: Ordering | null
    search: string
}

/** The classic form of a record, which carries every UI action and all form logic. */
export function recordHref(table: string, id: string): string {
    return `/${table}.do?sys_id=${encodeURIComponent(id)}`
}
```

`page` is 0-based. `size` is rows per page.

`src/client/workspace/routes.tsx:4` and `:11`:

```tsx
import { useMemo, type ReactNode } from 'react'
```

```tsx
import { fieldsQuery, listPageQuery, recordHref, type Field, type ListView, type SnRow } from '@/lib/sn'
```

`src/client/workspace/routes.tsx:79-101` (the address is 1-based, and accepts any integer above 1):

```tsx
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
```

`src/client/workspace/routes.tsx:120-140`:

```tsx
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
```

`page.data` is `{ rows, total }`. `total` is the row count of the whole query, from the Table API's `X-Total-Count` header (`src/client/api.ts:44-48`, 0 when the header is absent). While the next page loads, `page.data` is the previous view's and `page.isPlaceholderData` is true.

Where the symptom shows, `src/client/components/data-grid.tsx:177` and `:232-241`:

```tsx
    const paged = server ? total > size : pageSize !== undefined && total > pageSize
```

```tsx
                        ) : shown.length === 0 ? (
                            <TableRow>
                                <TableCell colSpan={columnDefs.length}>
                                    <Empty>
                                        <EmptyHeader>
                                            <EmptyTitle>{empty ?? 'Nothing here'}</EmptyTitle>
```

With 50 rows left and `?page=2`, `total > size` is false, so no pager is drawn, and the page has no rows.

Conventions that apply:

- Client tests run under vitest in the `node` environment with no DOM test stack. A test cannot render `RecordList`. Put the decision in a pure exported function in `sn.ts` and test that.
- `sn.test.ts` already defines `const VIEW: ListView = { page: 0, size: 50, sort: null, search: '' }` at line 16. Reuse it.
- Style: 4-space indent, single quotes, no semicolons. Comments only for a non-obvious why.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Lint | `npm run lint` | exit 0 (needs plan 001; before it, use `npx eslint src`) |
| The helper's tests | `npx vitest run src/client/lib/sn.test.ts` | all pass |
| Build | `npm run build` | exit 0 |
| Full gate | `npm run check` | exit 0, all tests pass |
| Dev server | `npm run dev` | logs `UI pages served at http://localhost:<port>/`; needs SDK credentials for a ServiceNow instance |

## Scope

**In scope** (the only files you should modify):

- `src/client/lib/sn.ts`
- `src/client/lib/sn.test.ts`
- `src/client/workspace/routes.tsx`
- `src/fluent/generated/keys.ts`, only if `npm run build` rewrites it

**Out of scope** (do NOT touch):

- `src/client/components/data-grid.tsx`. The grid shows what it is given. The customer page also uses it with rows in memory, where the grid's own pager already stays in range.
- `parseListSearch`, `viewOf` and `searchOf`. Do not export or change them. Plan 018 exports and tests them later.
- `listPageQuery` and `listQuery` in `sn.ts`.
- `vitest.config.ts` and `package.json`. Add no test environment and no dependency.

## Git workflow

- Branch: `advisor/015-list-page-out-of-range`
- One commit. Subject in the repo's style, an imperative sentence under 72 characters, for example: `Show the last page of a list that shrank under its address`. The body says what was wrong and why (Back restored `?page=2` of a queue now one page long, which drew no rows and no pager).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write the failing tests for the page decision

In `src/client/lib/sn.test.ts`, change the import on line 3 to:

```ts
import { listQuery, pageWithin, type Field, type ListView } from './sn'
```

Append this block at the end of the file:

```ts
describe('pageWithin', () => {
    it.each([
        { page: 0, total: 0, shown: 0 },
        { page: 0, total: 120, shown: 0 },
        { page: 2, total: 120, shown: 2 },
        { page: 1, total: 51, shown: 1 },
    ])('keeps page $page of $total rows', ({ page, total, shown }) => {
        expect(pageWithin({ ...VIEW, page }, total)).toBe(shown)
    })

    it.each([
        { page: 1, total: 50, shown: 0 },
        { page: 1, total: 12, shown: 0 },
        { page: 3, total: 120, shown: 2 },
        { page: 2, total: 100, shown: 1 },
        { page: 4, total: 0, shown: 0 },
        { page: 1e9, total: 51, shown: 1 },
    ])('shows the last page with rows for page $page of a list shrunk to $total', ({ page, total, shown }) => {
        expect(pageWithin({ ...VIEW, page }, total)).toBe(shown)
    })
})
```

**Verify**: `npx vitest run src/client/lib/sn.test.ts` → fails, because `pageWithin` is not exported yet. This is the expected red state.

### Step 2: Add `pageWithin`

In `src/client/lib/sn.ts`, insert this directly above the comment `/** The classic form of a record, which carries every UI action and all form logic. */`:

```ts
/**
 * The page of `view` to show of `total` rows: its own, or the last one with rows when the list has shrunk since the
 * address was written (a work queue does, and Back returns to `?page=2` of it).
 */
export function pageWithin(view: ListView, total: number): number {
    return Math.min(view.page, Math.max(0, Math.ceil(total / view.size) - 1))
}

```

**Verify**: `npx vitest run src/client/lib/sn.test.ts` → all pass, 10 of them new.

### Step 3: Move the list to that page

Edit `src/client/workspace/routes.tsx`:

1. Line 4 becomes:

   ```tsx
   import { useEffect, useMemo, type ReactNode } from 'react'
   ```

2. Line 11 becomes:

   ```tsx
   import { fieldsQuery, listPageQuery, pageWithin, recordHref, type Field, type ListView, type SnRow } from '@/lib/sn'
   ```

3. In `RecordList`, insert these lines between the `const page = useQuery(...)` line and `return (`:

   ```tsx
       // The total of the page asked for, not of the previous view's rows kept on screen meanwhile.
       const shown = page.data && !page.isPlaceholderData ? pageWithin(view, page.data.total) : view.page
       useEffect(() => {
           if (shown !== view.page) void navigate({ search: (current: ListSearch) => searchOf({ ...viewOf(current), page: shown }), replace: true })
       }, [shown, view.page, navigate])
   ```

Change nothing else. `replace: true` matches how the list already writes its view to the address, so the out-of-range address leaves no history entry.

**Verify**: `npm run typecheck` → exit 0. `npm run lint` → exit 0.

### Step 4: Run the full gate

Run `npm run check`. It builds the app. Then run `git status --short`.

If `src/fluent/generated/keys.ts` is listed as modified, include it in the commit. The build names emitted page files by content, so a client change can rewrite it.

**Verify**: `npm run check` → exit 0. `git status --short` lists only files from the in-scope list.

### Step 5: Check the list in a browser (needs an instance)

This step needs SDK credentials for a ServiceNow instance with the app installed. If you have none, skip it, and say in your report that the browser check was not run.

1. Run `npm run dev`. Note the URL it logs.
2. Open `<logged URL>workspace.html#/lists/orders_all?page=9999` as a provider-staff user. Expected: the list shows rows. If *All orders* has more than 50 rows, the address ends in `?page=<last page>` and the pager is drawn with "Next page" disabled. If it has 50 or fewer, the address has no `page`.
3. Open `<logged URL>workspace.html#/lists/orders_all?page=2&sort=-number` on a list of more than 50 rows. Expected: page 2 shows and the address is unchanged.
4. Open `<logged URL>workspace.html#/lists/orders_all?page=9999&q=zzzznomatch`. Expected: "Nothing here", and the address keeps `q=zzzznomatch` and has no `page`.

**Verify**: the three addresses behave as written, and the Network tab shows no repeating Table API requests after the list settles.

## Test plan

- `src/client/lib/sn.test.ts`, new `describe('pageWithin')`, 10 cases given in full in step 1:
  - pages in range are kept, including the first page of an empty list and the last partial page;
  - the regression: page 2 of a list shrunk to 50 or 12 rows shows page 1;
  - a page past the end of a longer list shows its last page, also on an exact multiple of the page size;
  - an empty list and a hostile `page` of `1e9` both land in range.
- Structural pattern: the existing `describe('listQuery')` in the same file.
- The node tests cover the decision. They do not render `RecordList`, so the navigation is covered by typecheck and by step 5's browser check only.
- Verification: `npx vitest run src/client/lib/sn.test.ts` → all pass. `npm run check` → exit 0.

## Done criteria

Local. ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm run lint` exits 0
- [ ] `npx vitest run src/client/lib/sn.test.ts` passes, with the 10 `pageWithin` cases
- [ ] `npm run check` exits 0
- [ ] `grep -n "pageWithin" src/client/workspace/routes.tsx` returns two matches (the import and the call)
- [ ] `git diff --stat 1864b17..HEAD -- src/client/components/data-grid.tsx` is empty
- [ ] `git status --short` lists only in-scope files
- [ ] `plans/README.md` status row updated

Needs an instance (report as "not run" if you have none; the local criteria suffice to hand the work back):

- [ ] Step 5 browser check behaves as written

## STOP conditions

Stop and report back (do not improvise) if:

- `RecordList`, `viewOf` or `searchOf` in `src/client/workspace/routes.tsx` do not match the excerpts in "Current state".
- `npm run typecheck` rejects the `navigate({ search: (current: ListSearch) => ... })` call. Report the error text. Do not cast to `any`.
- In step 5, the address flips between two pages or the Table API is requested in a loop. That would mean the instance reports a different `X-Total-Count` for an out-of-range page than for an in-range one, which the unit tests cannot model.
- The fix seems to need a change to `data-grid.tsx` or to the query key in `listPageQuery`.

## Maintenance notes

- The decision uses the total of the page that was asked for. If `listPageQuery` ever stops returning `total` for an out-of-range offset, `pageWithin` sends the list to page 1, which is still a page with rows.
- If the page size becomes a user choice, `pageWithin` already reads `view.size`. Nothing here assumes 50.
- Plan 018 adds tests for `parseListSearch`, `viewOf` and `searchOf` and depends on this plan. It should also cover the functional `search` updater's inputs once those mappers are exported.
- Reviewer: check the effect's dependency list (`shown`, `view.page`, `navigate`) and that the navigation uses `replace: true`.
