# Plan 018: Test the client's untested mapping logic through pure modules

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 1864b17..HEAD -- src/client/lib src/client/workspace/routes.tsx src/client/workspace/widget.tsx src/client/warehouse src/client/components/data-grid.tsx`
> Plans 013 and 015 land before this one and change `src/client/warehouse/station.tsx`,
> `src/client/warehouse/ModeScreen.tsx`, `src/client/workspace/routes.tsx` and maybe
> `src/client/components/data-grid.tsx`. Those changes are expected; "Current state" says
> what each leaves behind. Any other difference from the excerpts is a STOP condition.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: LOW
- **Depends on**: plans/001-lint-tracked-sources.md, plans/013-failed-scans-visible.md, plans/015-*.md (the list page out-of-range plan)
- **Category**: tests
- **Planned at**: commit `1864b17`, 2026-11-12

## Why this matters

The React pages hold branching logic that no test reaches: how platform column metadata becomes a grid column, how Table API and Stats API replies are parsed, how a list's address (`?page=2&sort=-ends&q=cisco`) becomes a view and back, what a warehouse scan sends per mode, and how dashboard groups are folded into "Others". A wrong branch here shows a user wrong rows, a wrong count or sends a scan with the wrong context, and today only a person clicking through an instance would notice. This plan makes that logic importable by a node test and pins its current behaviour.

This plan changes no behaviour. It moves pure functions into `.ts` modules and adds tests.

## Current state

### The one rule that shapes this plan

Client tests run under vitest in the `node` environment. `vitest.config.ts`:

```ts
    test: {
        include: ['src/server/**/*.test.ts', 'src/client/**/*.test.ts'],
        environment: 'node',
    },
```

There is no jsdom and no component-test library. Do not add one. `vitest.config.ts` defines no `@/` alias. `tsconfig.test.json` typechecks `src/client/**/*.test.ts` with the server's compiler options: no `jsx`, no `paths`. So:

- **A test may import only `.ts` modules that import other modules by relative path.** A test that imports a `.tsx` file, or a `.ts` file that imports a `.tsx` file or uses `@/...`, fails typecheck or fails to resolve.
- Logic that sits in a `.tsx` file is therefore not made testable by adding `export`. It must move to a `.ts` file. The `.tsx` file then imports it.

`src/client/lib/sn.ts`, `src/client/lib/session.ts` and `src/client/api.ts` already satisfy the rule. `src/client/workspace/routes.tsx`, `src/client/workspace/widget.tsx` and `src/client/warehouse/station.tsx` do not.

### Existing tests to copy

- `src/client/api.test.ts` stubs `fetch` and `window`:

    ```ts
    function answer(status: number, body: string): void {
        vi.stubGlobal('window', { g_ck: 'token' })
        vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status })))
    }

    afterEach(() => vi.unstubAllGlobals())
    ```

- `src/client/lib/sn.test.ts` (46 lines) tests only `listQuery`. It has a `field(name, overrides)` helper and `FIELDS`, `VIEW`, `SOURCE` constants. Add to this file; do not replace it.
- `src/client/warehouse/scan-queue.test.ts` is the plain style for pure functions.

### `src/client/lib/sn.ts`

`fieldsQuery` (lines 89-116). Its `queryFn` needs a query client, because it reads each table's metadata through `client.ensureQueryData(metaQuery(on))`:

```ts
export const fieldsQuery = (table: string, names: readonly string[]) =>
    queryOptions({
        queryKey: ['sn', 'fields', table, names],
        staleTime: Infinity,
        queryFn: async ({ client }) =>
            Promise.all(
                names.map(async (name): Promise<Field> => {
                    const labels: string[] = []
                    let on = table
                    let column: MetaColumn | undefined
                    for (const part of name.split('.')) {
                        column = on ? (await client.ensureQueryData(metaQuery(on)))[part] : undefined
                        labels.push(column?.label ?? part)
                        on = column?.reference ?? ''
                    }
                    const kind = column ? kindOf(column) : 'text'
                    const display = column?.reference_display_field
                    return {
                        name,
                        label: labels.join(' › '),
                        kind,
                        references: kind === 'reference' ? (column?.reference ?? null) : null,
                        searchAs: kind === 'text' ? name : kind === 'reference' && display ? `${name}.${display}` : null,
                        sortable: column?.cansort ?? false,
                    }
                }),
            ),
    })
```

`kindOf` (lines 68-73) reads `column.internal_type ?? column.type`: `'reference'` and `'boolean'` map to themselves, the types in `NUMBER_TYPES` (`integer`, `longint`, `decimal`, `float`, `currency`, `price`, `percent_complete`) to `'number'`, anything else to `'text'`. The metadata is read from `/api/now/ui/meta/<table>` and its columns are under `result.columns`.

`listPageQuery` (lines 136-167), the cell parsing at 154-163:

```ts
            const rows = (result as Array<Record<string, Cell>>).map((record): SnRow => {
                const display: Record<string, string> = {}
                const value: Record<string, string> = {}
                for (const name of ['sys_id', ...names]) {
                    const cell = record[name]
                    value[name] = typeof cell === 'object' ? text(cell.value) : text(cell)
                    display[name] = typeof cell === 'object' ? text(cell.display_value) : text(cell)
                }
                return { id: value.sys_id, display, value }
            })
            return { rows, total }
