# Plan 017: Page the customer equipment grids, share one fault dialog, and say when the list is cut

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 1864b17..HEAD -- src/client/customer src/server/platform/customer-page.ts src/server/platform/customer-page.test.ts src/server/entry/customer.ts src/server/domain/rest-contracts.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding. On a
> mismatch, treat it as a STOP condition. Plans 005 and 010 may have changed
> `src/server/entry/customer.ts` on other lines; that alone is not a mismatch.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-lint-tracked-sources.md
- **Category**: perf
- **Planned at**: commit `1864b17`, 2026-11-12

## Why this matters

The customer self-service page (`/customer.html`) shows a Customer's equipment, one grid per Site. The server sends up to 5000 devices and each grid renders every row. Every row also mounts its own "Report fault" dialog, form, mutation and mutation counter. Grouping the devices by Site copies the Site's array once per device. For a large Customer the Equipment tab is slow to open and to react. This is from reading the code, not a measurement. When a Customer has more than 5000 devices the tab says "Equipment (5000)" and nothing tells the user the list is cut.

After this plan each Site's grid shows 50 rows per page with a search box, the page has one fault dialog, grouping is linear, and a cut list is labelled as cut.

## Current state

Files:

- `src/client/customer/equipment.tsx` (198 lines). The Equipment tab: grouping, per-Site grid, "Return selected", "Decommission site", "Report fault".
- `src/client/customer/routes.tsx` (47 lines). The page shell; the tab label with the device count.
- `src/client/customer/api.ts`. `overviewQuery` (GET `/customer/overview`).
- `src/client/components/data-grid.tsx` (295 lines). The shared grid. It already supports paging and searching rows in memory. Not changed by this plan.
- `src/server/platform/customer-page.ts`. `customerEquipment()` reads the devices with a limit of 5000.
- `src/server/platform/customer-page.test.ts`. Its tests, against the in-memory Glide (`src/server/test-support/fake-glide.ts`).
- `src/server/entry/customer.ts`. `customerOverview` builds the reply.
- `src/server/domain/rest-contracts.ts`. `CustomerOverview`, the reply's type, shared by server and client.

`src/client/customer/equipment.tsx:30-47` (the columns; the last one mounts a dialog per row):

```tsx
const COLUMNS: readonly GridColumn<CustomerAsset>[] = [
    {
        id: 'model',
        ...
    },
    { id: 'serial', header: 'Serial / tag', value: serialAndTag, hideBelow: 'sm' },
    { id: 'stage', header: 'Status', value: (asset) => stageText(asset.stage), cell: (asset) => <StageBadge asset={asset} />, hideBelow: 'sm' },
    { id: 'refreshDue', header: 'Refresh due', value: (asset) => asset.refreshDue, hideBelow: 'md' },
    { id: 'fault', header: '', value: () => '', sortable: false, align: 'end', cell: (asset) => <ReportFault asset={asset} /> },
]
```

`src/client/customer/equipment.tsx:57-71`:

```tsx
export function Equipment() {
    const { data: overview } = useSuspenseQuery(overviewQuery)
    const sites = new Map<string, CustomerAsset[]>()
    for (const asset of overview.assets) sites.set(asset.siteId, [...(sites.get(asset.siteId) ?? []), asset])
    if (sites.size === 0) {
        return (
            <Empty>
                <EmptyHeader>
                    <EmptyTitle>No equipment</EmptyTitle>
                </EmptyHeader>
            </Empty>
        )
    }
    return [...sites].map(([siteId, assets]) => <Site key={siteId} siteId={siteId} assets={assets} admin={overview.isCustomerAdmin} />)
}
```

`src/client/customer/equipment.tsx:82-98` (no `pageSize`, no `search`):

```tsx
                <DataGrid
                    caption={`Equipment at ${site || 'no site'}`}
                    columns={COLUMNS}
                    data={assets}
                    rowId={(asset) => asset.id}
                    selectable={manages ? returnable : undefined}
                    actions={
                        manages
                            ? (chosen, clear) => (
                                  <>
                                      <ReturnSelected siteId={siteId} chosen={chosen} clear={clear} />
                                      <DecommissionSite siteId={siteId} site={site} assets={assets} clear={clear} />
                                  </>
                              )
                            : undefined
                    }
                />
```

