# Plan 040: Draft the missing P2.10 dashboard tiles: refresh, overdue returns and replacement SLA

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **This plan writes one document and nothing else.** The tile definitions go
> into the document as a code block, not into `dashboard.ts`. It edits no
> source file and contacts no instance. See "STOP conditions".
>
> **Drift check (run first)**: `git diff --stat 805d5da..HEAD -- plan.md README.md docs/research docs/verify-on-instance.md src/client/workspace/dashboard.ts src/client/workspace/catalog.ts src/client/workspace/catalog.test.ts src/client/workspace/widget.tsx src/client/lib/sn.ts src/server/built-metadata.test.ts src/fluent/break-fix/break-fix.now.ts src/fluent/shared/roles.now.ts src/server/domain/vocabulary.ts`
> Other plans of this batch may have changed some of these files. Step 1 tells
> you which facts must still hold. A step 1 check that fails is a STOP
> condition.

## Status

- **Priority**: P3
- **Effort**: S for this spike. The build it prepares is S for three tiles and M for the SLA tiles.
- **Risk**: LOW for this plan (one new document). LOW to MED for the build: the SLA tiles read a platform table whose ACLs the app does not own.
- **Depends on**: none. `plans/007-dashboard-widget-audience.md` is done and its tests bind the build.
- **Category**: direction
- **Planned at**: commit `805d5da`, 2026-11-12

## Why this matters

`plan.md` P2.10 promises a Lifecycle risk dashboard with the refresh pipeline, overdue returns and
break-fix SLA attainment. The workspace's *Lifecycle risk* tab has six tiles, and none of them
shows a refresh figure, an overdue return or an SLA result. So the Provider cannot see on the
dashboard how many Assets are due for refresh, where the refresh Orders are stuck, which returns
are late, or whether replacements meet the service level the Customer pays for.

Three of the missing tiles are plain data: each has a workspace list with the same rows already,
and the existing widget kinds draw them. The SLA tiles are not. The results sit in the platform's
`task_sla` table, which the app grants no read on, and two tests of the built metadata refuse a
widget on such a table. This spike writes `docs/research/p2-10-tiles.md`: the tile definitions as
they would stand in `dashboard.ts`, who is offered each, the instance checks that decide how the
SLA tiles read their data, and the decisions for the owner. It builds nothing.

## Current state

### What the plan promises

`plan.md:728-731`:

```md
### P2.10 Lifecycle risk dashboard
- EoX exposure and coverage gaps per customer and site.
- Refresh pipeline and overdue returns.
- Break-fix SLA attainment.
```

`plan.md:999`: `| Q72 | KPIs | Lifecycle risk, operations, billing integrity, margin/TCO. |`

### The dashboard is data

`README.md:402-403`:

```md
- `workspace/` holds the workspace's UI page and its ACL. Its lists and its dashboard are data in
  `src/client/workspace/` (`catalog.ts`, `dashboard.ts`), each one structure over every table.
```

`src/client/workspace/dashboard.ts:18-41`, the widget type (comment lines left out):

```ts
interface WidgetBase {
    id: string
    title: string
    source: Source
    span: 3 | 4 | 6 | 12
    /** The list of the rows this widget counts: same table, same filter. */
    drill?: ListId
    /** Who reads the widget's table, when not everyone the tab is offered to does and no `drill` list says so. */
    audience?: Audience
}

export type Widget = WidgetBase &
    (
        | { chart: 'score' }
        | { chart: 'bar' | 'barh' | 'donut'; by: string; top: number; others: boolean }
        | { chart: 'currencyBar'; sum: Money }
        | { chart: 'currencyMatrix'; by: string; sum: Money }
    )
```

A `score` is one count. A `bar`, `barh` or `donut` is a count per value of one field. The two
currency kinds sum a Money. No kind shows a share or a percentage.

`src/client/workspace/dashboard.ts:155-214`, the *Lifecycle risk* tab (`id: 'risk'`,
`audience: 'staff'`). Its six widgets, in order:

| id | chart | title | table |
|---|---|---|---|
| `past_support` | score | Installed past end of support | `alm_hardware` |
| `no_coverage` | score | Installed without OEM coverage | `alm_hardware` |
| `open_exceptions` | score | Open reconciliation exceptions | `x_daas_ham_recon_exception` |
| `open_returns` | score | Open returns | `x_daas_ham_return_order` |
| `phase` | bar by `x_daas_ham_lifecycle_phase` | Installed base by lifecycle phase | `alm_hardware` |
| `exception_types` | donut by `exception_type` | Open exceptions by type | `x_daas_ham_recon_exception` |

The shape of a counting tile, `src/client/workspace/dashboard.ts:91-101` (Operations tab):

```ts
            {
                id: 'orders_by_stage',
                chart: 'bar',
                by: 'stage',
                top: 10,
                others: false,
                title: 'Open orders by stage',
                span: 6,
                source: { table: 'x_daas_ham_order', filter: OPEN_ORDERS_QUERY },
                drill: 'orders_open',
            },
```

