# Plan 007: Offer a dashboard widget only to the roles that read its table

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 1864b17..HEAD -- src/client/workspace/dashboard.ts src/client/workspace/catalog.test.ts src/server/built-metadata.test.ts docs/verify-on-instance.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding. On a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-lint-tracked-sources.md
- **Category**: bug
- **Planned at**: commit `1864b17`, 2026-11-12

## Why this matters

The workspace dashboard offers its *Billing integrity* and *Lifecycle risk* tabs to every provider-staff role, inventory techs included. Four widgets on those tabs count tables an inventory tech has no read ACL on: subscription lines and reconciliation exceptions. The data is safe, because the ACL refuses the read. But the tech is shown tiles that can never work for them: a refusal or an empty figure, and on two of them an arrow to a list their sidebar does not offer. Nothing checks that a widget's audience matches its table's read ACL, so the next widget added can repeat this. After this plan each widget is offered only to roles that read its table, and a test over the built ACLs holds that.

Whether the instance answers the refused Stats call with an error or a zero count was not verified. The fix does not depend on which.

## Current state

- `src/client/workspace/dashboard.ts` declares the tabs and widgets (`DASHBOARD`) and `tabsFor`, which picks the tabs a session is offered.
- `src/client/workspace/catalog.ts` declares the lists and the audiences. You read it, you do not change it.
- `src/client/workspace/catalog.test.ts` tests the catalog and the dashboard in node.
- `src/server/built-metadata.test.ts` reads the built ACLs from `dist/app` and already holds the workspace to them.
- `docs/verify-on-instance.md` describes what each role sees on the dashboard.

The audiences, `src/client/workspace/catalog.ts:28-36`:

```ts
export const AUDIENCE = {
    /** Every provider-staff role, for the tables inventory techs also read, and the platform's cmdb_model. */
    staff: PROVIDER_STAFF,
    broadStaff: BROAD_STAFF,
    money: MONEY_READERS,
    admin: [ROLE.admin],
} as const satisfies Record<string, readonly AppRole[]>

export type Audience = keyof typeof AUDIENCE
```

`BROAD_STAFF` is `PROVIDER_STAFF` without the inventory tech (`src/server/domain/roles.ts:42,49`).

The widget type, `src/client/workspace/dashboard.ts:10` and `:18-27`:

```ts
import { AUDIENCE, type Audience, type ListId } from './catalog'
```

```ts
interface WidgetBase {
    /** Unique among all tabs' widgets. */
    id: string
    title: string
    source: Source
    /** Columns of the tab's 12-column grid; widgets flow in definition order. */
    span: 3 | 4 | 6 | 12
    /** The list of the rows this widget counts: same table, same filter. */
    drill?: ListId
}
```

The four widgets, all on tabs with `audience: 'staff'`:

`src/client/workspace/dashboard.ts:132-148` (tab `billing`, no `drill`):

```ts
            {
                id: 'pending_lines',
                chart: 'score',
                title: 'Subscription lines not yet started',
                span: 3,
                source: { table: 'x_daas_ham_subscription_line', filter: `status=${SUBSCRIPTION_LINE_STATUS.pending}` },
            },
            {
                id: 'lines_by_customer',
                chart: 'donut',
                by: 'customer',
                top: 10,
                others: true,
                title: 'Active subscription lines by customer',
                span: 3,
                source: { table: 'x_daas_ham_subscription_line', filter: `status=${SUBSCRIPTION_LINE_STATUS.active}` },
            },
```

`src/client/workspace/dashboard.ts:172-179` and `:198-208` (tab `risk`, both drill to `exceptions_open`):

```ts
            {
                id: 'open_exceptions',
                chart: 'score',
                title: 'Open reconciliation exceptions',
                span: 3,
                source: { table: 'x_daas_ham_recon_exception', filter: OPEN_EXCEPTIONS_QUERY },
                drill: 'exceptions_open',
            },
```

```ts
            {
                id: 'exception_types',
                chart: 'donut',
                by: 'exception_type',
                top: 10,
                others: true,
                title: 'Open exceptions by type',
                span: 6,
                source: { table: 'x_daas_ham_recon_exception', filter: OPEN_EXCEPTIONS_QUERY },
                drill: 'exceptions_open',
            },
```