`src/client/customer/equipment.tsx:156-171` (one of these per row):

```tsx
function ReportFault({ asset }: { asset: CustomerAsset }) {
    const busy = useBusy()
    const [open, setOpen] = useState(false)
    const report = useMutation({
        mutationFn: (description: string) => customerApi.reportFault(asset.id, description),
        meta: { done: (r: FaultReport) => `Fault reported as ${r.case}`, refresh: [overviewKey] },
        onSuccess: () => {
            form.reset()
            setOpen(false)
        },
    })
    const form = useAppForm({
        defaultValues: { description: '' },
        // The MutationCache toasts a failure; the dialog stays open with the text typed.
        onSubmit: ({ value }) => report.mutateAsync(value.description.trim()).catch(() => undefined),
    })
```

`src/client/customer/routes.tsx:13`:

```tsx
        { label: `Equipment (${overview.assets.length})`, to: '/equipment' },
```

`src/server/platform/customer-page.ts:32-52`:

```ts
export function customerEquipment(): CustomerAsset[] {
    const assets: CustomerAsset[] = []
    const asset = new GlideRecord('alm_hardware')
    asset.addEncodedQuery(visibleQuery('alm_hardware', fleetStagesQuery(DEPLOYED_STAGES)))
    asset.orderBy('x_daas_ham_site')
    asset.setLimit(5000)
    asset.query()
    while (asset.next()) {
        assets.push({
            ...
        })
    }
    return assets
}
```

`src/server/entry/customer.ts:45` (inside `customerOverview`): `assets: customerEquipment(),`

`src/server/domain/rest-contracts.ts:152-160`:

```ts
/** GET /customer/overview */
export interface CustomerOverview {
    customer: string
    isCustomerAdmin: boolean
    assets: CustomerAsset[]
    orders: CustomerOrder[]
    returns: CustomerReturn[]
    attestations: Attestation[]
}
```

`src/server/platform/customer-page.test.ts:19-22` (the one helper that calls `customerEquipment`):

```ts
function listedStages(fields: Record<string, string>): Stage[] {
    platform.tables.alm_hardware = ALL_STAGES.map((stage) => ({ sys_id: stage, ...assetIn(stage, fields) }))
    return customerEquipment().map((asset) => asset.stage as Stage)
}
```

Facts about `DataGrid` (`src/client/components/data-grid.tsx`) that this plan relies on. They were checked against the installed `@tanstack/table-core` 9.3.1:

- Props `pageSize?: number` ("Rows per page in memory; absent shows them all", line 70-71) and `search?: boolean` (line 69) already exist and work for rows in memory.
- `chosen` (line 174) comes from `table.getSelectedRowModel()`, which reads the core row model, not the current page. A row selected on page 1 stays selected and stays in `chosen` after the user goes to page 2 or types a search. So "Return selected (n)" keeps counting off-page selections. This is wanted.
- The table resets to page 1 whenever its `data` array is a new array (`createCoreRowModel` calls `autoResetPageIndex`). So the per-Site arrays must be memoized, or every re-render of `Equipment` throws the user back to page 1. Step 2 does this with `useMemo`. It matters more after step 3, which puts dialog state in `Equipment`.
- `columns` must have a stable identity ("a module constant or a memo", line 62).

Conventions that apply:

- Client tests run under vitest in the `node` environment with no DOM. A client test can import only `.ts` modules with relative imports: `vitest.config.ts` has no `@/` alias and `tsconfig.test.json` has no `jsx` option. So testable logic goes in a pure `.ts` file.
- In `src/server`, a relative import names the `.ts` file (`'./records.ts'`). Client files import without the extension.
- A test is a `*.test.ts` file beside its module.
- `src/server/built-metadata.test.ts` fails when a file under `src/server` is newer than `dist/app`. Run `npm run build` before the full test run.
- Comments only for a non-obvious why.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Lint | `npm run lint` | exit 0 (needs plan 001; before it, use `npx eslint src`) |
| One test file | `npx vitest run <path>` | all pass |
| Build | `npm run build` | exit 0 |
| Full gate | `npm run check` | exit 0, all tests pass |

