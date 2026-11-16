# Plan 043: Count on the Billing integrity tab the units on a pending line and the ended lines still billed

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 805d5da..HEAD -- src/server/domain/billing.ts src/server/domain/billing.test.ts src/client/workspace/dashboard.ts src/client/workspace/catalog.ts src/client/workspace/catalog.test.ts src/fluent/generated/keys.ts docs/spec/p3-billing.md docs/verify-on-instance.md`
> This plan lands after earlier plans, so the command prints changes. These
> are expected and are not a mismatch:
>
> - `src/server/domain/billing.ts` and its test file: plan 024 exports the
>   interface `IntervalPlace`. Plan 025 adds `endedLineProblem` and two tests
>   (required, see "Depends on"). Plan 026 may add a line near `PULL_PAGE`.
>   Plan 042 changes `intervalEnd` and one test.
> - `docs/spec/p3-billing.md`: plans 024, 025, 026, 035, 041 and 042.
> - `docs/verify-on-instance.md`: many plans add sections.
> - `src/fluent/generated/keys.ts`: every plan that adds a Fluent record.
>
> `src/client/workspace/dashboard.ts`, `catalog.ts` and `catalog.test.ts` are
> edited by no earlier plan. If one is listed, compare it with the excerpts
> in "Current state". Only a mismatch in an excerpt this plan quotes is a STOP
> condition. This plan anchors its edits on text, not on line numbers.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/025-ended-line-needs-end-date.md (its `endedLineProblem`, which a new test compares with, and its spec bullet). Lands after plans/024-interval-follows-line-change.md, which makes the first gap below more likely and edits the same spec section.
- **Category**: bug
- **Planned at**: commit `805d5da`, 2026-11-12

## Why this matters

The workspace dashboard has a *Billing integrity* tab, where finance and asset managers see what is
in service and not billed. Two cases are missing from it.

A fleet asset in service whose Subscription line is still *Pending* is never billed, because
generation leaves pending lines out. Go-live never produces this: it starts a pending line as it
attaches a unit. An asset manager may set a unit's line by hand, and after plan 024 such a unit
even gets a Service interval on the pending line, which Margin costs. No tile counts it: the tile
*In service without a subscription line* counts only a unit with no line at all.

A Subscription line set *Ended* with no End date is billed every month, because billing goes by a
line's dates. Plan 025 refuses new ones. Lines saved that way before its rule, or past it (an
import that skips business rules), keep billing until finance gives each its last day. Plan 025
documents only a filter to type into a list. The workspace shows these lines nowhere: its
*Subscription lines* list leaves ended lines out.

After this plan, the tab has a tile for each case, and each tile opens the list of what it counts.

## Current state

### The tab today

```ts
// src/client/workspace/dashboard.ts:115-154
    {
        id: 'billing',
        title: 'Billing integrity',
        audience: 'staff',
        widgets: [
            {
                id: 'unbilled_in_service',
                chart: 'score',
                title: 'In service without a subscription line',
                span: 3,
                source: { table: 'alm_hardware', filter: IN_SERVICE_UNBILLED },
            },
            {
                id: 'ended_line_in_service',
                chart: 'score',
                title: 'In service on an ended line',
                span: 3,
                source: { table: 'alm_hardware', filter: IN_SERVICE_ON_ENDED_LINE },
            },
            {
                id: 'pending_lines',
                chart: 'score',
                title: 'Subscription lines not yet started',
                span: 3,
                source: { table: 'x_daas_ham_subscription_line', filter: `status=${SUBSCRIPTION_LINE_STATUS.pending}` },
                audience: 'broadStaff',
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
                audience: 'broadStaff',
            },
        ],
    },
```

The first line of that file imports the two asset filters:

```ts
// src/client/workspace/dashboard.ts:1
import { IN_SERVICE_ON_ENDED_LINE, IN_SERVICE_UNBILLED } from '../../server/domain/billing'
```

The filters are constants of the domain layer, because a tile cannot call a function:

```ts
// src/server/domain/billing.ts:102-119 (plan 025 adds `endedLineProblem` directly above `NO_LINE`)
const NO_LINE = 'x_daas_ham_subscription_lineISEMPTY'

/**
 * Encoded query on alm_hardware for the Billing integrity dashboard: fleet assets in service on no Subscription line,
 * which nothing bills. `fleetStagesQuery(['in_service'], NO_LINE)` written out for the tile to import.
 */
export const IN_SERVICE_UNBILLED = `install_status=${STAGE_FIELDS.in_service.installStatus}^substatusISEMPTY^${NO_LINE}^${FLEET_CONDITION}`

const ON_ENDED_LINE = `x_daas_ham_subscription_line.status=${SUBSCRIPTION_LINE_STATUS.ended}^ORx_daas_ham_subscription_line.end_date<javascript:gs.beginningOfToday()`