```

It sends `sysparm_query`, `sysparm_fields` (`sys_id` then the field names, comma-joined), `sysparm_display_value=all`, `sysparm_exclude_reference_link=true`, `sysparm_limit` (the view's size) and `sysparm_offset` (page times size) to `/api/now/table/<table>`. `total` is the `X-Total-Count` response header (`src/client/api.ts:45-48`, 0 when absent).

`stats`, `countQuery`, `sumQuery` (lines 186-225):

```ts
async function stats(source: Source, groupBy: string[], params: Record<string, string>, signal: AbortSignal): Promise<StatsGroup[]> {
    const { result } = await platformGet(
        `/stats/${encodeURIComponent(source.table)}`,
        { sysparm_query: source.filter, sysparm_display_value: 'all', ...(groupBy.length ? { sysparm_group_by: groupBy.join(',') } : {}), ...params },
        signal,
    )
    return Array.isArray(result) ? result : [result as StatsGroup]
}
```

```ts
                .map((group) => {
                    const entry = by ? groupOf(group, by) : undefined
                    return { key: entry?.value ?? '', label: entry?.display_value || entry?.value || '(empty)', count: Number(group.stats?.count ?? 0) }
                })
                .sort((a, b) => b.count - a.count),
```

```ts
            (await stats(source, by ? [by, money.currency] : [money.currency], { sysparm_sum_fields: money.amount }, signal)).map((group) => {
                const entry = by ? groupOf(group, by) : undefined
                const currency = groupOf(group, money.currency)
                return {
                    key: entry?.value ?? '',
                    label: entry?.display_value || entry?.value || '(empty)',
                    currency: currency?.display_value || currency?.value || '',
                    amount: Number(group.stats?.sum?.[money.amount] ?? 0),
                }
            }),
```

A stats group looks like `{ stats: { count: '7', sum: { amount: '120.5' } }, groupby_fields: [{ field: 'stage', value: 'draft', display_value: 'Draft' }] }`. `countQuery` sends `sysparm_count=true`.

### `src/client/lib/session.ts` (lines 14-27)

```ts
export const sessionQuery = queryOptions({
    queryKey: ['session'],
    staleTime: Infinity,
    queryFn: async (): Promise<Session> => {
        const roles = await get<SessionRoles>('/me').then(
            (reply) => new Set<string>(reply.roles),
            (error: unknown) => {
                if (error instanceof ApiError && error.status === 403) return new Set<string>()
                throw error
            },
        )
        return { holdsAny: (group) => group.some((role) => roles.has(role)) }
    },
})
```

`get('/me')` fetches `/api/x_daas_ham/naas/me`. Role names are in `src/server/domain/roles.ts` (`ROLE`), which a client test may import (see `src/client/workspace/catalog.test.ts:4`).

### `src/client/workspace/routes.tsx` (at the planned-at commit, lines 16 and 71-101)

```tsx
const PAGE_SIZE = 50
```

```tsx
/** A list's view in its address: `?page=2&sort=-ends&q=cisco`, each left out at its default. */
interface ListSearch {
    page?: number
    /** A field, `-` first for descending. */
    sort?: string
    q?: string
}

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

They are used at `validateSearch: parseListSearch` (line 106) and in `RecordList` (lines 125, 136). The address page is 1-based; the view's page is 0-based.

**What plan 015 leaves behind.** Plan 015 fixes a list opened on a page past its end. It adds a new pure exported function that clamps the page, in `src/client/workspace/routes.tsx`, `src/client/components/data-grid.tsx`, or a new `.ts` file next to one of them, with its own test. You were not given its name. Find it before step 4:

```sh
git log --oneline 1864b17..HEAD -- src/client/workspace src/client/components/data-grid.tsx
git diff 1864b17..HEAD -- src/client/workspace src/client/components/data-grid.tsx
```

Rules for living with it:

- Do not write tests for 015's function. It has its own.
- If 015 already moved `parseListSearch`, `viewOf` and `searchOf` into a `.ts` module, step 4 only adds the tests beside that module.
- If 015 put its function in a new pure `.ts` module under `src/client/workspace/`, put the three functions in that same module instead of creating `list-search.ts`, and leave its test file's existing cases alone.
- If 015 changed the body of one of the three functions, move 015's version unchanged.

### `src/client/workspace/widget.tsx` (lines 67-71 and 159-166)

```tsx
function topGroups(tally: Tally, top: number, others: boolean): Tally {
    const rest = tally.slice(top)
    const shown = tally.slice(0, top)
    return others && rest.length > 0 ? [...shown, { key: '', label: 'Others', count: rest.reduce((sum, group) => sum + group.count, 0) }] : shown
}
```

```tsx
const TINT = ['bg-chart-1/10', 'bg-chart-1/20', 'bg-chart-1/35', 'bg-chart-1/50', 'bg-chart-1/70']
const NEGATIVE_TINT = ['bg-destructive/10', 'bg-destructive/20', 'bg-destructive/35', 'bg-destructive/50', 'bg-destructive/70']

function tint(amount: number, largest: number): string {
    if (!largest || !amount) return ''
    const step = Math.min(TINT.length - 1, Math.floor((Math.abs(amount) / largest) * TINT.length))
    return (amount < 0 ? NEGATIVE_TINT : TINT)[step] ?? ''
}
```