The drill list already has the right audience, `src/client/workspace/catalog.ts:261-267`:

```ts
        exceptions_open: {
            title: 'Open reconciliation exceptions',
            table: 'x_daas_ham_recon_exception',
            query: `${OPEN_EXCEPTIONS_QUERY}^ORDERBYDESCdetected_at`,
            columns: 'detected_at,exception_type,asset,ci,customer,detail',
            audience: 'broadStaff',
        },
```

The read ACLs, `src/fluent/agreements/access.now.ts:71-77` and `src/fluent/assurance/access.now.ts:71-77`:

```ts
Acl({
    $id: Now.ID['acl_subscription_line_read'],
    type: 'record',
    table: 'x_daas_ham_subscription_line',
    operation: 'read',
    roles: BROAD_STAFF,
})
```

```ts
Acl({
    $id: Now.ID['acl_recon_exception_read'],
    type: 'record',
    table: 'x_daas_ham_recon_exception',
    operation: 'read',
    roles: BROAD_STAFF,
})
```

`tabsFor`, `src/client/workspace/dashboard.ts:262-264`:

```ts
export function tabsFor(session: Session): readonly DashboardTab[] {
    return DASHBOARD.filter((tab) => session.holdsAny(AUDIENCE[tab.audience]))
}
```

Its only caller is `DashboardPage` in `src/client/workspace/routes.tsx:47`, which already handles an empty result.

The existing audience test, `src/client/workspace/catalog.test.ts:65-73`:

```ts
    it('offers a session only the lists and tabs of the audiences it holds', () => {
        const holding = (...roles: string[]) => ({ holdsAny: (group: readonly string[]) => group.some((role) => roles.includes(role)) })
        const tech = holding(ROLE.inventoryTech)
        expect(menuFor(tech).flatMap((category) => category.lists).every((list) => list.audience === 'staff')).toBe(true)
        expect(tabsFor(tech).map((tab) => tab.id)).not.toContain('margin')
        expect(tabsFor(holding(ROLE.finance)).map((tab) => tab.id)).toContain('margin')
        expect(menuFor(holding())).toEqual([])
        expect(menuFor(holding(ROLE.admin)).flatMap((category) => category.lists).map((list) => list.id)).toEqual(['admin_jobs'])
    })
```

The built-metadata test, `src/server/built-metadata.test.ts:59-60` and `:1033-1036`:

```ts
import { AUDIENCE, CATEGORIES } from '../client/workspace/catalog'
import { DASHBOARD } from '../client/workspace/dashboard'
```

```ts
describe('the NaaS Asset Workspace', () => {
    const PAGE = 'x_daas_ham_workspace'
    const readsOf = (table: string) => recordAcls().filter((acl) => acl.records === table && acl.operation === 'read' && !acl.deny)
    const workspaceModule = () => records('sys_app_module').find((module) => module.title === 'NaaS Asset Workspace')
```

`readsOf(table)` returns the built read ACLs that grant on `table`, each with `roles: string[]` (full role names such as `x_daas_ham.inventory_tech`). Every ACL lists its roles in full, so no role containment is involved.

A decision this plan must keep, `src/server/built-metadata.test.ts:1052-1054`:

```ts
    it('offers the Operations, Billing and Lifecycle tabs to every provider-staff role, so the NOC and the techs keep them', () => {
        expect(DASHBOARD.filter((tab) => tab.id !== 'margin').map((tab) => tab.audience)).toEqual(['staff', 'staff', 'staff'])
    })
```

The tabs stay `'staff'`. Only single widgets are narrowed. The last test of that `describe` starts at line 1065: `it('offers a list or a tab on a money table to the money readers only', () => {`.

The doc line, `docs/verify-on-instance.md:388-390`:

```
read. As a NOC-only or inventory-tech-only user, Operations,
Billing integrity and Lifecycle risk show counts and the Margin tab is not offered; an inventory
tech gets no subscription-line or reconciliation-exception figures. As finance, the Margin tab
```

