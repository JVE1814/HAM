# Plan 046: Count on the Billing integrity tab a unit on a temporary deployment with no Subscription line

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 805d5da..HEAD -- src/server/domain/billing.ts src/server/domain/billing.test.ts src/client/workspace/dashboard.ts src/client/workspace/catalog.ts src/client/workspace/catalog.test.ts src/fluent/generated/keys.ts docs/spec/p3-billing.md`
> This plan lands after earlier plans, so the command prints changes. These
> are expected and are not a mismatch:
>
> - `src/server/domain/billing.ts`: plan 024 exports the interface
>   `IntervalPlace`. Plan 025 adds `endedLineProblem` directly above
>   `NO_LINE`. Plan 026 may add a line near `PULL_PAGE`. Plan 042 changes
>   `intervalEnd`. Plan 043 adds `ON_PENDING_LINE`,
>   `IN_SERVICE_ON_PENDING_LINE` and `ENDED_LINES_WITHOUT_END_DATE` below
>   `IN_SERVICE_ON_ENDED_LINE` (required, see "Depends on").
> - `src/server/domain/billing.test.ts`: plan 025 adds
>   `describe('endedLineProblem', ...)` directly above
>   `describe('IN_SERVICE_UNBILLED', ...)`. Plan 042 changes one test of
>   `intervalEnd`. Plan 043 adds two imports and two `describe` blocks.
> - `src/client/workspace/dashboard.ts`, `catalog.ts` and `catalog.test.ts`:
>   plan 043 adds two tiles, two lists and changes one test line. This plan
>   reads these three files and does not edit them.
> - `docs/spec/p3-billing.md`: plans 024, 025, 026, 035, 041, 042 and 043.
> - `src/fluent/generated/keys.ts`: every plan that builds.
>
> Only a mismatch in an excerpt this plan quotes is a STOP condition. This
> plan anchors its edits on text, not on line numbers.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/043-billing-integrity-line-tiles.md (landing order: it edits the same constants, the same test file and the spec bullet this plan changes, and this plan quotes that bullet as 043 writes it). 043 itself needs 025 and lands after 024.
- **Category**: bug
- **Planned at**: commit `805d5da`, 2026-11-12

## Why this matters

The workspace dashboard has a *Billing integrity* tab, where finance and asset managers see what is
in use and not billed. Its tile *In service without a subscription line* counts fleet assets with
no Subscription line, which bill nothing. The tile's filter names one stage only, *in service*.
An Asset is billed in two stages: *in service* and *temporary deployment*, the stage a unit of a
temporary Order goes live in. Go-live attaches a unit to no line when no open Subscription line of
its Agreement matches it, and lets it go into service all the same. The code says the dashboard
counts such a unit. For a unit on a temporary deployment no tile does, so it delivers service,
bills nothing, and nobody is told.

After this plan the tile counts both billed stages, as its two neighbours on the tab do.

## Current state

### The filter and its neighbours

The filters are constants of the domain layer, because a tile cannot call a function. Once plan
025 landed, `endedLineProblem` stands directly above `NO_LINE`.

```ts
// src/server/domain/billing.ts:102-119 at the planned-at commit
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

`IN_SERVICE_ON_ENDED_LINE` is the shape to copy: one clause per billed stage, joined by `^NQ`, and
the line condition and `FLEET_CONDITION` in each clause. A condition after `^NQ` binds to the last
clause only. `alm_hardware` also holds the Provider IT's equipment (ADR 0016), so every clause of
a query on it holds `FLEET_CONDITION`. Plan 043's `IN_SERVICE_ON_PENDING_LINE` has the same two
clauses already. `IN_SERVICE_UNBILLED` is the one filter of the three with a single clause.

### Why a unit on a temporary deployment is billed, and how it ends up with no line

```ts
// src/server/domain/lifecycle.ts:43-44
/** In use at a Site: an Asset in one of these delivers its Subscription line and is billed (Q52), and monitoring should see it. */
export const IN_USE_STAGES: readonly Stage[] = ['in_service', 'temporary_deployment']
```

```ts
// src/server/domain/lifecycle.ts:302-304
export function isBillable(stage: Stage | null): boolean {
    return stage !== null && IN_USE_STAGES.includes(stage)
}
```

