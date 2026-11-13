# P2.10 Lifecycle risk tiles: design draft

## Status

A draft for the owner to decide on. Nothing in it is built, and nothing in it has run on an
instance. The tile definitions below are written as they would stand in
`src/client/workspace/dashboard.ts`, and are not in that file. The first five (the three plain
tiles and the two per-Customer bars) were run against the tests that bind a tile, in a scratch copy
of the source with the five added to the `risk` tab: typecheck passed, and so did the tests of
`src/client/workspace` and `src/server/built-metadata.test.ts`, with no test changed. The SLA tiles
are sketches: how they read their data is open until the instance checks are made.

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
- A tile is offered only to roles that read its table and every app table its filter's fields
  point at. `built-metadata.test.ts` holds each tile's audience to the read ACLs the app builds on
  those tables (plan 007, widened when a reference field to an unreadable table refused the
  Billing tiles to inventory techs). A tile takes its audience from its own `audience`, else from
  its drill list, else from its tab.
- Operations and Lifecycle risk are offered to every provider-staff role, Billing integrity to the
  broad staff, and a test pins that. A new tab would have to change that test.

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
   the SLA counts, then the bars. The tab grows from 6 tiles to as many as 14. A tab of its own
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