`topGroups` is called in `CountChart` (line 79), `tint` in `CurrencyMatrix` (line 198). The class names are Tailwind classes. Tailwind 4 (`@tailwindcss/vite`, `src/client/app.css` has `@import "tailwindcss"`) finds class names in every source file, `.ts` included, as long as each is written out in full as a string. Keep them as full literals.

### `src/client/warehouse/station.tsx`

At the planned-at commit, lines 8-48 hold the mode table and the scan types, and lines 120-153 hold `perform` and `describe`:

```tsx
export type Mode = 'receive' | 'putaway' | 'pick' | 'audit' | 'lookup'

/** What a scan is done with, besides its code. */
export type ContextField = 'stockroom' | 'pid' | 'orderNumber' | 'auditNumber'

export interface ModeSpec { ... }

export const MODES: readonly ModeSpec[] = [ ...five modes... ]

/** The modes a user may use: `null` stockrooms is a field tech, refused depot work. */
export function modesFor(stockrooms: Stockroom[] | null | undefined): readonly ModeSpec[] {
    return stockrooms === null ? MODES.filter((m) => !m.depot) : MODES
}

type Context = Record<ContextField, string>

interface Scan extends Context {
    mode: Mode
    code: string
}
...
type Scanned = { mode: Exclude<Mode, 'audit'>; asset: AssetSummary } | { mode: 'audit'; code: string }
```

```tsx
    const scan = (mode: Mode, code: string) => {
        queue({ ...context, mode, code, pid: mode === 'receive' ? context.pid.trim() : '' })
        // A PID is for the one unit scanned after it, whether that receive succeeds or fails: kept, it would go with the
        // next serial too, and an unknown (or shortened) serial with a PID is created as a new Asset of that Model.
        if (mode === 'receive') setChosen((c) => ({ ...c, pid: '' }))
    }
```

```tsx
async function perform(scan: Scan): Promise<Scanned> {
    const { mode, code } = scan
    switch (mode) {
        case 'receive':
            return { mode, asset: await warehouseApi.receive({ code, stockroom: scan.stockroom, pid: scan.pid || undefined }) }
        case 'putaway':
            return { mode, asset: await warehouseApi.putAway({ code, stockroom: scan.stockroom }) }
        case 'pick':
            if (!scan.orderNumber) throw new Error('Enter the order number first')
            return { mode, asset: await warehouseApi.pick({ code, order: scan.orderNumber }) }
        case 'audit':
            if (!scan.auditNumber) throw new Error('Enter the audit number first')
            await warehouseApi.auditScan({ audit: scan.auditNumber, code })
            return { mode, code }
        case 'lookup':
            return { mode, asset: await warehouseApi.lookup(code) }
    }
}

function describe(scanned: Scanned): string {
    if (scanned.mode === 'audit') return `${scanned.code} counted`
    const { asset } = scanned
    const name = `${asset.serial} (${asset.pid || asset.model})`
    switch (scanned.mode) {
        case 'receive':
            return `Received ${name} as ${asset.providerTag}${asset.orderLine ? `, allocated to ${asset.orderLine}` : ''}`
        case 'putaway':
            return `${name} put away in ${asset.stockroom}`
        case 'pick':
            return `${name} picked`
        case 'lookup':
            return `${name}: ${stageText(asset.stage)}, ${asset.stockroom || asset.customer || 'no location'}${asset.providerTag ? `, tag ${asset.providerTag}` : ''}`
    }
}
```

`warehouseApi` (`src/client/warehouse/api.ts`) posts to `/receive`, `/putaway`, `/pick`, `/audits/<audit>/scan` (body `{ code }` only) and gets `/assets/<code>`, all under `/api/x_daas_ham/naas`. `src/client/warehouse/api.ts` imports only relative modules and `@tanstack/react-query`, so a pure module may import it.

**What plan 013 leaves behind.** Plan 013 (`plans/013-failed-scans-visible.md`) adds `src/client/warehouse/scan-log.ts` (a pure reducer, with its own test `scan-log.test.ts`), removes the `Entry` interface from `station.tsx`, adds `export` to `interface Scan`, and replaces the log state with `useReducer`. `ModeScreen.tsx` then imports `MODES` and `type Scan` from `./station`. It does not touch `perform`, `describe`, the mode table or the `scan` closure. Do not add tests to `scan-log.test.ts`.

`AssetSummary` (`src/server/domain/rest-contracts.ts:16-26`) has the string fields `id`, `serial`, `providerTag`, `model`, `pid`, `stage`, `stockroom`, `customer`, `orderLine`. `stageText` (`src/client/stage.ts`) replaces `_` with a space.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Lint | `npm run lint` | exit 0 |
| One test file | `npx vitest run <path>` | all pass |
| All client tests | `npx vitest run src/client` | all pass |
| Build | `npm run build` | exit 0 |
| Full gate | `npm run check` | exit 0, all tests pass |

`npm run build` rewrites the tracked file `src/fluent/generated/keys.ts`. If `git status` shows it changed, commit it.

## Scope

**In scope** (the only files you should modify):