### The lists the missing tiles would drill to

`src/client/workspace/catalog.ts:150-156`, `:180-200` and `:275-288`. They exist today:

```ts
        assets_refresh_due: {
            title: `Refresh due within ${PROPERTY.refreshHorizonDays.default} days`,
            table: 'alm_hardware',
            query: `x_daas_ham_refresh_dueRELATIVELT@dayofweek@ahead@${PROPERTY.refreshHorizonDays.default}^${FLEET_INSTALLED}`,
            columns: `${INSTALLED_ASSET_COLUMNS},x_daas_ham_refresh_due,x_daas_ham_lifecycle_phase`,
            audience: 'staff',
        },
```

```ts
        refresh_open: {
            title: 'Open refresh orders',
            table: 'x_daas_ham_order',
            query: `order_type=${ORDER_TYPE.refresh}^${OPEN_ORDERS_QUERY}`,
            columns: 'number,customer,site,stage,sys_created_on',
            audience: 'staff',
        },
        returns_open: {
            title: 'Open returns',
            table: 'x_daas_ham_return_order',
            query: 'active=true',
            columns: 'number,trigger,customer,site,method,due_back,escalated',
            audience: 'staff',
        },
        returns_overdue: {
            title: 'Overdue returns',
            table: 'x_daas_ham_return_order',
            query: 'active=true^due_back<javascript:gs.beginningOfToday()',
            columns: 'number,trigger,customer,site,due_back,escalated',
            audience: 'staff',
        },
```

`risk_past_support` (`:275`) and `risk_no_coverage` (`:282`) list the rows of the first two tiles
of the tab, with the filters `INSTALLED_PAST_SUPPORT` and `INSTALLED_WITHOUT_COVERAGE`.

The order type and the stages are in `src/server/domain/vocabulary.ts`: `ORDER_TYPE.refresh`
(`:370`) and `ORDER_STAGE_CHOICES` (`:387-397`: draft, awaiting approval, sourcing, preparing,
delivering, installing, complete, rejected, cancelled). `PROPERTY.refreshHorizonDays.default` is
`90` (`src/server/domain/properties.ts:31`).

### The replacement SLAs

`src/fluent/break-fix/break-fix.now.ts:29-30` and `:128-140`. Two more of the same shape follow at
`:142` and `:156`, named `NaaS replacement - same day (8 hours)` and `NaaS replacement - 24x7x4`:

```ts
const REPLACEMENT_COMPLETE = `x_daas_ham_replacement_order.stage=${ORDER_STAGE.complete}`
const CASE_CLOSED_UNREPLACED = `active=false^x_daas_ham_replacement_order.stage!=${ORDER_STAGE.complete}`
```

```ts
Sla({
    $id: Now.ID['sla_replace_nbd'],
    name: 'NaaS replacement - next business day',
    table: 'sn_customerservice_case',
    target: 'resolution',
    duration: Duration({ days: 1 }),
    scheduleSource: 'no_schedule',
    conditions: {
        start: `x_daas_ham_failed_assetISNOTEMPTY^x_daas_ham_replacement_tier=${REPLACEMENT_TIER.nbd}`,
        stop: REPLACEMENT_COMPLETE,
        cancel: CASE_CLOSED_UNREPLACED,
    },
})
```

- `docs/spec/p2-aftersales.md:40`: "SLAs on the case: next business day 24 h, same day 8 h, 24x7x4
  4 h (wall clock). They stop when the replacement Order completes (in service)."
- `docs/verify-on-instance.md:821`: "Its *NaaS replacement* Task SLA stops (stage *Completed*, not
  breached)." So the platform keeps each result as a Task SLA, in its table `task_sla`.
- No file under `src/` names `task_sla` (the generated keys included). The app declares no ACL on
  it and no cross-scope privilege for it.

### How a widget reads, and who may

`src/client/lib/sn.ts:5-9` and `:194-201`. A widget asks the platform's Stats API as the signed-in
user:

```ts
/*
 * The platform's REST APIs as the pages read them: column metadata (ui/meta), records (Table API) and counts and sums
 * (Stats API). The payloads are parsed here; no signature below carries one. The rows a user gets are what the ACLs
 * and the app's before-query rules (ADR 0005) let them read: nothing here filters for visibility.
 */
```

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

`src/client/workspace/catalog.ts:28-34`, the audiences. `BROAD_STAFF` is `PROVIDER_STAFF` without
the inventory tech (`src/server/domain/roles.ts:42,49`):

```ts
export const AUDIENCE = {
    /** Every provider-staff role, for the tables inventory techs also read, and the platform's cmdb_model. */
    staff: PROVIDER_STAFF,
    broadStaff: BROAD_STAFF,
    money: MONEY_READERS,
    admin: [ROLE.admin],
} as const satisfies Record<string, readonly AppRole[]>
```