Conventions that apply:

- An audience decides what the page offers, never what a user reads. The ACLs and before-query rules do that (ADR 0005, and the comment at `catalog.ts:24-27`). This plan changes no ACL.
- Client tests run under vitest in the `node` environment with no DOM test stack. Test `tabsFor`, not the rendered page.
- `src/server/built-metadata.test.ts` fails if `dist/app` is missing or older than any `src/fluent` or `src/server` source (test files excluded). This plan edits no such source. If the test reports a stale build, run `npm run build` first.
- A page imports server code from `server/domain` only (lint enforces it).
- Style: 4-space indent, single quotes, no semicolons. Comments only for a non-obvious why. Update the matching doc line in the same commit when documented behaviour changes.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Lint | `npm run lint` | exit 0 (needs plan 001; before it, use `npx eslint src`) |
| The two test files | `npx vitest run src/client/workspace/catalog.test.ts src/server/built-metadata.test.ts` | all pass |
| Build | `npm run build` | exit 0 |
| Full gate | `npm run check` | exit 0, all tests pass |

## Scope

**In scope** (the only files you should modify):

- `src/client/workspace/dashboard.ts`
- `src/client/workspace/catalog.test.ts`
- `src/server/built-metadata.test.ts`
- `docs/verify-on-instance.md` (the one sentence quoted above)
- `src/fluent/generated/keys.ts`, only if `npm run build` rewrites it

**Out of scope** (do NOT touch):

- Any `*.now.ts` file. The ACLs are right. Do not widen a read ACL to make a widget work.
- `src/client/workspace/catalog.ts`. The lists' audiences already match their tables' read ACLs.
- The tabs' `audience` values. A test pins them to `'staff'` on purpose.
- `src/client/workspace/widget.tsx` and `routes.tsx`. They render what `tabsFor` returns.

## Git workflow

- Branch: `advisor/007-dashboard-widget-audience`
- One commit. Subject in the repo's style, an imperative sentence under 72 characters, for example: `Offer a dashboard widget only to the roles that read its table`. The body says what was wrong and why (four widgets on staff tabs counted tables an inventory tech cannot read, and no test compared a widget's audience with its table's read ACL).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write the failing test of what a role is offered

In `src/client/workspace/catalog.test.ts`:

1. Move the `holding` helper to module level so both `describe` blocks can use it. Delete this line from inside the test at line 66:

   ```ts
           const holding = (...roles: string[]) => ({ holdsAny: (group: readonly string[]) => group.some((role) => roles.includes(role)) })
   ```

   Add it, unindented, on its own line directly above `const VIEW: ListView = ...` (line 17), followed by a blank line:

   ```ts
   const holding = (...roles: string[]) => ({ holdsAny: (group: readonly string[]) => group.some((role) => roles.includes(role)) })
   ```

2. In `describe('the workspace dashboard', ...)`, add this test directly above `it('never sums an amount without its currency', ...)`:

   ```ts
       it('offers a role only the widgets on tables it reads, and no tab left without one', () => {
           const widgetsFor = (...roles: string[]) => tabsFor(holding(...roles)).flatMap((tab) => tab.widgets.map((widget) => widget.id))
           const broadStaffOnly = ['pending_lines', 'lines_by_customer', 'open_exceptions', 'exception_types']
           const forTech = widgetsFor(ROLE.inventoryTech)
           for (const id of broadStaffOnly) expect(forTech, id).not.toContain(id)
           expect(forTech).toEqual(expect.arrayContaining(['open_orders', 'unbilled_in_service', 'ended_line_in_service', 'past_support', 'open_returns', 'phase']))
           expect(widgetsFor(ROLE.noc)).toEqual(expect.arrayContaining(broadStaffOnly))
           expect(widgetsFor(ROLE.finance)).toEqual(WIDGETS.map((widget) => widget.id))
           expect(tabsFor(holding(ROLE.admin))).toEqual([])
           for (const tab of tabsFor(holding(ROLE.inventoryTech))) expect(tab.widgets.length, tab.id).toBeGreaterThan(0)
       })

   ```