`npm run build` rewrites the tracked file `src/fluent/generated/keys.ts`. If `git status` shows it changed, commit it.

## Scope

**In scope** (the only files you should modify):

- `src/client/customer/sites.ts` (create)
- `src/client/customer/sites.test.ts` (create)
- `src/client/customer/equipment.tsx`
- `src/client/customer/routes.tsx`
- `src/server/domain/rest-contracts.ts` (one field on `CustomerOverview`)
- `src/server/platform/customer-page.ts` (`customerEquipment` only)
- `src/server/platform/customer-page.test.ts`
- `src/server/entry/customer.ts` (`customerOverview` only)
- `src/fluent/generated/keys.ts` (only if the build rewrites it)

**Out of scope** (do NOT touch):

- `src/client/components/data-grid.tsx`. It already pages and searches. Plan 015 edits it for another reason.
- Server-side paging of the equipment list. The page needs every device of a Site in memory for "Decommission site" and selection. Raising or lowering the 5000 limit is also out of scope.
- `ReturnSelected` and `DecommissionSite`. They mount once per Site, not per row.
- `src/client/customer/attestations.tsx`, `orders.tsx`.
- Any other function in `customer-page.ts` or `entry/customer.ts`.

## Git workflow

- Branch: `advisor/017-customer-equipment-grid`
- Two commits: the client change (steps 1 to 3), then the truncation flag (steps 4 and 5). Subjects are imperative sentences under 72 characters in the repo's style, for example `Page each Site's equipment grid and share one fault dialog` and `Say when the customer page lists only the first 5000 devices`. The body says what was wrong and why.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Put the grouping in a pure module and test it

Create `src/client/customer/sites.ts`:

```ts
import type { CustomerAsset } from '../../server/domain/rest-contracts'