```ts
// src/server/domain/in-service.ts:25
    return { goesLive: true, at: facts.lastSeenAt, stage: facts.temporary ? 'temporary_deployment' : 'in_service' }
```

Go-live calls `attachToSubscription` for both stages (`src/server/platform/in-service.ts:44`), and
it lets a unit go live with no line:

```ts
// src/server/platform/subscriptions.ts:13-19 and :36-41
/**
 * Attach an Asset going into service to the Subscription line it delivers and start that line (the caller saves the
 * Asset). False (and a warning) when its pending line cannot be started: billing skips pending lines, so the Asset must
 * not go into service on one. An Asset no line matches is attached to none and may go into service unbilled (the
 * Billing integrity dashboard counts it).
 */
export function attachToSubscription(asset: GlideRecord, inServiceAt: number): boolean {
    ...
    const lineId = chooseSubscriptionLine(lines, {
        siteId: str(asset, 'x_daas_ham_site'),
        deviceClass: str(asset, 'model.x_daas_ham_device_class'),
        liveOn: toIsoDate(inServiceAt),
    })
    if (!lineId) return true
```

### The tile

```ts
// src/client/workspace/dashboard.ts:120-126 (inside the tab `billing`)
            {
                id: 'unbilled_in_service',
                chart: 'score',
                title: 'In service without a subscription line',
                span: 3,
                source: { table: 'alm_hardware', filter: IN_SERVICE_UNBILLED },
            },
```

The tile imports the constant, so it follows the constant with no edit of `dashboard.ts`. The tile
has no `drill`, and no list in `src/client/workspace/catalog.ts` uses this filter, so no list needs
the same change.

### The test that pins the gap

```ts
// src/server/domain/billing.test.ts:340-353 at the planned-at commit
describe('IN_SERVICE_UNBILLED', () => {
    const flagged = (asset: SampleRecord) => matches(IN_SERVICE_UNBILLED, asset)
    const unbilled = (stage: Stage, fields: SampleRecord = {}) => assetIn(stage, { x_daas_ham_fleet: 'true', x_daas_ham_subscription_line: '', ...fields })

    it('flags fleet assets in service on no Subscription line', () => {
        expect(ALL_STAGES.filter((stage) => flagged(unbilled(stage)))).toEqual(['in_service'])
    })

    it("leaves out an asset on a line, and the Provider IT's (ADR 0016)", () => {
        expect(flagged(unbilled('in_service', { x_daas_ham_subscription_line: 'sl1' }))).toBe(false)
        expect(flagged(unbilled('in_service', { x_daas_ham_fleet: 'false' }))).toBe(false)
        expect(flagged(unbilled('in_service', { x_daas_ham_fleet: '' }))).toBe(false)
    })
})
```

The file imports what the new tests need already:

```ts
// src/server/domain/billing.test.ts:28-30
import { ALL_STAGES, IN_USE_STAGES, type Stage } from './lifecycle'
import { recordMatches as matches } from '../test-support/encoded-query'
import { assetIn, type SampleRecord } from '../test-support/stored-asset'
```

`assetIn(stage, fields)` gives a sample Asset in a stage. `matches(query, record)` says whether the
query finds the record. The tests' evaluator (`src/server/test-support/encoded-query.ts`) knows
`^NQ`, `=` and `ISEMPTY`, and throws on a term it does not know. The tests of
`IN_SERVICE_ON_ENDED_LINE`, directly below this block, already run a two-clause query through it.

Two tests in other files check the widened filter with no change. Both ask that every `^NQ` clause
of a tile's filter on `alm_hardware` holds `FLEET_CONDITION`:

- `src/client/workspace/catalog.test.ts`, `counts the app’s records only on the shared tables`.
- `src/server/built-metadata.test.ts`, `counts fleet assets only on the dashboard` (needs a build).

### What the spec says

Once plan 043 landed, the bullet reads as below. This plan changes its second and third line.

```md
- The asset tiles of the *Billing integrity* tab count fleet assets only (ADR 0016): the Provider
  IT's equipment in use shares `alm_hardware` and is never billed. Its tile *In service without a
  subscription line* counts fleet assets in service with no Subscription line, which bill nothing.
  *In service on a line not yet started* counts fleet assets in service or on a temporary
```