/**
 * Encoded query on alm_hardware for the Billing integrity dashboard: fleet assets (ADR 0016) billed from a Service
 * interval whose Subscription line has ended (set ended, or past its end date; the end date itself is billed). Their
 * days after the line's end are not billed (withinLine), so they are flagged; nothing moves them to another line.
 * It is `fleetStagesQuery(IN_USE_STAGES, ON_ENDED_LINE)` written out, one clause per stage in use: the dashboard tile
 * imports it, and Fluent metadata reads no function call (domain/billing.test.ts checks which Assets it flags).
 */
export const IN_SERVICE_ON_ENDED_LINE = `install_status=${STAGE_FIELDS.in_service.installStatus}^substatusISEMPTY^${ON_ENDED_LINE}^${FLEET_CONDITION}^NQinstall_status=${STAGE_FIELDS.temporary_deployment.installStatus}^substatus=${STAGE_FIELDS.temporary_deployment.substatus}^${ON_ENDED_LINE}^${FLEET_CONDITION}`
```

The block that follows `IN_SERVICE_ON_ENDED_LINE` starts with these two lines, which this plan
uses as an anchor:

```ts
/**
 * The Assets that keep a site package open, as an encoded alm_hardware query: the fleet assets (ADR 0016) at its Site
```

The billed stages are `in_service` and `temporary_deployment` (`IN_USE_STAGES`,
`src/server/domain/lifecycle.ts:44`). `alm_hardware` also holds the Provider IT's equipment (ADR
0016), so every query on it holds `FLEET_CONDITION` in each `^NQ` clause. A condition after `^NQ`
binds to the last clause only.

### Why a unit on a pending line bills nothing

```ts
// src/server/platform/billing.ts:141-144
    return runTriggeredChunk(queued, {
        job,
        table: 'x_daas_ham_subscription_line',
        query: `status!=${SUBSCRIPTION_LINE_STATUS.pending}^${overlapsMonth(bounds)}`,
```

Go-live starts the line before it attaches the unit, or leaves the unit pending in service:

```ts
// src/server/platform/subscriptions.ts:42-52
    if (lines.find((l) => l.id === lineId)?.status === SUBSCRIPTION_LINE_STATUS.pending) {
        const unstarted = startLine(lineId, inServiceAt)
        if (unstarted) {
            const serial = str(asset, 'serial_number')
            log.warn(`${serial} stays pending in service, line not started: ${unstarted}`)
            return false
        }
    }
    // The Service interval opens when the Asset actually enters service (entry/billing.ts onAssetServiceChange).
    asset.setValue('x_daas_ham_subscription_line', lineId)
    return true
```

A hand edit is the way in:

```ts
// src/fluent/fleet/access.now.ts:174-182
Acl({
    $id: Now.ID['acl_alm_hardware_sub_line_write'],
    type: 'record',
    table: 'alm_hardware',
    field: 'x_daas_ham_subscription_line',
    operation: 'write',
    roles: [assetManager],
    description: "NaaS: an asset's subscription line is changed by hand only by an asset manager.",
})
```

A line's *Start date* is read-only in the dictionary (`src/fluent/agreements/tables.now.ts:102`), so
the usual fix for such a unit is to move it to a line that runs.

### Why an ended line with no End date still bills, and where it shows

Plan 025 adds the rule and this pure function to `src/server/domain/billing.ts`:

```ts
// src/server/domain/billing.ts, as plan 025 writes it
export function endedLineProblem(line: { status: string; endDate: string }): string | null {
    if (line.status !== SUBSCRIPTION_LINE_STATUS.ended || line.endDate) return null
    return 'An Ended subscription line needs an End date, the last day it is billed: enter it (today, if the line ends now)'
}
```

The one list of Subscription lines in the workspace leaves ended lines out:

```ts
// src/client/workspace/catalog.ts:342-348
        subscription_lines: {
            title: 'Subscription lines',
            table: 'x_daas_ham_subscription_line',
            query: `status!=${SUBSCRIPTION_LINE_STATUS.ended}`,
            columns: 'description,customer,agreement,line_type,site,device_class,monthly_rate,status,start_date',
            audience: 'broadStaff',
        },
```

### How a tile, a list and an audience fit together

A widget may name a `drill`, the list of the rows it counts. A widget is offered to its own
`audience`, else to its drill list's, else to its tab's:

```ts
// src/client/workspace/dashboard.ts:270-272
export function widgetAudience(tab: DashboardTab, widget: Widget): Audience {
    return widget.audience ?? (widget.drill && listById(widget.drill)?.audience) ?? tab.audience
}
```

Three existing tests hold new widgets and lists to the rules. They need no change, and they run on
what this plan adds:

- `src/client/workspace/catalog.test.ts`, `drills from a widget to the list of the rows it counts,
  wherever there is one`: a widget names a `drill` exactly when a list has its table and its filter.
- `src/client/workspace/catalog.test.ts`, `keeps $id to the app’s records for any search and sort`:
  one case per list on `alm_hardware` or `cmdb_model`. A new list on `alm_hardware` adds one case.
- `src/server/built-metadata.test.ts`, `offers each widget only to roles that read its table, so
  none shows a role a refusal` (it reads the built ACLs, so it needs a build).

The read ACL of `x_daas_ham_subscription_line` names `BROAD_STAFF`
(`src/fluent/agreements/access.now.ts:71-77`): every provider-staff role but the inventory tech. The
audience `'broadStaff'` is that list (`src/client/workspace/catalog.ts:28-34`).

The test this plan changes:

```ts
// src/client/workspace/catalog.test.ts:99-109
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

Where the two new lists go in `src/client/workspace/catalog.ts`. The key order of `CATALOG` is the
sidebar's order. The asset list goes at the end of the run of interval and asset lists under
*Billing*, after this entry:

```ts
// src/client/workspace/catalog.ts:407-413
        service_intervals: {
            title: 'Open service intervals',
            table: 'x_daas_ham_service_interval',
            query: 'end_dateISEMPTY^ORDERBYstart_date',
            columns: 'asset,subscription_line,customer,site,start_date,end_date',
            audience: 'money',
        },
```

The line list goes under *Commercial*, after `subscription_lines` (quoted above). The columns of an
asset list come from this constant:

```ts
// src/client/workspace/catalog.ts:50
const INSTALLED_ASSET_COLUMNS = 'asset_tag,serial_number,model,company,x_daas_ham_site,install_status,substatus,x_daas_ham_last_seen'
```

### What the domain tests look like

`src/server/domain/billing.test.ts` checks which records a query finds, with the tests' encoded-query
evaluator. It knows `^OR`, `^NQ`, `=`, `ISEMPTY` and dot-walked field names, and throws on a term it
does not know. The file already imports what the new tests need:

```ts
// src/server/domain/billing.test.ts:28-30
import { ALL_STAGES, IN_USE_STAGES, type Stage } from './lifecycle'
import { recordMatches as matches } from '../test-support/encoded-query'
import { assetIn, type SampleRecord } from '../test-support/stored-asset'
```

`assetIn(stage, fields)` gives a sample Asset in a stage. `matches(query, record)` says whether the
query finds the record. The existing `describe('IN_SERVICE_ON_ENDED_LINE', ...)` is the pattern, and
it is followed by `describe('decideGenerationReset', ...)`.

### Decisions already made (do not reopen them)

1. **A new tile for the pending line, not a wider *In service without a subscription line*.** The
   title of that tile would become false, the spec names it by its title in two places once plan
   024 landed, and the fix differs: a unit with no line needs one, a unit on a pending line is moved to a line that
   runs. The new filter covers both billed stages, as `IN_SERVICE_ON_ENDED_LINE` does.
2. **Each new tile has a list.** A count finance cannot open is half the work: ended lines are in
   no list today, and the *In service* list has no Subscription line column. The two older asset
   tiles keep having none. That gap is older than this plan.
3. **Both are offered to `broadStaff`.** The line tile reads `x_daas_ham_subscription_line`, which
   an inventory tech does not read. The asset tile reads `alm_hardware`, which a tech reads, but
   its filter reads the line's status through the reference, and what an instance answers a reader
   who cannot read the line was not verified. The tile is for finance and asset managers, so it is
   offered to the roles that read lines. It takes that audience from its list.
4. **The spans stay 3.** Six tiles then fill a row of four and a row of two on a wide screen. A
   three by three grid needs `span: 4` on all six, which changes four tiles this plan does not
   otherwise touch and can only be judged on a running page.
5. **The line filter is `status=ended^end_dateISEMPTY`**, the state `endedLineProblem` refuses. A
   test holds the two together.

### What the documents say

```md
<!-- docs/spec/p3-billing.md:33-35 at the planned-at commit (further down once plans 024 and 025 landed) -->
- The *Billing integrity* tab counts fleet assets only (ADR 0016): the Provider IT's equipment in use
  shares `alm_hardware` and is never billed. Its tile *In service without a subscription line*
  counts fleet assets in service with no Subscription line, which bill nothing.
```

Plan 025 inserts its bullet about the End date directly above that bullet.

```md
<!-- docs/verify-on-instance.md:403-405 -->
read. As a NOC-only or inventory-tech-only user, Operations,
Billing integrity and Lifecycle risk show counts and the Margin tab is not offered; an inventory
tech is not offered the subscription-line and reconciliation-exception tiles. As finance, the Margin tab
```

Plan 025 adds the section `### Ended subscription lines` to `docs/verify-on-instance.md`. Its last
paragraph has these two lines:

```md
*Status* *Ended* and an empty *End date* (`status=ended^end_dateISEMPTY`), and give each the last
day it should be billed. A Billing period still *Ready for review* that billed such a line past
```

### Conventions that apply (AGENTS.md, README.md "Development")

- Layers: `src/client/` imports server code from `server/domain` only, written without the `.ts`
  ending. `src/server/domain/` is pure.
- A stored choice value is named from `src/server/domain/vocabulary.ts` (`SUBSCRIPTION_LINE_STATUS`),
  never typed as a literal in server code. Test files use the literals.
- A test is a `*.test.ts` file beside its module. `npx vitest run src/server/domain` and
  `npx vitest run src/client` need no build. `npm test` needs `npm run build` first. `npm run check`
  does both.
- `npm run build` rewrites the tracked `src/fluent/generated/keys.ts`. The build names each emitted
  page file by its content, so a client change gives the changed files new names: the build adds an
  entry for each new name and marks each old one `deleted: true`. Commit the file with the change.
  Never edit it by hand.
- `npm run build` type-checks `src/client/**/*.test.ts` with the libs of `src/client/tsconfig.json`.
  The one test line this plan changes is a list of strings, which those libs accept.
- Use the words of `CONTEXT.md`: Asset, Subscription line, Service interval.
- Comments only for a non-obvious why.
- When documented behaviour changes, the spec line changes in the same commit.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Lint | `npm run lint` | exit 0 |
| This plan's tests | `npx vitest run src/server/domain/billing.test.ts src/client/workspace/catalog.test.ts` | all pass |
| Build | `npm run build` | exit 0; rewrites `dist/` and `src/fluent/generated/keys.ts` |
| Built-metadata checks | `npx vitest run src/server/built-metadata.test.ts` (after a build) | all pass |
| Every test | `npx vitest run` (after a build) | 0 failed |
| Full gate | `npm run check` | exit 0, all tests pass |

## Scope

**In scope** (the only files you should modify):

- `src/server/domain/billing.ts` (two exported constants and one private constant)
- `src/server/domain/billing.test.ts` (two imports, two `describe` blocks)
- `src/client/workspace/catalog.ts` (one import, two lists)
- `src/client/workspace/dashboard.ts` (one import, two widgets)
- `src/client/workspace/catalog.test.ts` (one line)
- `src/fluent/generated/keys.ts` (rewritten by `npm run build`; never edit it by hand)
- `docs/spec/p3-billing.md` (one bullet replaced)
- `docs/verify-on-instance.md` (two sentences)

**Out of scope** (do NOT touch, even though they look related):

- `IN_SERVICE_UNBILLED` and `IN_SERVICE_ON_ENDED_LINE`, and the two tiles that use them. They stay
  as they are, without a list (decision 2).
- The `span` of any widget, and `src/client/workspace/widget.tsx` (decision 4).
- `src/server/platform/billing.ts`. Generation keeps leaving pending lines out.
- `src/server/platform/service-intervals.ts`. Plan 024's move still opens an interval on a pending
  line. The tile counts the unit. Refusing the hand edit is a different decision.
- Any ACL and any `*.now.ts` file. No Fluent record is added. Do not widen a read ACL to offer a
  tile to more roles.
- `src/server/built-metadata.test.ts`. Its tests cover the new widgets and lists as they are.
- A repair of ended lines without an End date. Only finance knows each line's last day.
- `README.md`. It does not list the workspace's tiles or lists.

## Git workflow

- Branch: `advisor/043-billing-integrity-line-tiles`, from `main`.
- One commit. Subject in the repo's style, an imperative sentence under 72 characters, for example
  `Count units on a pending line and ended lines still billed`. The body says what was wrong and
  why (a unit in service on a pending line and an ended line with no End date were billed wrongly
  and no tile or list showed them).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Branch and confirm the baseline

```sh
git checkout main && git checkout -b advisor/043-billing-integrity-line-tiles
grep -c "export function endedLineProblem" src/server/domain/billing.ts
grep -c "cannot be saved \*Ended\* without an End date" docs/spec/p3-billing.md
npx vitest run src/server/domain/billing.test.ts
npx vitest run src/client/workspace/catalog.test.ts
npm run build && npx vitest run
git status --short
```

**Verify**: both `grep` commands print `1`. If either prints `0`, plan 025 has not landed: STOP.
Every test run reports 0 failed. Write down two numbers of passed tests: B for
`domain/billing.test.ts` (57 once plan 025 landed) and C for `catalog.test.ts` (22). Write down the
total of the full run: the last step calls it T (1843 in 113 files if plans 023, 024, 025, 041 and
042 landed and no other). `git status --short` prints nothing.

### Step 2: Write the failing tests

Edit `src/server/domain/billing.test.ts`.

In the import from `'./billing'` at the top of the file, add two names. Add
`ENDED_LINES_WITHOUT_END_DATE,` directly after `decideGenerationReset,`, and
`IN_SERVICE_ON_PENDING_LINE,` directly after `IN_SERVICE_ON_ENDED_LINE,`:

```ts
    decideGenerationReset,
    ENDED_LINES_WITHOUT_END_DATE,
    endedLineProblem,
    IN_SERVICE_ON_ENDED_LINE,
    IN_SERVICE_ON_PENDING_LINE,
    IN_SERVICE_UNBILLED,