/** The equipment per Site, Sites and devices in the order the server sent them. '' is the devices with no Site. */
export function bySite(assets: readonly CustomerAsset[]): Map<string, CustomerAsset[]> {
    const sites = new Map<string, CustomerAsset[]>()
    for (const asset of assets) {
        const at = sites.get(asset.siteId)
        if (at) at.push(asset)
        else sites.set(asset.siteId, [asset])
    }
    return sites
}
```

Create `src/client/customer/sites.test.ts`. Model it on `src/client/warehouse/scan-queue.test.ts` (plain `describe`/`it`/`expect`, relative import). Build assets with a helper:

```ts
const asset = (id: string, siteId: string): CustomerAsset => ({ id, serial: id, customerTag: '', model: 'M', site: siteId, siteId, stage: 'in_service', refreshDue: '' })
```

Cases for `bySite`:

1. `groups the devices by Site, keeping the order they came in`: input ids `a@s1, b@s2, c@s1` gives keys `['s1', 's2']`, `s1` ids `['a', 'c']`, `s2` ids `['b']`.
2. `keeps the devices with no Site under ''`.
3. `gives an empty map for no devices`.
4. `does not change the list it was given`: the input array's length and order are the same after the call.

**Verify**: `npx vitest run src/client/customer/sites.test.ts` → 4 tests pass.

### Step 2: Page and search each Site's grid

Edit `src/client/customer/equipment.tsx`:

1. Add `useMemo` to the `react` import. Import `bySite` from `./sites`.
2. In `Equipment`, replace the two grouping lines (59-60) with:

    ```tsx
    // The same arrays until the overview is read again: a grid goes back to its first page when its rows are a new array.
    const sites = useMemo(() => bySite(overview.assets), [overview.assets])
    ```

3. Add a module constant near `COLUMNS`: `const PAGE_SIZE = 50`.
4. On the `DataGrid` in `Site`, add two props: `pageSize={PAGE_SIZE}` and `search`.

A grid with 50 rows or fewer shows no pager (`data-grid.tsx:177`), so small Sites look as before except for the search box.

**Verify**: `npm run typecheck` → exit 0. `grep -n "\.\.\.(sites.get" src/client/customer/equipment.tsx` → no matches.

### Step 3: One fault dialog for the page

Edit `src/client/customer/equipment.tsx`. The goal: a row renders only a button; the page mounts one dialog, opened for the row's device.

1. Turn `COLUMNS` into a function of the opener, so the fault cell can call it:

    ```tsx
    const columnsWith = (reportFault: (asset: CustomerAsset) => void): readonly GridColumn<CustomerAsset>[] => [
        // ... the first four columns exactly as they are today ...
        { id: 'fault', header: '', value: () => '', sortable: false, align: 'end', cell: (asset) => <FaultButton asset={asset} onReport={reportFault} /> },
    ]
    ```

2. Add the button. It is the only thing mounted per row:

    ```tsx
    function FaultButton({ asset, onReport }: { asset: CustomerAsset; onReport: (asset: CustomerAsset) => void }) {
        const busy = useBusy()
        return (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => onReport(asset)}>
                Report fault
            </Button>
        )
    }
    ```

3. In `Equipment`, hold which device the dialog is for. Keep the device while the dialog closes, so its text does not vanish during the closing animation:

    ```tsx
    const [fault, setFault] = useState<{ asset: CustomerAsset; open: boolean } | null>(null)
    const columns = useMemo(() => columnsWith((asset) => setFault({ asset, open: true })), [])
    ```

    Put both hooks before the `if (sites.size === 0)` return: hooks must not come after a conditional return.

4. Change the final return of `Equipment` to render the Sites and the one dialog:

    ```tsx
    return (
        <>
            {[...sites].map(([siteId, assets]) => (
                <Site key={siteId} siteId={siteId} assets={assets} admin={overview.isCustomerAdmin} columns={columns} />
            ))}
            {fault && <ReportFault key={fault.asset.id} asset={fault.asset} open={fault.open} onOpenChange={(open) => setFault({ asset: fault.asset, open })} />}
        </>
    )
    ```

    `key={fault.asset.id}` gives each device a fresh form, so text typed for one device never shows for another.

5. `Site` takes a `columns: readonly GridColumn<CustomerAsset>[]` prop and passes it to `DataGrid` in place of `COLUMNS`.
6. Change `ReportFault` to be controlled. Its props become `{ asset, open, onOpenChange }: { asset: CustomerAsset; open: boolean; onOpenChange: (open: boolean) => void }`. Remove its own `useState` for `open`. In `onSuccess`, replace `setOpen(false)` with `onOpenChange(false)`. Render `<Dialog open={open} onOpenChange={onOpenChange}>`. Delete the `<DialogTrigger ...>` line; the row's button opens the dialog now. Keep everything else (the mutation, the form, the comment about the toast, the `useBusy` for the submit button).
7. Remove `DialogTrigger` from the dialog import if nothing else uses it. `AlertDialogTrigger` is still used by `DecommissionSite`; leave it.

**Verify**: `npm run typecheck` → exit 0. `npm run lint` → exit 0. `grep -c "useMutation(" src/client/customer/equipment.tsx` → `3` (ReturnSelected, DecommissionSite, ReportFault), and `grep -n "<ReportFault" src/client/customer/equipment.tsx` → exactly one match, inside `Equipment`, not inside a column.

Commit steps 1 to 3 now.

### Step 4: The server says when the list is cut

1. `src/server/domain/rest-contracts.ts`: add one field to `CustomerOverview`, after `assets`:

    ```ts
    /** The Customer has more equipment than `assets` holds: the list is cut at the page's limit. */
    assetsTruncated: boolean
    ```

2. `src/server/platform/customer-page.ts`: read one row more than the limit, and report whether it was there.

    ```ts
    const EQUIPMENT_LIMIT = 5000

    /**
     * (keep the existing doc comment's text, and add:) At most EQUIPMENT_LIMIT of them; `truncated` says there are more.
     */
    export function customerEquipment(): { assets: CustomerAsset[]; truncated: boolean } {
        const assets: CustomerAsset[] = []
        const asset = new GlideRecord('alm_hardware')
        asset.addEncodedQuery(visibleQuery('alm_hardware', fleetStagesQuery(DEPLOYED_STAGES)))
        asset.orderBy('x_daas_ham_site')
        // One more than is listed, to tell a full list from a cut one.
        asset.setLimit(EQUIPMENT_LIMIT + 1)
        asset.query()
        let truncated = false
        while (asset.next()) {
            if (assets.length === EQUIPMENT_LIMIT) {
                truncated = true
                break
            }
            assets.push({ /* unchanged */ })
        }
        return { assets, truncated }
    }
    ```

3. `src/server/entry/customer.ts`, in `customerOverview`: call it once before `reply` and spread the two values in.

    ```ts
    const equipment = customerEquipment()
    reply(response, 200, {
        customer: customerName(session.customerId),
        isCustomerAdmin: actsAsCustomerAdmin(session.scope),
        assets: equipment.assets,
        assetsTruncated: equipment.truncated,
        orders: ordersUnderWay(),
        ...
    } satisfies CustomerOverview)
    ```

4. `src/server/platform/customer-page.test.ts`: in `listedStages` change `customerEquipment().map(` to `customerEquipment().assets.map(`. Add two tests inside `describe('customerEquipment', ...)`, using the file's existing `signIn`, `OWN` and `assetIn`:

    ```ts
    const fleetOf = (count: number) => Array.from({ length: count }, (_, i) => ({ sys_id: `asset${i}`, ...assetIn('in_service', OWN) }))

    it('lists every device and says the list is whole, up to its limit', () => {
        signIn(['x_daas_ham.customer_admin'])
        platform.tables.alm_hardware = fleetOf(5000)
        const equipment = customerEquipment()
        expect(equipment.assets).toHaveLength(5000)
        expect(equipment.truncated).toBe(false)
    })

    it('lists the first 5000 devices and says there are more', () => {
        signIn(['x_daas_ham.customer_admin'])
        platform.tables.alm_hardware = fleetOf(5001)
        const equipment = customerEquipment()
        expect(equipment.assets).toHaveLength(5000)
        expect(equipment.truncated).toBe(true)
    })
    ```

    Write the second test first and watch it fail against the old code shape if you can (before sub-step 2 it does not compile, which is the failing state). Both must pass after sub-step 2.

**Verify**: `npx vitest run src/server/platform/customer-page.test.ts` → all pass, 7 tests (5 existing, 2 new). `npm run typecheck` → exit 0. `grep -rn "customerEquipment()" src --include=*.ts` → only `entry/customer.ts` and the test file.

### Step 5: The page says when the list is cut

1. `src/client/customer/sites.ts`: add a pure label function.

    ```ts
    /** The device count as the page writes it: "5000+" when the server cut the list. */
    export function equipmentCount(count: number, truncated: boolean): string {
        return truncated ? `${count}+` : String(count)
    }
    ```

2. `src/client/customer/sites.test.ts`: add `equipmentCount(12, false)` is `'12'` and `equipmentCount(5000, true)` is `'5000+'`.
3. `src/client/customer/routes.tsx:13`: the label becomes `` `Equipment (${equipmentCount(overview.assets.length, overview.assetsTruncated)})` ``. Import `equipmentCount` from `./sites`.
4. `src/client/customer/equipment.tsx`, in `Equipment`'s final return, before the Sites, add a notice when the list is cut. Import `Alert` and `AlertTitle` from `@/components/ui/alert`.

    ```tsx
    {overview.assetsTruncated && (
        <Alert>
            <AlertTitle className="font-normal">
                Showing the first {overview.assets.length.toLocaleString()} devices. The Sites last in the list may be incomplete; ask your provider for the full list.
            </AlertTitle>
        </Alert>
    )}
    ```

    The server orders by Site, so the cut falls in the last Site listed. That is why the text names the last Sites.

**Verify**: `npx vitest run src/client/customer` → all pass (6 tests in `sites.test.ts`). `npm run check` → exit 0. Commit, including `src/fluent/generated/keys.ts` if the build changed it.

### Step 6 (needs an instance; optional): Look at it in a browser

`npm run dev` serves the pages from source and proxies the instance's APIs with the SDK's stored credential. It only works when the machine has a ServiceNow instance configured for `now-sdk`. If you have none, skip this step and say so in your report.

With an instance, as a customer admin (or an asset manager, who sees the page as a preview) whose Customer has a Site with more than 50 devices, open `/customer.html`:

- The Site's grid shows 50 rows, "1–50 of N" and the pager. Smaller Sites show no pager.
- Tick a row on page 1, go to page 2, tick another. "Return selected (2)" shows 2. Go back to page 1: the first row is still ticked.
- Press "Report fault" on a row on page 2. The dialog names that device. Close it. The grid is still on page 2. This is the check on the `useMemo` in step 2.
- Type in a Site's search box: the rows narrow and the grid is on page 1.

## Test plan

- `src/client/customer/sites.test.ts` (new): 4 cases for `bySite`, 2 for `equipmentCount`. Pattern: `src/client/warehouse/scan-queue.test.ts`.
- `src/server/platform/customer-page.test.ts`: 2 new cases for the limit and the flag; the 5 existing cases keep passing through the `.assets` change. Pattern: the file's own tests.
- Paging, selection across pages and the single dialog have no automated test: the repo has no DOM test stack, and this plan does not add one. Typecheck covers the shapes; step 6 covers the behaviour when an instance is available. The selection claim rests on `@tanstack/table-core` 9.3.1 (`table_getSelectedRowModel` reads `getCoreRowModel()`).
- Verification: `npm run check` → exit 0.

## Done criteria

ALL must hold. All are local; none needs an instance.

- [ ] `npm run check` exits 0
- [ ] `npx vitest run src/client/customer/sites.test.ts` passes 6 tests
- [ ] `npx vitest run src/server/platform/customer-page.test.ts` passes 7 tests
- [ ] `grep -n "pageSize={PAGE_SIZE}" src/client/customer/equipment.tsx` returns one match
- [ ] `grep -n "<ReportFault" src/client/customer/equipment.tsx` returns one match
- [ ] `grep -n "setLimit(5000)" src/server/platform/customer-page.ts` returns no matches
- [ ] `git diff --stat 1864b17..HEAD -- src/client/components/data-grid.tsx` shows no change made by this plan
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row updated
- [ ] Your report says whether step 6 was run or skipped

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" does not match the excerpts.
- A step's verification fails twice after a reasonable fix attempt.
- `customerEquipment` has callers other than `entry/customer.ts` and `customer-page.test.ts` (`grep -rn "customerEquipment" src`). Another caller needs a decision about the new return shape.
- The fake Glide throws on `setLimit` or on 5001 rows, or the two new server tests take more than a few seconds. Do not change `src/server/test-support/fake-glide.ts`.
- The installed `@tanstack/table-core` is not 9.3.x (`grep '"version"' node_modules/@tanstack/table-core/package.json`). The selection and page-reset facts above were checked on 9.3.1.
- The change seems to need an edit to `data-grid.tsx`, a DOM test library, or a `tsconfig`/`vitest.config.ts` change.
- In step 6, a selection is lost when the page changes, or the grid jumps to page 1 when the fault dialog opens or closes.

## Maintenance notes

- A search hides rows but does not unselect them. A row ticked and then hidden by a search still counts in "Return selected (n)". The count on the button is the user's signal. If that proves confusing, the fix belongs in `DataGrid` (`chosen`), for every page that uses it.
- The header checkbox selects every selectable row of the Site that the search shows, across all pages, not only the 50 on screen (`toggleAllRowsSelected`). The button's count shows it.
- When the overview is read again (after a return request or a fault report) the per-Site arrays are new and each grid goes back to page 1. That is the table's default and was left alone.
- "Decommission site" sends the Site's device ids from the client's list. With a cut list the last Site's ids are incomplete. The server decides the devices of a decommission itself (`platform/returns.ts`, `installedAssetIds`), so the request is still whole. A reviewer should confirm that is still true.
- If the page ever needs more than 5000 devices, the answer is a server-paged list per Site (the `ServerRows` mode of `DataGrid`), not a higher limit.
- Plan 010 caps the id arrays the customer routes accept and refers to this 5000 limit. If `EQUIPMENT_LIMIT` changes, check that cap.