### Decisions already made (do not reopen them)

1. **The constant keeps its name, `IN_SERVICE_UNBILLED`.** Its two neighbours,
   `IN_SERVICE_ON_ENDED_LINE` and `IN_SERVICE_ON_PENDING_LINE`, cover both billed stages under the
   same prefix. A rename would set this one apart from them and change two importers for no gain.
2. **The tile keeps its title and its id.** *In service on an ended line* and *In service on a line
   not yet started* count both stages under the same words. The spec names this tile by its title
   in a second place (the bullet plan 024 adds), and `catalog.test.ts` names its id.
3. **No list is added.** The tile had none before this plan. See "Maintenance notes".
4. **`dashboard.ts` is not edited.** It imports the constant.

### Conventions that apply (AGENTS.md, README.md "Development")

- `src/server/domain/` is pure: no Glide, nothing from `platform/` or `entry/`.
- README.md: "A query or condition the metadata needs is a constant written out beside the set,
  which a unit test holds to it." The set here is `IN_USE_STAGES`. The constant is a template
  literal over constants, with no function call, because the client bundle and Fluent metadata
  read constants only.
- A test is a `*.test.ts` file beside its module. `npx vitest run src/server/domain` and
  `npx vitest run src/client` need no build. `npm test` needs `npm run build` first: the
  built-metadata tests fail when a file under `src/server` is newer than `dist/app`.
  `npm run check` does both.
- `npm run build` rewrites the tracked `src/fluent/generated/keys.ts`. The build names each emitted
  page file by its content. The filter is part of the workspace page, so the changed files get new
  names: the build adds an entry for each new name and marks each old one `deleted: true`. Commit
  the file with the change. Never edit it by hand.
- Lint skips what git ignores. Keep any scratch file in a git-ignored folder.
- Use the words of `CONTEXT.md`: Asset, Fleet asset, Subscription line, In service, Temporary
  deployment.
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

- `src/server/domain/billing.ts` (one constant and its doc comment)
- `src/server/domain/billing.test.ts` (one `describe` block replaced)
- `src/fluent/generated/keys.ts` (rewritten by `npm run build`; never edit it by hand)
- `docs/spec/p3-billing.md` (two lines of one bullet replaced)

**Out of scope** (do NOT touch, even though they look related):

- `src/client/workspace/dashboard.ts`, `catalog.ts` and `catalog.test.ts`. The tile, its title, its
  id and its audience stay (decisions 2 to 4).
- `IN_SERVICE_ON_ENDED_LINE`, `IN_SERVICE_ON_PENDING_LINE` and `NO_LINE`. They are right as they are.
- `src/server/platform/subscriptions.ts` and `src/server/platform/in-service.ts`. Go-live keeps
  letting a unit with no matching line into service. Its doc comment becomes true with this plan.
- `src/server/test-support/encoded-query.ts`. It handles `^NQ` already.
- `src/server/built-metadata.test.ts`. Its tests cover the widened filter as they are.
- `docs/verify-on-instance.md`, `README.md`, `plan.md`. None describes what this tile counts.
- Any `*.now.ts` file. No Fluent record changes.

## Git workflow

- Branch: `advisor/046-unbilled-temporary-deployment`, from `main`.
- One commit. Subject in the repo's style, an imperative sentence under 72 characters, for example
  `Count a temporary deployment with no subscription line as unbilled`. The body says what was
  wrong and why (the tile's filter named the stage in service only, so a billable unit on a
  temporary deployment with no Subscription line billed nothing and no tile counted it).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Branch and confirm the baseline

```sh
git checkout main && git checkout -b advisor/046-unbilled-temporary-deployment
grep -c "export const IN_SERVICE_ON_PENDING_LINE" src/server/domain/billing.ts
grep -c "subscription line\* counts fleet assets in service with no Subscription line, which bill nothing\." docs/spec/p3-billing.md
grep -rn "IN_SERVICE_UNBILLED" src
npx vitest run src/server/domain/billing.test.ts
npx vitest run src/client/workspace/catalog.test.ts
npm run build && npx vitest run
git status --short
```