`src/fluent/shared/roles.now.ts:10-52`: the app's staff roles contain the platform roles `asset`,
`inventory_user`, `procurement_user`, `model_manager`, `report_user` and `canvas_user`, and no
role of the service desk or of IT service management.

### The tests that bind a new tile

`src/client/workspace/catalog.test.ts:90-97` and `:106`:

```ts
    it('drills from a widget to the list of the rows it counts, wherever there is one', () => {
        for (const widget of WIDGETS) {
            const same = LISTS.find((list) => list.table === widget.source.table && list.filter === widget.source.filter)
            expect(widget.drill && listById(widget.drill)?.table, widget.id).toBe(widget.drill ? widget.source.table : undefined)
            expect(widget.drill && listById(widget.drill)?.filter, widget.id).toBe(widget.drill ? widget.source.filter : undefined)
            expect(Boolean(widget.drill), widget.id).toBe(Boolean(same))
        }
    })
```

```ts
        expect(widgetsFor(ROLE.finance)).toEqual(WIDGETS.map((widget) => widget.id))
```

`src/server/built-metadata.test.ts:1066-1089` (plan 007 added the last one):

```ts
    it('offers the Operations, Billing and Lifecycle tabs to every provider-staff role, so the NOC and the techs keep them', () => {
        expect(DASHBOARD.filter((tab) => tab.id !== 'margin').map((tab) => tab.audience)).toEqual(['staff', 'staff', 'staff'])
    })

    it("leaves each widget's data to its table's read ACL: the Margin tab's to the money readers", () => {
        const tables = [...new Set(dashboardSources().map((source) => source.table))]
        expect(tables).toEqual(expect.arrayContaining(['alm_hardware', 'x_daas_ham_margin', 'x_daas_ham_cost_fact']))
        for (const table of tables) expect(readsOf(table).length, table).toBeGreaterThan(0)
        ...
    })

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

`readsOf(table)` is the read ACLs the app itself builds on `table`. For `task_sla` it is empty, so
the last two tests fail for any widget on that table.

### Rules and words the document must keep

- `CONTEXT.md` terms: Asset, Fleet asset, Customer, Site, Order, **Refresh order** ("An Order of
  type refresh replacing Assets that reach their Refresh due date"), **Refresh due date**,
  **Return order**, **Replacement order** ("An Order of type device replace raised from a case
  about a failed Asset"), **OEM coverage**, **Lifecycle phase**. Avoid: device (for the record),
  RMA or break-fix ticket (for a Replacement order), EoX status, client, tenant.
- ADR 0005 (`docs/adr/0005-visibility-by-before-query-rules.md`): an audience decides what the
  page offers, never what a user reads. The ACLs and the before-query rules do that.
- ADR 0016 (`docs/adr/0016-fleet-assets.md`): the platform tables also hold the Provider IT's
  records, and the app leaves them alone. A widget on `alm_hardware` counts Fleet assets only.
- ADR 0003: a page imports server code from `server/domain` only.
- Prose: short declarative sentences, sentence-case headings, no em dashes.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Lint | `npm run lint` | exit 0 |
| What changed | `git status --short` | only `docs/research/p2-10-tiles.md` (and files under `plans/`) |

Do not run `npm run build`, `npm run check`, `npm run deploy` or any `now-sdk` command. The build
rewrites the tracked `src/fluent/generated/keys.ts`, and this plan changes no source.

## Scope

**In scope** (the only file you create):

- `docs/research/p2-10-tiles.md` (create)

**Out of scope** (do NOT touch, even though they look related):

- `src/client/workspace/dashboard.ts`, `catalog.ts`, `widget.tsx`, their tests, and everything
  else under `src/`. The tile definitions are a code block in the document.
- Any ACL, role or cross-scope privilege. Do not propose a read ACL on `task_sla` as the answer.
- `plan.md`, `README.md`, `docs/spec/**`, `docs/adr/**`, `docs/verify-on-instance.md`.
- Any instance. No deploy, no API call, no read. The instance checks are written for the owner.
- The open decisions. They are the owner's. Do not fill one in.

## Git workflow

- Branch: `advisor/040-p2-10-dashboard-tiles-spike`
- One commit. Subject in the repo's style (an imperative sentence under 72 characters), for
  example: `Draft the missing Lifecycle risk tiles with their open decisions`. Body: what the
  document is for and that nothing is built yet.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Confirm the facts the document relies on

Run each command. The expected result follows it.

```sh
grep -n -A3 "### P2.10 Lifecycle risk dashboard" plan.md
grep -c "task_sla\|order_type\|returns_overdue\|refresh" src/client/workspace/dashboard.ts
grep -n "^        | { chart: " src/client/workspace/dashboard.ts
grep -n "assets_refresh_due: {\|refresh_open: {\|returns_overdue: {\|risk_past_support: {\|risk_no_coverage: {" src/client/workspace/catalog.ts
grep -n "name: 'NaaS replacement" src/fluent/break-fix/break-fix.now.ts
grep -rn "task_sla" src --include=*.ts --include=*.tsx | wc -l
grep -n "refresh: 'refresh'" src/server/domain/vocabulary.ts
grep -n "refreshHorizonDays" src/server/domain/properties.ts
grep -n "expect(readsOf(table).length, table).toBeGreaterThan(0)" src/server/built-metadata.test.ts
grep -n "expect(offered.filter((role) => !readers.includes(role))" src/server/built-metadata.test.ts
grep -n "toEqual(\['staff', 'staff', 'staff'\])" src/server/built-metadata.test.ts
grep -n "expect(widgetsFor(ROLE.finance)).toEqual(WIDGETS.map" src/client/workspace/catalog.test.ts
grep -rhno "javascript:gs\.[a-zA-Z0-9]*" src/server/domain src/client --include=*.ts | sed 's/^[0-9]*://' | sort -u
find docs/research -name 'p2-10-tiles.md'
```

**Verify**, in order:

1. Four lines, `plan.md:728-731`: the heading, then the three bullets quoted under "Current state".
2. `0`: `dashboard.ts` has no SLA, refresh or overdue-return tile.
3. Four lines (37 to 40 at planning time): the four members of the `Widget` union, `score`,
   `bar | barh | donut`, `currencyBar` and `currencyMatrix`. No fifth kind.
4. Five lines (150, 180, 194, 275 and 282 at planning time).
5. Three lines, each starting `name: 'NaaS replacement - `.
6. `0`.
7. One line.
8. One line with `default: 90`.
9. One line.
10. One line.
11. One line.
12. One line.
13. Five lines: `javascript:gs.beginningOfLast12Months`, `javascript:gs.beginningOfLastMonth`,
    `javascript:gs.beginningOfToday`, `javascript:gs.endOfLastMonth`, `javascript:gs.minutesAgoStart`.
14. Nothing printed: the document must not exist yet.

Any difference is a STOP condition. Check 2 above 0, or check 6 above 0, means part of this is
built already: report which tile or which file.

### Step 2: Create the document

Create `docs/research/p2-10-tiles.md` with the content below. Copy it as given. Do not answer an
open decision, and do not turn a sketch of an SLA tile into a recommendation of your own.

````md
# P2.10 Lifecycle risk tiles: design draft

## Status

A draft for the owner to decide on. Nothing in it is built, and nothing in it has run on an
instance. The tile definitions below are written as they would stand in
`src/client/workspace/dashboard.ts`, and are not in that file. The first three were checked by
reading against the tests that bind a tile. They were not run. The SLA tiles are sketches: how
they read their data is open until the instance checks are made.

## What the plan asks for

`plan.md` P2.10, the Lifecycle risk dashboard:

- EoX exposure and coverage gaps per customer and site.
- Refresh pipeline and overdue returns.
- Break-fix SLA attainment.

Q72 names lifecycle risk among the KPIs. In the words of `CONTEXT.md`, "EoX" is the Lifecycle
phase of a Model, "coverage" is OEM coverage, and "break-fix" is a Replacement order raised from a
case about a failed Asset.

## What the Lifecycle risk tab shows today

The tab is `risk` in `src/client/workspace/dashboard.ts`, offered to every provider-staff role.

| P2.10 asks for | Tiles today | Missing |
|---|---|---|
| EoX exposure | *Installed past end of support* (count), *Installed base by lifecycle phase* (bar) | per Customer, per Site |
| Coverage gaps | *Installed without OEM coverage* (count) | per Customer, per Site |
| Refresh pipeline | none | everything |
| Overdue returns | *Open returns* (count, late or not) | the overdue ones |
| Break-fix SLA attainment | none | everything |

The tab also shows two tiles on Reconciliation exceptions, which P2.10 does not name.

The workspace already lists the rows of every missing tile but the SLA ones: *Refresh due within
90 days* (`assets_refresh_due`), *Open refresh orders* (`refresh_open`) and *Overdue returns*
(`returns_overdue`) in `src/client/workspace/catalog.ts`.

## How a tile is defined and checked

- The dashboard is data. A tile is one object in `DASHBOARD`: an id, a title, a `source` (a table
  and an encoded query), a width, and a chart kind.
- There are four kinds. `score` is one count. `bar`, `barh` and `donut` are a count per value of
  one field. `currencyBar` and `currencyMatrix` sum a Money per currency. No kind shows a share or
  a percentage.
- A tile reads the platform's Stats API as the signed-in user (`src/client/lib/sn.ts`). It shows
  what that user's ACLs and the before-query rules let them read (ADR 0005). Two users can see
  two counts on the same tile, and that is intended.
- A tile whose table and filter equal a workspace list's must drill to that list, and a tile may
  drill to no other (`catalog.test.ts`).
- A tile on `alm_hardware` holds the fleet condition in every clause of its filter (ADR 0016,
  `catalog.test.ts`).
- A tile is offered only to roles that read its table. `built-metadata.test.ts` holds each tile's
  audience to the read ACLs the app builds on its table (plan 007). A tile takes its audience from
  its own `audience`, else from its drill list, else from its tab.
- The three tabs other than Margin are offered to every provider-staff role, and a test pins
  that. A new tab would have to change that test.

## Tiles the existing kinds cover

These need no new widget kind, no new audience and no change to a test. Each reads a table that
every provider-staff role reads, and each drills to a list that exists.

```ts
// New imports in dashboard.ts: PROPERTY from '../../server/domain/properties',
// ORDER_TYPE from '../../server/domain/vocabulary' (beside SUBSCRIPTION_LINE_STATUS).

            {
                id: 'refresh_due',
                chart: 'score',
                title: `Refresh due within ${PROPERTY.refreshHorizonDays.default} days`,
                span: 3,
                source: {
                    table: 'alm_hardware',
                    filter: `x_daas_ham_refresh_dueRELATIVELT@dayofweek@ahead@${PROPERTY.refreshHorizonDays.default}^${FLEET_INSTALLED}`,
                },
                drill: 'assets_refresh_due',
            },
            {
                id: 'overdue_returns',
                chart: 'score',
                title: 'Overdue returns',
                span: 3,
                source: { table: 'x_daas_ham_return_order', filter: 'active=true^due_back<javascript:gs.beginningOfToday()' },
                drill: 'returns_overdue',
            },
            {
                id: 'refresh_by_stage',
                chart: 'bar',
                by: 'stage',
                top: 10,
                others: false,
                title: 'Open refresh orders by stage',
                span: 6,
                source: { table: 'x_daas_ham_order', filter: `order_type=${ORDER_TYPE.refresh}^${OPEN_ORDERS_QUERY}` },
                drill: 'refresh_open',
            },
```

What each shows:

- **Refresh due within 90 days**: the installed Fleet assets whose Refresh due date falls before
  90 days from now. That includes the ones already past it, and the ones a Refresh order already
  replaces. The number is the default of `x_daas_ham.refresh.horizon_days`, as the list's title is.
  An instance that changes the property still reads 90 on the tile and the list.
- **Open refresh orders by stage**: where the Refresh orders stand, from draft to installing. A
  draft is a wave waiting for review: some Asset in it has no successor Model, or Submit refused
  it (`docs/spec/p2-aftersales.md`, "Refresh").
- **Overdue returns**: the open Return orders whose *Due back by* date is before today.

Together the first two are the refresh pipeline: what is due, and what is on its way.

The two filters are written out a second time here. The list in `catalog.ts` holds the first
copy, and the drill test fails when they differ. The build should move each to one constant in
`src/server/domain/` that both import, as `INSTALLED_PAST_SUPPORT` is.

P2.10 also says "per customer and site" for EoX exposure and coverage gaps. The existing kinds
cover a per-Customer view with the filters of the two tiles the tab has (see decision 6):

```ts
            {
                id: 'past_support_by_customer',
                chart: 'barh',
                by: 'company',
                top: 15,
                others: true,
                title: 'Installed past end of support by customer',
                span: 6,
                source: { table: 'alm_hardware', filter: INSTALLED_PAST_SUPPORT },
                drill: 'risk_past_support',
            },
            {
                id: 'no_coverage_by_customer',
                chart: 'barh',
                by: 'company',
                top: 15,
                others: true,
                title: 'Installed without OEM coverage by customer',
                span: 6,
                source: { table: 'alm_hardware', filter: INSTALLED_WITHOUT_COVERAGE },
                drill: 'risk_no_coverage',
            },
```

`company` is the field that holds an Asset's Customer (ADR 0006). The tile *Spare pool by
customer* groups by it in the same way.

## Break-fix SLA attainment

### Where the results are

The app defines three SLAs on the case (`src/fluent/break-fix/break-fix.now.ts`): *NaaS
replacement - next business day*, *- same day (8 hours)* and *- 24x7x4*. Each starts when a case
names a failed Asset with that replacement tier, stops when the case's Replacement order is
complete, and is cancelled when the case closes with no replacement. They run on wall-clock time
with no schedule and no pause.

The platform keeps each result as a Task SLA, a row of its table `task_sla`. The app stores no
copy. The field names used below (`sla`, `stage`, `has_breached`, `active`, `end_time`) are the
platform's, written from memory of the platform, not read from an instance. Instance check 2
confirms them.

### What attainment means

Proposed, see decisions 3 and 4:

- A replacement **met** its service level when its Task SLA is completed and not breached.
- It **breached** when its Task SLA is completed and breached.
- A cancelled Task SLA (the case closed with no replacement) counts as neither.
- A Task SLA that is past its time and still running is not in last month's figure. It is counted
  on a tile of its own, because it is the one somebody can still act on.
- The window is the last calendar month, by the time the Task SLA ended. The Margin tab uses the
  same window, with date functions the app's queries already use.

### How the tiles could read it

The app's roles contain no service-desk or IT service management role
(`src/fluent/shared/roles.now.ts`), so a user who holds only an app role may well be refused
`task_sla`. That is an inference from the role definitions. Instance check 3 settles it.

| Option | What it is | Cost | Risk |
|---|---|---|---|
| A. As the user | A tile on `task_sla` through the Stats API, like every other tile | No server code. Three tests must learn that a tile can sit on a platform table whose read the app does not grant, with the roles found on the instance written down as data. | The app does not own those ACLs. An instance that differs shows a refusal, and no test can catch it. |
| B. The app grants read | A read ACL of the app on `task_sla` | Small | It would open every Task SLA of the instance, the Provider IT's included, to the app's roles (ADR 0016). Rejected. |
| C. A route of the app | A route of the app's REST API that counts the replacement Task SLAs on the server and returns numbers only, to the roles the app chooses | A route, a platform service, a new kind of widget source, their tests | The server reads `task_sla` from the app's scope (instance check 5). |
| D. A copy on the Order | The result stamped on the Replacement order when it completes, and tiles on `x_daas_ham_order` | Two columns, the stamp, a backfill. No new kind, no test changed, and a per-Customer view for free. | A second record of what the SLA engine already decides. The two can disagree. |

### Tile sketches

With option A the SLA tiles would read as follows. `slaReaders` stands for the audience the
instance check finds. With option C the same three figures come from the route instead.

```ts
const REPLACEMENT_SLAS = 'sla.nameSTARTSWITHNaaS replacement'
const ENDED_LAST_MONTH = 'end_timeONLast month@javascript:gs.beginningOfLastMonth()@javascript:gs.endOfLastMonth()'

            {
                id: 'replacement_sla_overrun',
                chart: 'score',
                title: 'Replacements past their SLA, not yet installed',
                span: 3,
                source: { table: 'task_sla', filter: `${REPLACEMENT_SLAS}^active=true^has_breached=true` },
                audience: 'slaReaders',
            },
            {
                id: 'replacement_sla_met',
                chart: 'score',
                title: 'Replacements within SLA last month',
                span: 3,
                source: { table: 'task_sla', filter: `${REPLACEMENT_SLAS}^stage=completed^has_breached=false^${ENDED_LAST_MONTH}` },
                audience: 'slaReaders',
            },
            {
                id: 'replacement_sla_breached',
                chart: 'bar',
                by: 'sla',
                top: 3,
                others: false,
                title: 'Replacements that breached their SLA last month, by service level',
                span: 6,
                source: { table: 'task_sla', filter: `${REPLACEMENT_SLAS}^stage=completed^has_breached=true^${ENDED_LAST_MONTH}` },
                audience: 'slaReaders',
            },
```

These three use the existing kinds and show counts. A percentage needs a fifth kind, for example
`{ chart: 'share'; by: 'has_breached'; hit: 'false' }`, drawn as "92% (46 of 50)". It would add a
member to the `Widget` union, a component in `widget.tsx`, and a pure function with a test in
`tally.ts`. See decision 5.

The SLA definitions are matched by the start of their name. The build should keep that prefix as
one constant in `src/server/domain/` that the three `Sla` records and the tiles share, and hold
the built names to it in `built-metadata.test.ts`.

## Instance checks

For the owner, on a dev instance with the app installed. Checks 1 to 5 only read. None was run for
this draft.

1. **A replacement Task SLA exists.** If none does, work through "Replacement SLA stop" in
   `docs/verify-on-instance.md` first. That one writes: it raises a case and completes a
   Replacement order.
2. **The fields and their values.** As an administrator, open in the browser:
   `/api/now/stats/task_sla?sysparm_count=true&sysparm_display_value=all&sysparm_query=sla.nameSTARTSWITHNaaS%20replacement`
   and note the count. Open it three more times with `&sysparm_group_by=stage`,
   `&sysparm_group_by=has_breached` and `&sysparm_group_by=sla` added. Note the stored value and the
   display value of each group. Expected: a stage `completed`, and `has_breached` as `true` or
   `false`. If the names or values differ, the sketches above change with them.
3. **Who reads it.** For each role in the table, impersonate a user who holds that role and no
   other, open the first URL of check 2, and fill in the row.

   | Role | HTTP status | Count equals the administrator's |
   |---|---|---|
   | `x_daas_ham.asset_manager` | | |
   | `x_daas_ham.noc` | | |
   | `x_daas_ham.account_manager` | | |
   | `x_daas_ham.finance` | | |
   | `x_daas_ham.field_tech` | | |
   | `x_daas_ham.inventory_tech` | | |

   Then, as an administrator, list the ACLs that decide it:
   `/sys_security_acl_list.do?sysparm_query=name=task_sla^ORnameSTARTSWITHtask_sla.^operation=read^active=true`
   and note the roles, condition and script of each.
4. **The date window as a non-administrator.** As one of the users of check 3 who got a count, add
   `%5Eend_timeONLast%20month@javascript:gs.beginningOfLastMonth()@javascript:gs.endOfLastMonth()`
   to the query. Expected: HTTP 200 and a count no larger than before, which shows the date
   function is evaluated for that user.
5. **The server's read, for option C.** In *Scripts - Background*, in the scope `x_daas_ham`, run:

   ```js
   var ga = new GlideAggregate('task_sla');
   ga.addEncodedQuery('sla.nameSTARTSWITHNaaS replacement');
   ga.addAggregate('COUNT');
   ga.query();
   gs.info(ga.next() ? ga.getAggregate('COUNT') : 'no row');
   ```

   Expected: the administrator's count of check 2, and no cross-scope refusal in the log.
6. **After a build of the three plain tiles.** As a user who holds only
   `x_daas_ham.inventory_tech`, the Lifecycle risk tab shows *Refresh due within 90 days*, *Overdue
   returns* and *Open refresh orders by stage* with figures and no failure, and the arrow of each
   opens its list.

## Open decisions for the owner

Each has a recommended answer. None is taken until the owner says so.

1. **How do the SLA tiles read Task SLAs?** Recommended: let instance check 3 decide. If every
   role the tiles are offered to gets the administrator's count, option A. If not, option C.
   Never option B. Option D only if a per-Customer SLA figure on the app's own tables is wanted
   for other reasons, since it keeps a second record of what the SLA engine decides.
2. **Who is offered the SLA tiles?** Recommended: provider staff without the inventory techs
   (`broadStaff`), the roles that see every Customer. With option A the instance check may narrow
   that, and then finance is no longer offered every tile, which one test asserts today.
3. **What counts as attained?** Recommended: completed and not breached, over the Task SLAs that
   ended in the window. Cancelled ones are left out. One still running past its time is shown on
   its own tile and joins a month's figure only when it ends.
4. **Which window?** Recommended: the last calendar month. It matches a Billing period and the
   Margin tab, and uses date functions the app's queries already use. The alternatives are a
   rolling 90 days, or 12 months by month as a trend.
5. **Counts or a percentage?** Recommended: counts first, with the existing kinds. A month has few
   replacements, and "9 within, 1 breached" says more than "90%". Add the `share` kind only if a
   percentage on the screen is wanted. P2.10 does say "attainment", which reads as a rate.
6. **EoX exposure and coverage gaps per Customer and per Site?** Recommended: add the two
   per-Customer bars sketched above, and leave per-Site to the drill lists, which have a Site
   column. A bar of the 15 largest Sites across all Customers tells little.
7. **Where do the new tiles go?** Recommended: on the Lifecycle risk tab, as P2.10 names one
   dashboard, in this order: the four counts of today, then *Refresh due*, *Overdue returns* and
   the SLA counts, then the bars. The tab grows from 6 tiles to as many as 13. A tab of its own
   for service levels is the alternative, and it changes the test that pins the three staff tabs.

## Follow-up build outline

Two builds, the first of which waits for nothing but the owner's yes.

**Build 1: the three plain tiles** (and the two per-Customer bars, if decision 6 says so).

1. Move the refresh-due filter and the overdue-return filter to constants in
   `src/server/domain/`, and use them in `catalog.ts`.
2. Add the tiles to the `risk` tab in `src/client/workspace/dashboard.ts`, in the order of
   decision 7.
3. `src/client/workspace/catalog.test.ts`: no test has to change. Naming the new tiles where the
   test lists what an inventory tech is offered would pin them, and is optional.
4. `docs/verify-on-instance.md`, "NaaS Asset Workspace": instance check 6. The paragraph already
   names *Overdue returns* among the queries with `javascript:gs.…` dates.
5. `npm run check`. `src/fluent/generated/keys.ts` is committed if the build rewrites it.

**Build 2: the SLA tiles**, after instance checks 1 to 5 and decisions 1 to 5.

1. The name prefix of the three SLAs as one constant in `src/server/domain/`, used by
   `src/fluent/break-fix/break-fix.now.ts`, with a test that holds the built names to it.
2. With option A: the tiles, the audience the check found, and the three tests taught about a
   platform table (`built-metadata.test.ts`, twice, and the finance line of `catalog.test.ts`).
3. With option C: a route in `src/fluent/shared/rest-api.now.ts`, its handler in
   `src/server/entry/`, the counting in `src/server/platform/`, a widget source that reads the
   route, and tests of each on the fake Glide.
4. The `share` kind, if decision 5 asks for it.
5. `docs/spec/p2-aftersales.md` (what attainment means), `docs/verify-on-instance.md` (who sees
   the SLA tiles), and `plan.md` P2.10 if the owner wants it to say what was built.
````

**Verify**: `test -f docs/research/p2-10-tiles.md && echo exists` → `exists`.

### Step 3: Check the document's shape

```sh
grep -c "^## " docs/research/p2-10-tiles.md
grep "^## " docs/research/p2-10-tiles.md
grep -c "^### " docs/research/p2-10-tiles.md
grep -c "^[0-9]*\. \*\*" docs/research/p2-10-tiles.md
grep -c "id: '" docs/research/p2-10-tiles.md
grep -n "TODO\|TBD" docs/research/p2-10-tiles.md
```

**Verify**:

- `9`.
- The nine headings, in this order: `## Status`, `## What the plan asks for`,
  `## What the Lifecycle risk tab shows today`, `## How a tile is defined and checked`,
  `## Tiles the existing kinds cover`, `## Break-fix SLA attainment`, `## Instance checks`,
  `## Open decisions for the owner`, `## Follow-up build outline`.
- `4` (the subsections of "Break-fix SLA attainment").
- `13` (six instance checks and seven open decisions).
- `8` (three plain tiles, two per-Customer bars, three SLA sketches).
- Nothing printed.

### Step 4: Run lint and commit

Run `npm run lint`, then `git status --short`.

**Verify**: lint exits 0. `git status --short` lists `docs/research/p2-10-tiles.md` as new and,
apart from files under `plans/`, nothing else. In particular nothing under `src/`.

Commit the one file.

### Step 5: Hand back and stop

Report to the operator:

1. The file created.
2. The seven open decisions, word for word, each with its recommended answer.
3. The six instance checks, and that none was run.
4. That build 1 of the outline (three plain tiles) needs only the owner's yes, and that build 2
   (the SLA tiles) waits for the instance checks.
5. That nothing is built: no source file changed and no instance was contacted.

Then stop. Do not add a tile to `dashboard.ts`, even the three plain ones.

## Test plan

This plan adds no code, so it adds no test. Its checks are those of steps 1, 3 and 4: the facts
hold, the document has its named sections, its eight tile definitions and its numbered decisions,
and lint passes with only the one file changed.

The three plain tiles were held against the binding tests by reading, not by running them: each
has the table and filter of the list it drills to, the `alm_hardware` tile holds the fleet
condition in its one clause, and each table has a read ACL for every provider-staff role, as the
tiles already on those tables show. The build runs the tests.

## Done criteria

ALL must hold:

- [ ] `docs/research/p2-10-tiles.md` exists with 9 `## ` sections, 4 `### ` subsections, 13 numbered bold items and 8 tile definitions
- [ ] `grep -n "TODO\|TBD" docs/research/p2-10-tiles.md` prints nothing
- [ ] `npm run lint` exits 0
- [ ] `git diff --stat 805d5da..HEAD -- src` shows no change made by this plan
- [ ] `git status --short` lists no file outside the in-scope list (files under `plans/` aside)
- [ ] No instance was contacted, and the report says so
- [ ] The report lists the seven open decisions and the six instance checks
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- A step 1 check differs from its expected result. In particular: `dashboard.ts` already names a
  refresh, overdue-return or SLA tile, some file under `src/` already names `task_sla`, the
  `Widget` union has a fifth kind, or one of the five lists is gone from `catalog.ts`.
- Any step would edit a file under `src/`, or `plan.md`, `README.md`, a spec, an ADR or
  `docs/verify-on-instance.md`. Those edits belong to the builds.
- Any step would contact an instance: `npm run deploy`, `now-sdk install`, a Stats or Table API
  call, a script in *Scripts - Background*, an impersonation. The instance checks in the document
  are for the owner.
- You are tempted to settle how the SLA tiles read `task_sla` by adding a read ACL on it, or by
  loosening the two tests of `built-metadata.test.ts`. Neither is yours to decide.
- You are asked, or tempted, to answer an open decision, or to add the three plain tiles "while
  you are here". The owner says yes first.
- `npm run lint` fails. This plan adds one Markdown file, so a lint failure comes from elsewhere:
  report it, do not fix it.

## Maintenance notes

- The `task_sla` field names and values in the document are from memory of the platform. Instance
  check 2 is what makes them facts. Until then every SLA sketch is provisional.
- Build 1 is independent of build 2 and of every decision but 6 and 7. It can land first.
- The drill rule cuts both ways. A tile with the table and filter of a list must drill to it, so
  a tile whose filter is a near copy of a list's fails the test. Keep each filter in one constant.
- The title *Refresh due within 90 days* is built from the property's default, like the list's.
  If the owner wants the tile to follow the property's value on the instance, that is a new piece
  of work: a page reads no system property today.
- If an Asset form or a per-Customer view of SLA results is wanted later, option D of the
  document (a copy on the Replacement order) is the one that gives it, at the price of a second
  record.
- Reviewer: check that the document rejects a read ACL on `task_sla`, that it calls the SLA field
  names unconfirmed, and that the tile definitions are in the document only.