```

Insert this block directly above the line `describe('decideGenerationReset', () => {`, followed by
one blank line:

```ts
describe('IN_SERVICE_ON_PENDING_LINE', () => {
    const flagged = (asset: SampleRecord) => matches(IN_SERVICE_ON_PENDING_LINE, asset)
    const LINE = 'x_daas_ham_subscription_line'
    const on = (status: string, fields: SampleRecord = {}) => assetIn('in_service', { x_daas_ham_fleet: 'true', [LINE]: 'sl1', [`${LINE}.status`]: status, ...fields })

    it('flags fleet assets in a billed stage on a line still pending, which generation leaves out', () => {
        expect(flagged(on('pending'))).toBe(true)
        expect(ALL_STAGES.filter((stage) => flagged({ ...on('pending'), ...assetIn(stage) }))).toEqual([...IN_USE_STAGES])
    })

    it("leaves out an asset on a line that runs or has ended, one on no line, and the Provider IT's (ADR 0016)", () => {
        expect(flagged(on('active'))).toBe(false)
        expect(flagged(on('ended'))).toBe(false)
        expect(flagged(on('', { [LINE]: '' }))).toBe(false)
        expect(flagged(on('pending', { x_daas_ham_fleet: 'false' }))).toBe(false)
        expect(flagged({ ...on('pending'), ...assetIn('temporary_deployment'), x_daas_ham_fleet: '' })).toBe(false)
    })
})

describe('ENDED_LINES_WITHOUT_END_DATE', () => {
    it('finds exactly the Subscription lines a save is refused for: set Ended, with no End date', () => {
        const found = (status: string, endDate: string) => matches(ENDED_LINES_WITHOUT_END_DATE, { status, end_date: endDate })
        expect(found('ended', '')).toBe(true)
        for (const status of ['pending', 'active', 'ended']) {
            for (const endDate of ['', '2026-11-12']) {
                expect(found(status, endDate), `${status} ${endDate}`).toBe(endedLineProblem({ status, endDate }) !== null)
            }
        }
    })
})
```

Edit `src/client/workspace/catalog.test.ts`. Replace the line

```ts
        const broadStaffOnly = ['pending_lines', 'lines_by_customer', 'open_exceptions', 'exception_types']
```

with:

```ts
        const broadStaffOnly = ['pending_line_in_service', 'ended_lines_no_end_date', 'pending_lines', 'lines_by_customer', 'open_exceptions', 'exception_types']
```

**Verify**: `npx vitest run src/server/domain/billing.test.ts src/client/workspace/catalog.test.ts`
→ `4 failed | B+C-1 passed`. The four failures are exactly:

- `IN_SERVICE_ON_PENDING_LINE > flags fleet assets in a billed stage on a line still pending, which generation leaves out`
- `IN_SERVICE_ON_PENDING_LINE > leaves out an asset on a line that runs or has ended, one on no line, and the Provider IT's (ADR 0016)`
- `ENDED_LINES_WITHOUT_END_DATE > finds exactly the Subscription lines a save is refused for: set Ended, with no End date`
- `the workspace dashboard > offers a role only the widgets on tables it reads, and no tab left without one`

The three domain tests fail because the constants do not exist yet: an undefined query finds every
record. `npm run typecheck` fails at this point for the same reason. That is expected until step 3.
If the set of failures differs, STOP.

### Step 3: Add the two filters to the domain

In `src/server/domain/billing.ts`, insert this block directly above the doc comment that starts
`The Assets that keep a site package open, as an encoded alm_hardware query` (its opening `/**` line
stays with it, below the new block), followed by one blank line:

```ts
const ON_PENDING_LINE = `x_daas_ham_subscription_line.status=${SUBSCRIPTION_LINE_STATUS.pending}`

/**
 * Encoded query on alm_hardware for the Billing integrity dashboard: fleet assets (ADR 0016) in a billed stage whose
 * Subscription line is still pending. Generation bills no pending line, so nothing bills them. Go-live starts a pending
 * line as it attaches a unit (platform/subscriptions), so only a line set on the Asset by hand leaves one here. It is
 * `fleetStagesQuery(IN_USE_STAGES, ON_PENDING_LINE)` written out, as IN_SERVICE_ON_ENDED_LINE is.
 */
export const IN_SERVICE_ON_PENDING_LINE = `install_status=${STAGE_FIELDS.in_service.installStatus}^substatusISEMPTY^${ON_PENDING_LINE}^${FLEET_CONDITION}^NQinstall_status=${STAGE_FIELDS.temporary_deployment.installStatus}^substatus=${STAGE_FIELDS.temporary_deployment.substatus}^${ON_PENDING_LINE}^${FLEET_CONDITION}`

/**
 * Encoded query on x_daas_ham_subscription_line for the Billing integrity dashboard: the lines endedLineProblem
 * refuses, saved before its rule or past it. Billing takes each as still open and bills it every month until it is
 * given its End date.
 */
export const ENDED_LINES_WITHOUT_END_DATE = `status=${SUBSCRIPTION_LINE_STATUS.ended}^end_dateISEMPTY`
```

The file then reads, in this order: `IN_SERVICE_ON_ENDED_LINE`, a blank line, the new block, a blank
line, and the `/**` of the site package comment. `STAGE_FIELDS`, `SUBSCRIPTION_LINE_STATUS` and
`FLEET_CONDITION` are imported in the file already.

**Verify**: `npx vitest run src/server/domain/billing.test.ts` → B+3 passed, 0 failed.

### Step 4: Add the two lists and the two tiles

Edit `src/client/workspace/catalog.ts`.

Directly above its first line, `import { splitOrder, type Ordering } from '../../server/domain/encoded-query'`,
add:

```ts
import { ENDED_LINES_WITHOUT_END_DATE, IN_SERVICE_ON_PENDING_LINE } from '../../server/domain/billing'
```

Directly after the `subscription_lines` entry (the seven lines quoted in "Current state", which end
with `        },`), add:

```ts
        lines_ended_no_end_date: {
            title: 'Ended lines without an end date',
            table: 'x_daas_ham_subscription_line',
            query: ENDED_LINES_WITHOUT_END_DATE,
            columns: 'description,customer,agreement,line_type,site,monthly_rate,status,start_date,end_date',
            audience: 'broadStaff',
        },
```

Directly after the `service_intervals` entry (the seven lines quoted in "Current state"), add:

```ts
        // Its filter reads the line's status, so it is offered to the roles that read Subscription lines.
        assets_on_pending_line: {
            title: 'In service on a line not yet started',
            table: 'alm_hardware',
            query: IN_SERVICE_ON_PENDING_LINE,
            columns: `${INSTALLED_ASSET_COLUMNS},x_daas_ham_subscription_line`,
            audience: 'broadStaff',
        },
```

Edit `src/client/workspace/dashboard.ts`.

Replace its first line with:

```ts
import { ENDED_LINES_WITHOUT_END_DATE, IN_SERVICE_ON_ENDED_LINE, IN_SERVICE_ON_PENDING_LINE, IN_SERVICE_UNBILLED } from '../../server/domain/billing'
```

In the tab `billing`, directly after the widget `unbilled_in_service` (it ends with the line
`                source: { table: 'alm_hardware', filter: IN_SERVICE_UNBILLED },` and then `            },`),
add:

```ts
            {
                id: 'pending_line_in_service',
                chart: 'score',
                title: 'In service on a line not yet started',
                span: 3,
                source: { table: 'alm_hardware', filter: IN_SERVICE_ON_PENDING_LINE },
                drill: 'assets_on_pending_line',
            },
```

Directly after the widget `ended_line_in_service` (it ends with the line
`                source: { table: 'alm_hardware', filter: IN_SERVICE_ON_ENDED_LINE },` and then `            },`),
add:

```ts
            {
                id: 'ended_lines_no_end_date',
                chart: 'score',
                title: 'Ended lines without an end date',
                span: 3,
                source: { table: 'x_daas_ham_subscription_line', filter: ENDED_LINES_WITHOUT_END_DATE },
                drill: 'lines_ended_no_end_date',
            },
```

Give neither new widget an `audience` of its own. Each takes `broadStaff` from its list. The tab's
widgets are then, in order: `unbilled_in_service`, `pending_line_in_service`,
`ended_line_in_service`, `ended_lines_no_end_date`, `pending_lines`, `lines_by_customer`.

**Verify**:

```sh
npx vitest run src/server/domain/billing.test.ts src/client/workspace/catalog.test.ts
npm run typecheck
npm run lint
```

The test run reports B+C+4 passed and 0 failed: three new domain tests, and one new case of
`keeps $id to the app’s records for any search and sort` for the list `assets_on_pending_line`. The
typecheck and the lint exit 0.

### Step 5: Build, and check what the build changed

```sh
npm run build
git diff --numstat -- src/fluent/generated/keys.ts
git diff -- src/fluent/generated/keys.ts | grep "^+" | grep "table:" | sort | uniq -c
npx vitest run src/server/built-metadata.test.ts
```

**Verify**: the build exits 0. The `--numstat` line shows added lines and `0` removed lines for
`src/fluent/generated/keys.ts` (`80	0` when this plan was written; the first number depends on how
many page files changed their names). The third command prints one line, and it names
`table: 'sys_ux_lib_asset'`: every new entry is a page file. The built-metadata tests all pass (75
at the planned-at commit, more if a later plan added some), among them `offers each widget only to
roles that read its table, so none shows a role a refusal`.

### Step 6: Change the documents

In `docs/spec/p3-billing.md`, replace the bullet that starts
`- The *Billing integrity* tab counts fleet assets only (ADR 0016)` (three lines, quoted in "Current
state") with:

```md
- The asset tiles of the *Billing integrity* tab count fleet assets only (ADR 0016): the Provider
  IT's equipment in use shares `alm_hardware` and is never billed. Its tile *In service without a
  subscription line* counts fleet assets in service with no Subscription line, which bill nothing.
  *In service on a line not yet started* counts fleet assets in service or on a temporary
  deployment whose Subscription line is still *Pending*. Generation bills no pending line, so they
  bill nothing either. Go-live starts a pending line as it attaches a unit, so only a line set on
  the Asset by hand leaves one there: move the unit to a line that runs. *Ended lines without an
  end date* counts Subscription lines set *Ended* with no End date, which are billed every month
  until each is given its last day. The rule above refuses new ones, and the tile finds those
  saved before it or past it. Each of these two tiles opens the list of what it counts (*In
  service on a line not yet started* under Billing, *Ended lines without an end date* under
  Commercial), and both are offered to the roles that read Subscription lines.
```

In `docs/verify-on-instance.md`, in the section `### Ended subscription lines`, replace these two
lines:

```md
*Status* *Ended* and an empty *End date* (`status=ended^end_dateISEMPTY`), and give each the last
day it should be billed. A Billing period still *Ready for review* that billed such a line past
```

with:

```md
*Status* *Ended* and an empty *End date* (`status=ended^end_dateISEMPTY`), and give each the last
day it should be billed. The workspace counts them on the *Billing integrity* tab, tile *Ended
lines without an end date*, and lists them under *Commercial*. A Billing period still *Ready for review* that billed such a line past
```

In the same file, in the section `### NaaS Asset Workspace`, replace the line

```md
tech is not offered the subscription-line and reconciliation-exception tiles. As finance, the Margin tab
```

with these two lines:

```md
tech is not offered the subscription-line and reconciliation-exception tiles, nor *In service on a
line not yet started*, whose filter reads the line. As finance, the Margin tab
```

**Verify**:

- `grep -c "The asset tiles of the \*Billing integrity\* tab count fleet assets only" docs/spec/p3-billing.md` → `1`
- `grep -c "The \*Billing integrity\* tab counts fleet assets only" docs/spec/p3-billing.md` → `0`
- `grep -c "lines without an end date\*, and lists them under \*Commercial\*" docs/verify-on-instance.md` → `1`
- `grep -c "line not yet started\*, whose filter reads the line" docs/verify-on-instance.md` → `1`

### Step 7: Run the full gate and commit

```sh
npm run check
git status --short
```

**Verify**: `npm run check` exits 0 and the test run reports T+4 passed, in the same number of
files as in step 1. `git status --short` lists exactly the eight in-scope files.

Commit the eight files in one commit, with the subject from "Git workflow" and a body that says what
was wrong and why.

## Test plan

- `src/server/domain/billing.test.ts`, 3 new tests in two `describe` blocks, modelled on
  `describe('IN_SERVICE_ON_ENDED_LINE', ...)` directly above them:
  - the pending-line filter finds a fleet asset on a pending line in the two billed stages and in
    no other stage;
  - it leaves out a unit on an active or an ended line, a unit on no line, and equipment outside
    the fleet, in both `^NQ` clauses;
  - the ended-line filter finds exactly the lines `endedLineProblem` refuses, over every status
    with and without an End date.
- `src/client/workspace/catalog.test.ts`, 1 test changed: an inventory tech is offered neither new
  tile, and the NOC is offered both. Three unchanged tests run on the new widgets and lists: the
  drill test (each new tile names the list with its table and filter), `keeps $id to the app’s
  records for any search and sort` (one new case, the asset list keeps the fleet condition under
  any search and sort) and `has unique list ids, each found by id`.
- `src/server/built-metadata.test.ts`, unchanged: each new tile is offered only to roles on a
  granting read ACL of its table.
- Verification: `npx vitest run src/server/domain/billing.test.ts src/client/workspace/catalog.test.ts`
  → B+C+4 passed.

What the tests cannot show: the tests' evaluator stands in for the platform's query engine. That an
instance counts the same records, that the two lists show their columns, and how the tab looks
with six tiles can only be seen on a running page. The dev server (`npm run dev`) proxies an
instance, so it needs one too.

Local and instance checks: every done criterion below is local and is enough to hand the work back.
These need an instance. Report each as "not run" unless you ran it:

- As finance, `x_daas_ham_workspace.do`, tab *Billing integrity*, shows six tiles. *In service on a
  line not yet started* and *Ended lines without an end date* each have an arrow that opens a list
  with the same number of rows as the tile's count.
- With a fleet asset in service whose Subscription line is set by hand to a *Pending* line, the
  first of those tiles counts it and its list shows it with its line.
- As an inventory-tech-only user, the tab shows two tiles, as before this plan, and no tile shows a
  failure.

## Done criteria

ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm run lint` exits 0
- [ ] `npx vitest run src/server/domain/billing.test.ts src/client/workspace/catalog.test.ts` reports 0 failed and B+C+4 passed
- [ ] `npm run check` exits 0 and reports T+4 passed
- [ ] `grep -c "export const IN_SERVICE_ON_PENDING_LINE\|export const ENDED_LINES_WITHOUT_END_DATE" src/server/domain/billing.ts` prints `2`
- [ ] `grep -c "drill: 'assets_on_pending_line'\|drill: 'lines_ended_no_end_date'" src/client/workspace/dashboard.ts` prints `2`
- [ ] `grep -c "span: 4," src/client/workspace/dashboard.ts` prints `3` (the three Margin tiles, as before)
- [ ] `git diff --numstat main..HEAD -- src/fluent/generated/keys.ts` shows `0` removed lines
- [ ] `git diff --stat main..HEAD -- 'src/fluent/**/*.now.ts' src/server/platform src/server/built-metadata.test.ts src/client/workspace/widget.tsx README.md` prints nothing
- [ ] The four `grep -c` checks of step 6 print `1`, `0`, `1` and `1`
- [ ] `git status --short` is empty and only the eight in-scope files differ from `main`
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The tab `billing` in `dashboard.ts`, the two catalog entries, or the constants in
  `src/server/domain/billing.ts` do not match the excerpts in "Current state".
- Either `grep` of step 1 prints `0`. Plan 025 has not landed, and this plan's test calls its
  `endedLineProblem` and its spec bullet is what "the rule above" refers to.
- Step 2 gives a different set of failing tests than the four listed.
- A domain test fails with a message that starts with `encoded query:`. The evaluator met a term it
  does not know. Report the message. Do not change `src/server/test-support/encoded-query.ts`.
- The test `drills from a widget to the list of the rows it counts, wherever there is one` fails
  after step 4. A tile and its list then differ in table or filter. Both must use the same
  constant.
- The test `keeps $id to the app’s records for any search and sort` fails for
  `assets_on_pending_line`. The list would then show equipment outside the fleet under some search.
  Report the failing query. Do not weaken the test.
- `npx vitest run src/server/built-metadata.test.ts` fails after step 5. Report the test name and
  message. Do not change an ACL and do not widen an audience.
- The `keys.ts` diff of step 5 shows a removed line, or an added entry of a table other than
  `sys_ux_lib_asset`. A Fluent record was then added, renamed or deleted by mistake. Report the
  diff.
- You are tempted to widen `IN_SERVICE_UNBILLED`, to change a `span`, or to give a new tile the
  audience `'staff'`. Those were considered and rejected (see "Decisions already made").
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- A unit on a pending line leaves the new tile when its line starts. A later go-live of another
  unit on that line starts it, and the first unit's interval is then billed from the line's Start
  date. Until then the unit is costed in Margin with no revenue.
- Plan 024's move still opens a Service interval on a pending line. Refusing a hand edit that puts
  a unit in service on a pending line would close the gap at its source. That is a rule on
  `alm_hardware`, another scope's table, where a refusal needs `abortAction` in the rule's own
  condition (README.md "Development"). It needs its own plan.
- `IN_SERVICE_UNBILLED` counts the stage *in service* only. A unit on a temporary deployment with
  no line is billed nothing and no tile counts it. This was seen while writing this plan and is not
  changed here.
- The two older asset tiles, *In service without a subscription line* and *In service on an ended
  line*, still have no list. Adding one is a catalog entry with the tile's table and filter and a
  `drill` on the tile. The drill test then holds them together.
- Not verified: what an instance answers an inventory tech for *In service on an ended line*, whose
  filter also reads the line's status through the reference. The first instance check of plan 007
  (an inventory-tech-only user sees no tile fail) covers it. If it shows a failure or a wrong
  count, give that tile the audience `'broadStaff'` too.
- If the second row of the tab looks thin on a wide screen, `span: 4` on the six tiles gives a
  three by three grid. That is a layout choice to make on a running page.
- A reviewer should check three things: that each new tile and its list use the same constant,
  that neither new widget has an `audience` of its own, and that `keys.ts` gained only
  `sys_ux_lib_asset` entries and `deleted: true` marks.