**Verify**: both `grep -c` commands print `1`. If either prints `0`, plan 043 has not landed: STOP.
The third `grep` prints exactly six lines: the definition in `src/server/domain/billing.ts`, three
lines in `src/server/domain/billing.test.ts` (the import, the `describe` name and one use), and
the import and one use in `src/client/workspace/dashboard.ts`. If it prints a line in any other
file, STOP. Every test run reports 0 failed. Write down three numbers of passed tests: B for
`domain/billing.test.ts` (60 once plans 025 and 043 landed), C for `catalog.test.ts` (23 once plan
043 landed), and T for the full run (`plans/README.md` gives 1847 in 113 files with plans 023 to
025 and 041 to 043 landed and no other). `git status --short` prints nothing: a build of an
unchanged tree rewrites `keys.ts` to the same content.

### Step 2: Write the failing test

Edit `src/server/domain/billing.test.ts`. Replace the whole block
`describe('IN_SERVICE_UNBILLED', () => { ... })` (the fourteen lines quoted in "Current state", from
the `describe` line to its closing `})`) with:

```ts
describe('IN_SERVICE_UNBILLED', () => {
    const flagged = (asset: SampleRecord) => matches(IN_SERVICE_UNBILLED, asset)
    const unbilled = (stage: Stage, fields: SampleRecord = {}) => assetIn(stage, { x_daas_ham_fleet: 'true', x_daas_ham_subscription_line: '', ...fields })

    it('flags fleet assets in a billed stage on no Subscription line, a temporary deployment as one in service', () => {
        expect(flagged(unbilled('temporary_deployment'))).toBe(true)
        expect(ALL_STAGES.filter((stage) => flagged(unbilled(stage)))).toEqual([...IN_USE_STAGES])
    })

    it("leaves out an asset on a line, and the Provider IT's (ADR 0016), in either billed stage", () => {
        for (const stage of IN_USE_STAGES) {
            expect(flagged(unbilled(stage, { x_daas_ham_subscription_line: 'sl1' })), stage).toBe(false)
            expect(flagged(unbilled(stage, { x_daas_ham_fleet: 'false' })), stage).toBe(false)
            expect(flagged(unbilled(stage, { x_daas_ham_fleet: '' })), stage).toBe(false)
        }
    })
})
```

Change no import: the file imports `ALL_STAGES`, `IN_USE_STAGES` and `Stage` already.

**Verify**: `npx vitest run src/server/domain/billing.test.ts` → `1 failed | B-1 passed`. The one
failure is `IN_SERVICE_UNBILLED > flags fleet assets in a billed stage on no Subscription line, a
temporary deployment as one in service`, with `expected false to be true`. The second test passes
already: the old filter finds no unit on a temporary deployment at all. If the set of failures
differs, STOP.

### Step 3: Widen the filter

In `src/server/domain/billing.ts`, replace these five lines:

```ts
/**
 * Encoded query on alm_hardware for the Billing integrity dashboard: fleet assets in service on no Subscription line,
 * which nothing bills. `fleetStagesQuery(['in_service'], NO_LINE)` written out for the tile to import.
 */
export const IN_SERVICE_UNBILLED = `install_status=${STAGE_FIELDS.in_service.installStatus}^substatusISEMPTY^${NO_LINE}^${FLEET_CONDITION}`
```

with these seven:

```ts
/**
 * Encoded query on alm_hardware for the Billing integrity dashboard: fleet assets (ADR 0016) in a billed stage on no
 * Subscription line, which nothing bills. Go-live attaches a unit to none when no open line of its Agreement matches
 * it (platform/subscriptions), on a temporary deployment as in service. It is
 * `fleetStagesQuery(IN_USE_STAGES, NO_LINE)` written out, one clause per stage in use, as IN_SERVICE_ON_ENDED_LINE is.
 */
export const IN_SERVICE_UNBILLED = `install_status=${STAGE_FIELDS.in_service.installStatus}^substatusISEMPTY^${NO_LINE}^${FLEET_CONDITION}^NQinstall_status=${STAGE_FIELDS.temporary_deployment.installStatus}^substatus=${STAGE_FIELDS.temporary_deployment.substatus}^${NO_LINE}^${FLEET_CONDITION}`
```

The line `const NO_LINE = 'x_daas_ham_subscription_lineISEMPTY'` above and the line
`const ON_ENDED_LINE = ...` below stay as they are. The file imports no new name.