**Verify**: `npx vitest run src/client/workspace/catalog.test.ts` → exactly 1 test fails, the new one, with `pending_lines: expected [ ... ] to not include 'pending_lines'`. Every other test in the file passes. This is the expected red state.

### Step 2: Give a widget an audience and filter by it

Edit `src/client/workspace/dashboard.ts`:

1. Line 10 becomes:

   ```ts
   import { AUDIENCE, listById, type Audience, type ListId } from './catalog'
   ```

2. In `WidgetBase`, add a field after `drill?: ListId`:

   ```ts
       /** Who reads the widget's table, when not everyone the tab is offered to does and no `drill` list says so. */
       audience?: Audience
   ```

3. Add `audience: 'broadStaff',` as the last property of the two widgets that have no drill list, `pending_lines` and `lines_by_customer`, directly after each one's `source: { table: 'x_daas_ham_subscription_line', ... },` line. Do not add it to `open_exceptions` or `exception_types`. They take `broadStaff` from their drill list `exceptions_open`.

4. Replace the `tabsFor` function at the end of the file with:

   ```ts
   /**
    * Who a widget is offered to within its tab: its own audience, else its drill list's, else the tab's. A widget on a
    * table some of the tab's roles cannot read would show them a failure, not a count.
    */
   export function widgetAudience(tab: DashboardTab, widget: Widget): Audience {
       return widget.audience ?? (widget.drill && listById(widget.drill)?.audience) ?? tab.audience
   }

   /** The tabs `session` is offered, each with the widgets it is offered; a tab with none is left out. */
   export function tabsFor(session: Session): readonly DashboardTab[] {
       return DASHBOARD.filter((tab) => session.holdsAny(AUDIENCE[tab.audience]))
           .map((tab) => ({ ...tab, widgets: tab.widgets.filter((widget) => session.holdsAny(AUDIENCE[widgetAudience(tab, widget)])) }))
           .filter((tab) => tab.widgets.length > 0)
   }
   ```

A widget is shown to a session that holds the tab's audience and the widget's audience. Both must hold.

**Verify**: `npx vitest run src/client/workspace/catalog.test.ts` → all pass. `npm run typecheck` → exit 0.

### Step 3: Hold every widget to its table's built read ACL

Edit `src/server/built-metadata.test.ts`:

1. Line 60 becomes:

   ```ts
   import { DASHBOARD, widgetAudience } from '../client/workspace/dashboard'
   ```

2. In `describe('the NaaS Asset Workspace', ...)`, add this test directly above `it('offers a list or a tab on a money table to the money readers only', () => {`:

   ```ts
       it('offers each widget only to roles that read its table, so none shows a role a refusal', () => {
           const rolesOf: Readonly<Record<string, readonly string[]>> = AUDIENCE
           for (const tab of DASHBOARD) {
               for (const widget of tab.widgets) {
                   const readers = readsOf(widget.source.table).flatMap((acl) => acl.roles)
                   const offered = (rolesOf[tab.audience] ?? []).filter((role) => rolesOf[widgetAudience(tab, widget)]?.includes(role))
                   expect(offered.length, `${tab.id} ${widget.id}`).toBeGreaterThan(0)
                   expect(offered.filter((role) => !readers.includes(role)), `${tab.id} ${widget.id}`).toEqual([])
               }
           }
       })

   ```

**Verify**: `npx vitest run src/server/built-metadata.test.ts` → all pass. If it reports `dist/app is missing` or `dist/app is older than ...`, run `npm run build` and rerun.

Then prove the test can fail. Temporarily remove the line `audience: 'broadStaff',` from the `pending_lines` widget in `dashboard.ts`, and run the same command. Expected: the new test fails with `billing pending_lines: expected [ 'x_daas_ham.inventory_tech' ] to deeply equal []`. Put the line back and rerun. Expected: all pass.

### Step 4: Correct the doc sentence

In `docs/verify-on-instance.md`, in the "NaaS Asset Workspace" section, replace:

```
tech gets no subscription-line or reconciliation-exception figures. As finance, the Margin tab
```