- `src/client/lib/sn.test.ts` (add cases)
- `src/client/lib/session.test.ts` (create)
- `src/client/workspace/list-search.ts` (create, unless plan 015 already made a module for it; see above)
- `src/client/workspace/list-search.test.ts` (create, or add to 015's test file under the same condition)
- `src/client/workspace/routes.tsx` (remove the moved code, import it)
- `src/client/workspace/tally.ts` (create)
- `src/client/workspace/tally.test.ts` (create)
- `src/client/workspace/widget.tsx` (remove the moved code, import it)
- `src/client/warehouse/scans.ts` (create)
- `src/client/warehouse/scans.test.ts` (create)
- `src/client/warehouse/station.tsx` (remove the moved code, import it)
- `src/client/warehouse/ModeScreen.tsx` and `src/client/warehouse/routes.tsx` (import paths only)
- `src/fluent/generated/keys.ts` (only if the build rewrites it)

**Out of scope** (do NOT touch):

- `src/client/lib/sn.ts`, `src/client/lib/session.ts`, `src/client/api.ts`. They are tested as they are. A test that fails on them is a finding to report, not to fix here.
- `vitest.config.ts`, any `tsconfig`, `package.json`. No jsdom, no testing-library, no alias.
- Plan 015's clamp function and its tests. Plan 013's `scan-log.ts` and its test.
- `money` in `widget.tsx` (its output depends on the machine's locale) and every React component.
- Any change to what the moved functions do. Move them character for character, apart from adding `export`.

## Git workflow

- Branch: `advisor/018-client-logic-tests`
- One commit per step from step 2 on. Subjects are imperative sentences under 72 characters in the repo's style, for example `Test how a list reads column metadata and platform replies`, `Move a list's address parsing out of the routes and test it`. The body says what was untested and why the code moved.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Confirm the starting point

Run the drift check and the two `git log`/`git diff` commands under "What plan 015 leaves behind". Write down where 015's function lives and whether it moved the list-search functions. Run `grep -n "export interface Scan\|scan-log" src/client/warehouse/station.tsx` and confirm plan 013 has landed (both patterns match).

**Verify**: `npm run check` → exit 0 before you change anything.

### Step 2: Test `sn.ts` through its query functions

Add to `src/client/lib/sn.test.ts`. Extend the imports: `afterEach` and `vi` from `vitest`, `QueryClient` from `@tanstack/react-query`, and `countQuery`, `fieldsQuery`, `listPageQuery`, `sumQuery` from `./sn`. Add this helper and cleanup once, above the new `describe` blocks. It was tried against the current code and works in the node environment:

```ts
/** Answers each platform GET with `replies(url)` under `result`, and returns the URLs asked for. */
function answer(replies: (url: URL) => { body: unknown; total?: number }): URL[] {
    const calls: URL[] = []
    vi.stubGlobal('window', {})
    vi.stubGlobal(
        'fetch',
        vi.fn(async (to: string) => {
            const url = new URL(to, 'http://instance')
            calls.push(url)
            const { body, total } = replies(url)
            return new Response(JSON.stringify({ result: body }), { headers: total === undefined ? {} : { 'X-Total-Count': String(total) } })
        }),
    )
    return calls
}

afterEach(() => vi.unstubAllGlobals())
```

Run a query with `await new QueryClient().fetchQuery(<query options>)`. Use a new `QueryClient` per test, so no test reads another's cached metadata.

`describe('fieldsQuery', ...)`. Metadata for the tests: table `x_daas_ham_order` has columns `number` `{ label: 'Number', type: 'string', cansort: true }`, `agreement` `{ label: 'Agreement', internal_type: 'reference', reference: 'x_daas_ham_agreement', reference_display_field: 'number', cansort: true }`, `site` `{ label: 'Site', internal_type: 'reference', reference: 'cmn_location' }`, `quantity` `{ label: 'Quantity', type: 'integer' }`, `active` `{ label: 'Active', internal_type: 'boolean' }`. Table `x_daas_ham_agreement` has `currency` `{ label: 'Currency', type: 'string' }`. Reply with `{ columns: ... }` chosen by `url.pathname` (`/api/now/ui/meta/<table>`). Cases:

1. `reads a text column as searchable under its own name`: `number` gives `{ name: 'number', label: 'Number', kind: 'text', references: null, searchAs: 'number', sortable: true }`.
2. `reads a reference with the table it points at, searched by its display field`: `agreement` gives `kind: 'reference'`, `references: 'x_daas_ham_agreement'`, `searchAs: 'agreement.number'`, `sortable: true`.
3. `does not search a reference whose display field the metadata lacks`: `site` gives `kind: 'reference'`, `references: 'cmn_location'`, `searchAs: null`, `sortable: false`.
4. `reads number and boolean columns as not searchable`: `quantity` gives `kind: 'number'`, `searchAs: null`; `active` gives `kind: 'boolean'`, `searchAs: null`. Both `references: null`.
5. `labels a dot-walk with each step and reads the last column`: `agreement.currency` gives `label: 'Agreement › Currency'`, `kind: 'text'`, `searchAs: 'agreement.currency'`, `sortable: false`.
6. `shows a column the metadata lacks under its own name`: `secret` gives `{ name: 'secret', label: 'secret', kind: 'text', references: null, searchAs: 'secret', sortable: false }`.
7. `keeps the order of the names and reads each table's metadata once`: ask for `['quantity', 'number', 'agreement.currency', 'agreement']` in one call. The result names are in that order. The returned `calls` hold exactly one URL with pathname `/api/now/ui/meta/x_daas_ham_order` and one with `/api/now/ui/meta/x_daas_ham_agreement`.

`describe('listPageQuery', ...)`. Use the file's `field()` helper for fields `number`, `company`, `gone`, source `{ table: 'x_daas_ham_order', filter: 'active=true' }`, view `{ ...VIEW, page: 2 }`. Reply body: `[{ sys_id: { value: 'id1', display_value: 'id1' }, number: { value: 'NORD1', display_value: 'NORD1' }, company: { value: 'c1', display_value: 'Acme' } }, { sys_id: 'id2', number: 'NORD2', company: { value: null } }]`, `total: 120`. Cases:

8. `reads each cell's stored value and the text shown for it`: row 0 is `{ id: 'id1', value: { sys_id: 'id1', number: 'NORD1', company: 'c1', gone: '' }, display: { sys_id: 'id1', number: 'NORD1', company: 'Acme', gone: '' } }`.
9. `reads a plain cell as both, and a missing or null one as empty`: row 1 has `id: 'id2'`, `value.number` and `display.number` both `'NORD2'`, `value.company` and `display.company` both `''`.
10. `takes the total from the reply's row count header`: `total` is `120`; with no `total` in the reply it is `0`.
11. `asks for the page by offset, for its fields and sys_id`: `calls[0].pathname` is `/api/now/table/x_daas_ham_order`; its `searchParams` have `sysparm_offset` `'100'`, `sysparm_limit` `'50'`, `sysparm_fields` `'sys_id,number,company,gone'`, `sysparm_display_value` `'all'`, and `sysparm_query` equal to `listQuery(source, [], view, fields)`.

`describe('countQuery', ...)`:

12. `counts a source with no grouping from a reply that is one object`: reply body `{ stats: { count: '7' } }` (an object, not an array) gives `[{ key: '', label: '(empty)', count: 7 }]`. `calls[0].searchParams.get('sysparm_group_by')` is `null` and `sysparm_count` is `'true'`.
13. `counts per group, largest first, labelled by the text shown, then the value, then (empty)`: reply an array of three groups for `by = 'stage'`: `draft`/`Draft` count `'2'`, value `'x1'` with `display_value: ''` count `'9'`, value `''` with `display_value: ''` count `'5'`. Expect `[{ key: 'x1', label: 'x1', count: 9 }, { key: '', label: '(empty)', count: 5 }, { key: 'draft', label: 'Draft', count: 2 }]`, and `sysparm_group_by` `'stage'`.
14. `counts a group with no stats as none`: a group `{ groupby_fields: [...] }` without `stats` gives `count: 0`.

`describe('sumQuery', ...)` with `money = { amount: 'amount', currency: 'currency' }`:

15. `sums per currency, never across`: no `by`. Reply two groups, `groupby_fields: [{ field: 'currency', value: 'EUR', display_value: 'EUR' }]` with `stats.sum.amount` `'120.5'`, and `NOK` with `'90'`. Expect `[{ key: '', label: '(empty)', currency: 'EUR', amount: 120.5 }, { key: '', label: '(empty)', currency: 'NOK', amount: 90 }]`. `sysparm_group_by` is `'currency'`, `sysparm_sum_fields` is `'amount'`.
16. `sums per group and currency`: `by = 'customer'`. Each group has two `groupby_fields` entries (customer and currency). Expect `key` and `label` from the customer entry, `currency` from the currency entry, and `sysparm_group_by` `'customer,currency'`.
17. `reads a missing sum as 0 and a missing currency as ''`.

**Verify**: `npx vitest run src/client/lib/sn.test.ts` → all pass: the 5 existing `listQuery` tests and 17 new ones.

### Step 3: Test the session's roles

Create `src/client/lib/session.test.ts`. Import `QueryClient`, `sessionQuery` from `./session`, `ROLE` from `../../server/domain/roles`, and `ApiError` from `../api`. Stub `window` and `fetch` as in `src/client/api.test.ts` (a `Response` with a status and a JSON body). Cases, each with a new `QueryClient` and `fetchQuery(sessionQuery)`:

1. `holds the roles GET /me answers with`: body `{ result: { roles: [ROLE.assetManager] } }` (use any one real key of `ROLE`; open `src/server/domain/roles.ts` for the names). `holdsAny([that role])` is `true`; `holdsAny([another role])` is `false`; `holdsAny([])` is `false`. `fetch` was called with a URL of `/api/x_daas_ham/naas/me`.
2. `holds no role when the route refuses the user`: status 403 with body `{ result: { error: 'Requires an internal user' } }`. The query resolves and `holdsAny` is `false` for every role in `Object.values(ROLE)`.
3. `fails on any other error`: status 500. `fetchQuery` rejects with an `ApiError` whose `status` is `500`.

**Verify**: `npx vitest run src/client/lib/session.test.ts` → 3 tests pass.

### Step 4: Move the list address parsing to a pure module and test it

(Apply the rules under "What plan 015 leaves behind" first. The default below assumes 015 left the three functions in `routes.tsx`.)

1. Create `src/client/workspace/list-search.ts`. Move into it, unchanged, `PAGE_SIZE`, `ListSearch` with its doc comment, `parseListSearch`, `viewOf`, `searchOf`. Add `export` to each. Its only import is `import type { ListView } from '../lib/sn'` (relative, not `@/lib/sn`).
2. In `src/client/workspace/routes.tsx` delete the moved declarations and add `import { parseListSearch, searchOf, viewOf } from './list-search'`. Import `PAGE_SIZE` or `type ListSearch` too only if `routes.tsx` still uses them. Remove `type ListView` from the `@/lib/sn` import if it is now unused there.
3. Create `src/client/workspace/list-search.test.ts`, in the style of `src/client/warehouse/scan-queue.test.ts`. Cases:

    `parseListSearch`:
    - `keeps a page past the first`: `{ page: 2 }` and `{ page: '3' }` give `{ page: 2 }` and `{ page: 3 }`.
    - `leaves out the first page and anything that is no page`: `{ page: 1 }`, `{ page: 0 }`, `{ page: -2 }`, `{ page: 1.5 }`, `{ page: 'x' }`, `{}` each give `{}`.
    - `keeps a sort on a field, descending with a leading -`: `'ends'`, `'-ends'`, `'agreement.currency'` are kept as given.
    - `drops a sort that is no field name`: `'ends^NQactive=true'`, `'--ends'`, `'a b'`, `''`, `5` each give `{}`.
    - `keeps the text searched for, a number as text`: `{ q: 'cisco' }` gives `{ q: 'cisco' }`; `{ q: 42 }` gives `{ q: '42' }`; `{ q: '' }`, `{ q: {} }`, `{ q: null }` give `{}`.

    `viewOf`:
    - `opens the first page in the list's own order with no search`: `viewOf({})` is `{ page: 0, size: PAGE_SIZE, sort: null, search: '' }`.
    - `counts pages from 0 where the address counts from 1`: `viewOf({ page: 3 }).page` is `2`.
    - `reads the sort's field and direction`: `'-ends'` gives `{ id: 'ends', desc: true }`; `'ends'` gives `{ id: 'ends', desc: false }`.

    `searchOf`:
    - `leaves each part out at its default`: the view from `viewOf({})` gives `{}`.
    - `writes the view back as the address had it`: for each of `{ page: 2 }`, `{ sort: '-ends' }`, `{ sort: 'agreement.currency', q: 'cisco' }`, `{ page: 4, sort: 'ends', q: 'x' }`, `searchOf(viewOf(search))` equals `search`.

    If plan 015 intentionally changed one of these behaviours (its commit message or plan will say so), assert 015's behaviour for that case and name the plan in the test title. If you cannot tell whether a difference is intended, STOP.

**Verify**: `npx vitest run src/client/workspace` → all pass, including `catalog.test.ts` and 015's tests. `npm run typecheck` → exit 0. `grep -n "function parseListSearch\|function viewOf\|function searchOf" src/client/workspace/routes.tsx` → no matches.

### Step 5: Move the dashboard's group folding and tint to a pure module and test them

1. Create `src/client/workspace/tally.ts`. Move into it, unchanged, `topGroups`, `TINT`, `NEGATIVE_TINT` and `tint`. Export `topGroups` and `tint`. Import `type Tally` with `import type { Tally } from '../lib/sn'`. Give each a one-line doc comment, since they now stand alone:
    - `/** The `top` largest groups, the rest added up as one "Others" group when `others` asks for it. */`
    - `/** The background of a matrix cell: darker the nearer `amount` is to the column's `largest`, red below zero, none for zero. */`
2. In `src/client/workspace/widget.tsx` delete the moved declarations and add `import { tint, topGroups } from './tally'`.
3. Create `src/client/workspace/tally.test.ts`. With `tally = [{ key: 'a', label: 'A', count: 9 }, { key: 'b', label: 'B', count: 5 }, { key: 'c', label: 'C', count: 2 }, { key: 'd', label: 'D', count: 1 }]`:
    - `shows the top groups and adds up the rest as Others`: `topGroups(tally, 2, true)` is the first two entries then `{ key: '', label: 'Others', count: 3 }`.
    - `drops the rest when Others is not asked for`: `topGroups(tally, 2, false)` is the first two entries.
    - `adds no Others when nothing is left over`: `topGroups(tally, 4, true)` and `topGroups(tally, 10, true)` equal `tally`; `topGroups([], 3, true)` is `[]`.
    - `tints nothing for no amount or an empty column`: `tint(0, 100)` and `tint(50, 0)` are `''`.
    - `tints darker the nearer an amount is to the largest`: `tint(10, 100)` is `'bg-chart-1/10'`, `tint(50, 100)` is `'bg-chart-1/35'`, `tint(100, 100)` is `'bg-chart-1/70'`.
    - `tints a negative amount red by its size`: `tint(-100, 100)` is `'bg-destructive/70'`, `tint(-10, 100)` is `'bg-destructive/10'`.

**Verify**: `npx vitest run src/client/workspace/tally.test.ts` → 6 tests pass. `npm run typecheck` → exit 0. `npm run build` → exit 0.

### Step 6: Move the warehouse's scan logic to a pure module and test it

1. Create `src/client/warehouse/scans.ts`. Move into it from `station.tsx`, unchanged: `Mode`, `ContextField`, `ModeSpec`, `MODES`, `modesFor`, `Context`, `Scan`, `Scanned`, `perform`, `describe`, each with its comment. Export all of them. Its imports are `import type { AssetSummary, Stockroom } from '../../server/domain/rest-contracts'`, `import { stageText } from '../stage'` and `import { warehouseApi } from './api'`.
2. In the same file add two small pure functions that carry the logic of the `scan` closure, with the closure's comment moved onto the second:

    ```ts
    /** The scan as it is queued: the code with the context it was scanned in. Only a receive carries the PID. */
    export function scanOf(context: Context, mode: Mode, code: string): Scan {
        return { ...context, mode, code, pid: mode === 'receive' ? context.pid.trim() : '' }
    }

    /**
     * The context fields once a scan is queued. A PID is for the one unit scanned after it, whether that receive
     * succeeds or fails: kept, it would go with the next serial too, and an unknown (or shortened) serial with a PID is
     * created as a new Asset of that Model.
     */
    export function contextAfter(context: Context, mode: Mode): Context {
        return mode === 'receive' ? { ...context, pid: '' } : context
    }
    ```

3. In `station.tsx`:
    - Delete the moved declarations. Import what the file still uses from `./scans` (`contextAfter`, `describe`, `perform`, `scanOf`, and the types `Context`, `ContextField`, `Mode`, `Scan`). Remove imports that are now unused (`stageText`, `warehouseApi`, the `Stockroom` or `AssetSummary` types if unused; `stockroomsQuery` is still used).
    - The `scan` closure becomes:

        ```tsx
        const scan = (mode: Mode, code: string) => {
            queue(scanOf(context, mode, code))
            setChosen((chosen) => contextAfter(chosen, mode))
        }
        ```

        `contextAfter` returns the same object for a mode other than receive, so React skips the re-render as before.
    - Do not re-export anything from `station.tsx`. It keeps `useStation` and `StationProvider`.
4. Fix the importers. `src/client/warehouse/ModeScreen.tsx` and `src/client/warehouse/routes.tsx` import `MODES`, `modesFor`, `type ContextField`, `type ModeSpec`, `type Scan` from `./scans` now, and `useStation` / `StationProvider` from `./station`. Find every one with `grep -rn "from './station'" src/client/warehouse`.
5. Create `src/client/warehouse/scans.test.ts`. Stub `window` and `fetch` as in `src/client/api.test.ts`; reply `{ result: asset }`. Helpers:

    ```ts
    const CONTEXT = { stockroom: 'room1', pid: ' C9300-48P-E ', orderNumber: 'NORD1', auditNumber: 'NAUD1' }
    const asset = (overrides: Partial<AssetSummary> = {}): AssetSummary => ({ id: 'a1', serial: 'SN1', providerTag: 'P0001', model: 'Catalyst 9300', pid: 'C9300-48P-E', stage: 'in_stock', stockroom: 'Oslo depot', customer: '', orderLine: '', ...overrides })
    ```

    Use a real value of `AssetStage` for `stage` (see `src/server/domain/rest-contracts.ts`); if `'in_stock'` is not one, pick one that is, and one containing `_` for the Look up case.

    Cases:

    `modesFor`:
    - `offers a field tech, who has no stockrooms to work in, only Audit and Look up`: `modesFor(null)` ids are `['audit', 'lookup']`.
    - `offers every mode otherwise, also while the stockrooms load`: `modesFor([])` and `modesFor(undefined)` are `MODES`.

    `scanOf` and `contextAfter`:
    - `queues a receive with its PID trimmed`: `scanOf(CONTEXT, 'receive', 'SN1')` is `{ ...CONTEXT, pid: 'C9300-48P-E', mode: 'receive', code: 'SN1' }`.
    - `sends no PID with any other scan`: for `putaway`, `pick`, `audit`, `lookup`, `scanOf(...).pid` is `''`.
    - `clears the PID once a receive is queued, so it never goes with the next serial`: `contextAfter(CONTEXT, 'receive')` is `{ ...CONTEXT, pid: '' }`.
    - `keeps the context after any other scan`: `contextAfter(CONTEXT, 'pick')` is `CONTEXT` itself (`toBe`).

    `perform`:
    - `receives into the stockroom, with the PID only when one was given`: with pid `'C9300-48P-E'` the `fetch` call is to `/api/x_daas_ham/naas/receive`, method `POST`, body `'{"code":"SN1","stockroom":"room1","pid":"C9300-48P-E"}'`. With pid `''` the body is `'{"code":"SN1","stockroom":"room1"}'`. The result is `{ mode: 'receive', asset }`.
    - `puts away to the stockroom`: `/putaway`, body `'{"code":"SN1","stockroom":"room1"}'`.
    - `picks for the order`: `/pick`, body `'{"code":"SN1","order":"NORD1"}'`.
    - `refuses a pick with no order number, and an audit scan with no audit number, before any request`: each rejects with the message `Enter the order number first` / `Enter the audit number first`, and `fetch` was not called.
    - `counts an audit scan blind`: URL `/api/x_daas_ham/naas/audits/NAUD1/scan`, body `'{"code":"SN1"}'`, result `{ mode: 'audit', code: 'SN1' }`.
    - `looks up by the code, encoded`: code `'SN 1/2'` gets `/api/x_daas_ham/naas/assets/SN%201%2F2` with method `GET`.

    `describe`:
    - `names a received unit by its tag, and its order line when it was allocated`: `Received SN1 (C9300-48P-E) as P0001`, and with `orderLine: 'NORL1'` the same plus `, allocated to NORL1`.
    - `names a unit by its Model when it has no PID`: `pid: ''` gives `SN1 (Catalyst 9300) picked` for mode `pick`.
    - `says where a unit was put away`: `SN1 (C9300-48P-E) put away in Oslo depot`.
    - `says a counted code only`: `{ mode: 'audit', code: 'SN1' }` gives `SN1 counted`.
    - `describes a looked-up unit by stage and place`: the stage with `_` shown as a space; the place is the stockroom, else the customer, else `no location`; `, tag P0001` is added only when the unit has a tag. Write three assertions, one per place.

**Verify**: `npx vitest run src/client/warehouse` → all pass, including `scan-queue`, `code128` and plan 013's `scan-log` tests. `npm run typecheck` → exit 0. `grep -n "function perform\|function describe\|export const MODES" src/client/warehouse/station.tsx` → no matches.

### Step 7: Run the gate

**Verify**: `npm run check` → exit 0. Commit `src/fluent/generated/keys.ts` if the build changed it.

### Step 8 (needs an instance; optional): Smoke the three pages

The moves in steps 4 to 6 touch files with no automated test of their rendering. `npm run dev` serves the pages from source and proxies the instance's APIs; it only works with a ServiceNow instance configured for `now-sdk`. If you have none, skip this step and say so in your report. With one: open `/workspace.html` (a list sorts, pages and searches, and its address changes; a dashboard matrix widget is tinted), and `/warehouse.html` (a Look up scan answers; in Receive, a typed PID is cleared after one scan).

## Test plan

- `src/client/lib/sn.test.ts`: 17 new cases (step 2) beside the 5 existing.
- `src/client/lib/session.test.ts`: 3 cases (step 3).
- `src/client/workspace/list-search.test.ts`: 10 cases (step 4).
- `src/client/workspace/tally.test.ts`: 6 cases (step 5).
- `src/client/warehouse/scans.test.ts`: 17 cases (step 6).
- Patterns: `src/client/api.test.ts` for stubbing `fetch`; `src/client/warehouse/scan-queue.test.ts` for pure functions.
- Every test here pins what the code does today. **A test that fails against the unchanged logic is a finding.** Do not change `sn.ts`, `session.ts` or a moved function to make it pass, and do not weaken the assertion. First check the expected value against the excerpts in "Current state". If the code and this plan disagree, report it (see STOP conditions).
- Not covered, on purpose: plan 015's clamp function and plan 013's reducer (they have their own tests), React components, `money`.

## Done criteria

ALL must hold. All are local; none needs an instance.

- [ ] `npm run check` exits 0
- [ ] `npx vitest run src/client` passes, with the new files `lib/session.test.ts`, `workspace/list-search.test.ts` (or 015's file extended), `workspace/tally.test.ts`, `warehouse/scans.test.ts` present
- [ ] `git diff 1864b17..HEAD --stat -- src/client/lib/sn.ts src/client/lib/session.ts src/client/api.ts vitest.config.ts tsconfig.test.json package.json` shows no change made by this plan
- [ ] `grep -rn "from '@/\|\.tsx'" src/client --include=*.test.ts` returns no matches
- [ ] `grep -rn "from '@/" src/client/workspace/list-search.ts src/client/workspace/tally.ts src/client/warehouse/scans.ts` returns no matches
- [ ] `grep -n "function topGroups\|function tint" src/client/workspace/widget.tsx` returns no matches
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row updated
- [ ] Your report lists any test whose expected value you had to change from this plan, with the reason, and says whether step 8 was run or skipped

## STOP conditions

Stop and report back (do not improvise) if:

- Plan 013 or plan 015 has not landed (step 1's checks fail).
- Code outside what 013 and 015 are described as changing does not match the excerpts.
- A new test fails and the excerpt in "Current state" agrees with this plan's expected value. That is a bug in the code or in the plan; report the test, the expected and the actual value. Do not fix `sn.ts`, `session.ts` or the moved function here.
- Plan 015 changed `parseListSearch`, `viewOf` or `searchOf` and you cannot tell from its plan or commit message whether a behaviour change was intended.
- A test seems to need jsdom, a testing library, a vitest alias, or a change to `vitest.config.ts`, a `tsconfig` or `package.json`.
- A new `.ts` module needs to import from a `.tsx` file or through `@/` to compile.
- After step 5, `npm run build` passes but you have reason to think the tint classes are missing from the built CSS (for example the step 8 check shows an untinted matrix). Report it; do not add a Tailwind `@source` or safelist on your own.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- The rule from "Current state" is now the pattern for client logic: branching that is worth a test lives in a `.ts` module with relative imports, and the `.tsx` file imports it. New logic added to `routes.tsx`, `widget.tsx` or `station.tsx` should start in `list-search.ts`, `tally.ts` or `scans.ts`.
- The `sn.ts` tests pin the platform reply shapes as the code reads them today (`ui/meta` columns, Table API cells with `sysparm_display_value=all`, Stats API groups). They prove the parsing, not that an instance still answers in those shapes. A platform upgrade that changes a shape shows up on the instance first.
- `answer()` in `sn.test.ts` and the stubs in `api.test.ts` are close cousins. If a third file needs the same stub, move it to a shared test helper then, not before.
- A reviewer should check that each moved function is byte-identical apart from `export`, and that `station.tsx`'s `scan` closure still queues before it clears the PID.
- Adding a DOM test stack (jsdom and a testing library) for the components themselves was left out. It is a separate decision with its own cost; plan 004 notes the same.