**Verify**:

```sh
npx vitest run src/server/domain/billing.test.ts src/client/workspace/catalog.test.ts
npm run typecheck
npm run lint
```

The test run reports B+C passed and 0 failed. The typecheck and the lint exit 0.

### Step 4: Build, and check what the build changed

```sh
npm run build
git diff --numstat -- src/fluent/generated/keys.ts
git diff -- src/fluent/generated/keys.ts | grep "^+" | grep "table:" | sort | uniq -c
git status --short src/client
npx vitest run src/server/built-metadata.test.ts
```

**Verify**: the build exits 0. The `--numstat` line shows added lines and `0` removed lines for
`src/fluent/generated/keys.ts` (`16	0` when this plan was written; the first number depends on how
many page files changed their names). The third command prints one line, and it names
`table: 'sys_ux_lib_asset'` (with the count `2` when this plan was written): every new entry is a
page file. `git status --short src/client` prints
nothing. The built-metadata tests all pass (75 at the planned-at commit, more if a later plan added
some), among them `counts fleet assets only on the dashboard`.

### Step 5: Change the spec

In `docs/spec/p3-billing.md`, in the bullet that starts
`- The asset tiles of the *Billing integrity* tab count fleet assets only (ADR 0016)`, replace
these two lines:

```md
  IT's equipment in use shares `alm_hardware` and is never billed. Its tile *In service without a
  subscription line* counts fleet assets in service with no Subscription line, which bill nothing.
```

with these four:

```md
  IT's equipment in use shares `alm_hardware` and is never billed. Its tile *In service without a
  subscription line* counts fleet assets in service or on a temporary deployment with no
  Subscription line, which bill nothing. Go-live leaves a unit there when no open Subscription
  line of its Agreement matches it.
```

The bullet's first line and the line that starts `  *In service on a line not yet started* counts`
stay as they are.

**Verify**:

- `grep -c "counts fleet assets in service or on a temporary deployment with no" docs/spec/p3-billing.md` → `1`
- `grep -c "counts fleet assets in service with no Subscription line" docs/spec/p3-billing.md` → `0`
- `grep -c "line of its Agreement matches it\." docs/spec/p3-billing.md` → `1`

### Step 6: Run the full gate and commit

```sh
npm run check
git status --short
```

**Verify**: `npm run check` exits 0 and the test run reports T passed, in the same number of files
as in step 1. This plan changes two tests and adds none. `git status --short` lists exactly the
four in-scope files.

Commit the four files in one commit, with the subject from "Git workflow" and a body that says what
was wrong and why.

## Test plan

- `src/server/domain/billing.test.ts`, 2 tests changed in `describe('IN_SERVICE_UNBILLED', ...)`,
  modelled on `describe('IN_SERVICE_ON_ENDED_LINE', ...)` directly below it:
  - the filter finds a fleet asset with no Subscription line in the two billed stages and in no
    other stage. This is the regression test: it fails before step 3;
  - in each billed stage it leaves out a unit on a line and equipment outside the fleet. Run per
    stage, it fails if the second `^NQ` clause lacks the line condition or the fleet condition.
- Unchanged tests that run on the widened filter: `counts the app’s records only on the shared
  tables` and `drills from a widget to the list of the rows it counts, wherever there is one`
  (`catalog.test.ts`), and `counts fleet assets only on the dashboard` (`built-metadata.test.ts`).
- Verification: `npx vitest run src/server/domain/billing.test.ts src/client/workspace/catalog.test.ts`
  → B+C passed.

What the tests cannot show: the tests' evaluator stands in for the platform's query engine. That
an instance counts the same records can only be seen on a running page. The dev server
(`npm run dev`) proxies an instance, so it needs one too. *In service on an ended line* has run a
two-clause filter of this shape on the same tile kind since before this plan.

Local and instance checks: every done criterion below is local and is enough to hand the work back.
These need an instance. Report each as "not run" unless you ran it:

- As finance, `x_daas_ham_workspace.do`, tab *Billing integrity*: with a fleet asset on a temporary
  deployment whose *Subscription line* is empty, the tile *In service without a subscription line*
  counts it. Give the unit a line and the count drops by one.