with:

```
tech is not offered the subscription-line and reconciliation-exception tiles. As finance, the Margin tab
```

Keep the rest of the paragraph as it is. Rewrap nothing else.

**Verify**: `grep -n "is not offered the subscription-line" docs/verify-on-instance.md` → one match.

### Step 5: Run the full gate

Run `npm run check`. It builds the app. Then run `git status --short`.

If `src/fluent/generated/keys.ts` is listed as modified, include it in the commit. The build names emitted page files by content, so a client change can rewrite it.

**Verify**: `npm run check` → exit 0. `git status --short` lists only files from the in-scope list.

## Test plan

- `src/client/workspace/catalog.test.ts`, 1 new test (step 1): an inventory tech is offered none of the four widgets and keeps the others on the same tabs; the NOC keeps all four; finance is offered every widget; no offered tab is empty. Pattern: the existing test `offers a session only the lists and tabs of the audiences it holds` in the same file.
- `src/server/built-metadata.test.ts`, 1 new test (step 3): for every widget, each role it is offered to appears on a granting read ACL of its table, read from the built metadata. Pattern: the existing test `offers a list or a tab on a money table to the money readers only` in the same `describe`.
- Both tests were run against this plan's code when it was written: both pass with the fix and fail without it.
- Verification: `npx vitest run src/client/workspace/catalog.test.ts src/server/built-metadata.test.ts` → all pass, 2 of them new. `npm run check` → exit 0.

## Done criteria

Local. ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm run lint` exits 0
- [ ] `npx vitest run src/client/workspace/catalog.test.ts src/server/built-metadata.test.ts` passes, with the 2 new tests
- [ ] `npm run check` exits 0
- [ ] `grep -c "audience: 'broadStaff'," src/client/workspace/dashboard.ts` prints `2`
- [ ] `grep -c "audience: 'staff'," src/client/workspace/dashboard.ts` prints `3` (the tabs are unchanged)
- [ ] `git diff --stat 1864b17..HEAD -- 'src/fluent/**/*.now.ts' src/client/workspace/catalog.ts` is empty
- [ ] `git status --short` lists only in-scope files
- [ ] `plans/README.md` status row updated

Needs an instance (optional; report as "not run" if you have none; the local criteria suffice to hand the work back):

- [ ] Signed in as a user whose only app role is `x_daas_ham.inventory_tech`, `x_daas_ham_workspace.do` shows *Billing integrity* with two tiles and *Lifecycle risk* with four, and no tile shows a failure. As a NOC-only user both tabs show every tile.

## STOP conditions

Stop and report back (do not improvise) if:

- `tabsFor`, `WidgetBase` or the four widgets in `dashboard.ts` do not match the excerpts in "Current state".
- The step 3 test fails for a widget other than the temporary `pending_lines` experiment. That means another widget is offered to a role with no read ACL on its table, or an ACL changed. Report the failing `tab widget` label and the roles. Do not change an ACL and do not weaken the assertion.
- The existing test `offers the Operations, Billing and Lifecycle tabs to every provider-staff role` fails. You changed a tab's audience. Revert that.
- `readsOf(widget.source.table)` is empty for some widget (a widget on a platform table with no app read ACL). The test then needs a decision this plan does not make.
- The fix seems to need a change to a `*.now.ts` file, `catalog.ts`, `widget.tsx` or `routes.tsx`.

## Maintenance notes

- A new widget needs no `audience` when everyone on its tab reads its table, or when it drills to a list with the right audience. Otherwise set `audience`. The step 3 test fails with the widget's label when this is missed.
- The same check does not exist for the catalog's lists. The audit compared every list's audience with its table's read ACL by script and found no mismatch. A list test of the same shape would have to skip the platform tables (`cmdb_model`, `cmdb_model_lifecycle`), which have no app read ACL. That is deferred.
- The session's roles come from `GET /me`. The audiences list roles in full, so a role that only contains another (admin) is offered what `/me` reports for it. This plan does not change that.
- Reviewer: check that no tab's `audience` changed and that the two exception widgets carry no `audience` of their own.