- A fleet asset in service with no Subscription line is still counted, as before this plan.
- As an inventory-tech-only user, the tile shows a count and no failure.

## Done criteria

ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm run lint` exits 0
- [ ] `npx vitest run src/server/domain/billing.test.ts src/client/workspace/catalog.test.ts` reports 0 failed and B+C passed
- [ ] `npm run check` exits 0 and reports T passed
- [ ] `grep -c "^export const IN_SERVICE_UNBILLED = .*\^NQinstall_status=" src/server/domain/billing.ts` prints `1`
- [ ] `grep -c "toEqual(\['in_service'\])" src/server/domain/billing.test.ts` prints `0`
- [ ] `git diff --numstat main..HEAD -- src/fluent/generated/keys.ts` shows `0` removed lines
- [ ] `git diff --stat main..HEAD -- src/client 'src/fluent/**/*.now.ts' src/server/platform src/server/test-support src/server/built-metadata.test.ts docs/verify-on-instance.md README.md` prints nothing
- [ ] The three `grep -c` checks of step 5 print `1`, `0` and `1`
- [ ] `git status --short` is empty and only the four in-scope files differ from `main`
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Either `grep -c` of step 1 prints `0`. Plan 043 has not landed, and the spec lines this plan
  replaces are the ones 043 writes. If the operator rejected 043, report that: the code steps of
  this plan stand without it, but the spec bullet then reads differently.
- The constant `IN_SERVICE_UNBILLED`, its test block, or the tile `unbilled_in_service` do not match
  the excerpts in "Current state".
- The third `grep` of step 1 shows `IN_SERVICE_UNBILLED` in a file other than the three named. A
  reader this plan did not see would then change what it finds.
- Step 2 gives a different set of failing tests than the one listed.
- A domain test fails with a message that starts with `encoded query:`. The evaluator met a term it
  does not know. Report the message. Do not change `src/server/test-support/encoded-query.ts`.
- The test `drills from a widget to the list of the rows it counts, wherever there is one` fails
  after step 3. A list then uses the same filter as the tile, and the tile needs a `drill`. Report
  the list. Do not edit `dashboard.ts`.
- `npx vitest run src/server/built-metadata.test.ts` fails after step 4. Report the test name and
  message.
- The `keys.ts` diff of step 4 shows a removed line, or an added entry of a table other than
  `sys_ux_lib_asset`. A Fluent record was then added, renamed or deleted by mistake. Report the
  diff.
- You are tempted to rename the constant, to change the tile's title or id, to add a list, or to
  edit `dashboard.ts`. Those were considered and rejected (see "Decisions already made").
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- In the three asset filters of this tab, `IN_SERVICE_` stands for the billed stages
  (`IN_USE_STAGES`), not for the one stage *in service*. Each is written out with one `^NQ` clause
  per stage, and each has a test that compares the stages it finds with `IN_USE_STAGES`. A third
  billed stage fails all three tests until each constant gets its clause.
- The tile still has no list, and the *In service* list (`assets_in_service` in `catalog.ts`) shows
  the stage *in service* only. So a unit on a temporary deployment that the tile counts is in no
  workspace list, and finance finds it from the platform's own Asset list. A list is one catalog
  entry with this constant, plus `drill` on the tile. The filter reads the Asset's own fields only,
  so the list could be offered to `staff`. The drill test then holds the two together. *In service
  on an ended line* has the same gap. The owner may want both closed in one change.
- A before-query rule can only append conditions, and one appended after `^NQ` binds to the last
  clause only (ADR 0005). The tile is offered to inventory techs, whose reads the rule narrows to
  their Stockrooms. With two clauses, the count an inventory tech sees for the first clause may no
  longer be narrowed. It is a count only, and *In service on an ended line* is in the same
  position. `plans/README.md` lists this under "Findings considered and rejected" (unconfirmed
  platform semantics). Not verified on an instance.
- A unit *pending in service* with no line is not counted, and should not be: it is not billed
  yet, and go-live chooses its line at the first sighting.
- A reviewer should check three things: that both clauses of the constant hold `NO_LINE` and
  `FLEET_CONDITION`, that `dashboard.ts` is unchanged, and that `keys.ts` gained only
  `sys_ux_lib_asset` entries and `deleted: true` marks.
