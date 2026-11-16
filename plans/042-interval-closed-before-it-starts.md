# Plan 042: Remove a Service interval that has not started when its Asset leaves service

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 805d5da..HEAD -- src/server/domain/billing.ts src/server/domain/billing.test.ts src/server/platform/service-intervals.ts src/server/platform/service-intervals.test.ts src/server/entry/billing.test.ts docs/spec/p3-billing.md docs/verify-on-instance.md`
> This plan lands after earlier plans, so the command prints changes. These
> are expected and are not a mismatch:
>
> - `src/server/platform/service-intervals.ts` and its test file: plan 024
>   (required, see "Depends on"). It adds `moveServiceInterval` and
>   `leaveInterval` below the functions this plan quotes, and ten tests.
> - `src/server/domain/billing.ts` and its test file: plan 024 exports the
>   interface `IntervalPlace`. Plan 025 adds `endedLineProblem` and two tests.
>   Plan 026 may add a line near `PULL_PAGE`.
> - `src/server/entry/billing.test.ts`: plans 023, 024, 026 and 041.
> - `docs/spec/p3-billing.md`: plans 024, 025, 026, 035 and 041.
> - `docs/verify-on-instance.md`: many plans add sections.
>
> Only a mismatch in an excerpt this plan quotes is a STOP condition. This plan
> anchors its edits on text, not on line numbers.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/024-interval-follows-line-change.md (its `leaveInterval` in `src/server/platform/service-intervals.ts`, and its tests in the two test files this plan extends)
- **Category**: bug
- **Planned at**: commit `805d5da`, 2026-11-12

## Why this matters

Per-device Subscription lines are billed from Service intervals, one per Asset, and Margin is
costed from them. An Asset that goes back in service at another Subscription line or Site on the
day its interval closed gets its new interval from the day after, so that day is billed once. If the
Asset leaves service again that same day, the new interval has not started. The rule that closes it
never ends an interval before its first day, so it ends the interval on its first day. The interval
then has one day, tomorrow, and the Customer is billed a device-day, and Margin is costed a day, for
a unit that was not in service.

Example. A unit is declared missing on the 11th (its interval ends on the 11th), is found at
another Site the same day (a new interval from the 12th), and is declared missing again the same
day. The new interval is stored as 12th to 12th.

After plan 024 the same happens to a unit that is moved to another line or Site and taken out of
service on one day. Plan 024 names both cases as a known limit and leaves them to this plan.

After this plan, an interval that has not started when its Asset leaves service is removed. It
delivered no day, so it bills none.

## Current state

### An interval never ends before it started

```ts
// src/server/domain/billing.ts:41-44
/** The last day (inclusive) of a Service interval that started on `start` and is closed on `closedOn`: never before it started. */
export function intervalEnd(start: string, closedOn: string): string {
    return closedOn < start ? start : closedOn
}
```

Its one caller is the close. `grep -rn "intervalEnd(" src --include=*.ts | grep -v "\.test\.ts"`
prints the definition and this call, and nothing else:

```ts
// src/server/platform/service-intervals.ts:136-152
function closeHolding(lock: HeldLock, assetId: string, endIso: string): void {
    if (inServiceNow(assetId)) return
    const interval = openIntervals(assetId)
    if (!interval.hasNext() || !lock.held()) return
    let closed = ''
    while (interval.next()) {
        const serial = str(interval, 'asset.serial_number')
        interval.setValue('end_date', intervalEnd(str(interval, 'start_date'), endIso))
        if (interval.update()) {
            closed = serial
            continue
        }
        warnRefused(interval, `${serial} left service on ${endIso}, its Service interval did not close`)
    }
    // The save that took a lost lock over may have put the Asset back in service and found the interval still open.
    if (closed) lock.lostAfter(`${closed} interval closed`, { check: "check it matches the Asset's stage", level: 'error' })
}
```

`closeHolding` has two callers in the same file: `closeServiceIntervals` (an Asset left service) and
`openHolding` (an interval was opened for an Asset that has left service since). Plan 024 adds a
third, `moveHolding`, for an Asset out of service by the time its move runs.

The test that pins the behaviour:

```ts
// src/server/domain/billing.test.ts:58-67
describe('intervalEnd', () => {
    it('ends a Service interval on the day it is closed', () => {
        expect(intervalEnd('2026-11-02', '2026-11-07')).toBe('2026-11-07')
        expect(intervalEnd('2026-11-07', '2026-11-07')).toBe('2026-11-07')
    })

    it('never ends one before it started', () => {
        expect(intervalEnd('2026-11-10', '2026-11-07')).toBe('2026-11-10')
    })
})
```

### How an open interval comes to start tomorrow

```ts
// src/server/domain/billing.ts:51-63 (the interface above it is exported once plan 024 landed)
/**
 * How billing restarts on `start` at `place` for an Asset whose latest closed Service interval is
 * `latest` (end inclusive): one at the same place that ends on or after `start` is reopened, so no day
 * is billed twice; one elsewhere makes the new interval start the day after it ends; otherwise it starts on `start`.
 */
export function restartInterval<Closed extends IntervalPlace & { end: string }>(
    latest: Closed | null,
    place: IntervalPlace,
    start: string,
): { reopen: Closed } | { start: string } {
    if (!latest || latest.end < start) return { start }
    return latest.lineId === place.lineId && latest.siteId === place.siteId ? { reopen: latest } : { start: addDays(latest.end, 1) }
}
```

So an interval that closed today, followed by a restart today at another line or Site, gives an open
interval whose first day is tomorrow. A close today then meets `closedOn < start`.

### What plan 024 added, which this plan reuses

Plan 024 met the same case inside a move and removes the interval there:

```ts
// src/server/platform/service-intervals.ts, as plan 024 writes it
/**
 * End the open `interval` on `todayIso` for an Asset that moved elsewhere: false when the platform refuses. One that
 * starts later (the day after an earlier move today) has billed no day and is deleted, so the Asset goes on from the
 * interval before it.
 */
function leaveInterval(interval: GlideRecord, todayIso: string): boolean {
    if (str(interval, 'start_date') > todayIso) return interval.deleteRecord()
    interval.setValue('end_date', todayIso)
    return Boolean(interval.update())
}
```

Its one caller is `moveHolding`, in the same file. It makes the decision that `intervalEnd` makes
for the close, with the other answer. This plan gives the decision one place: `intervalEnd` says
"no last day" for an interval that starts later, and `leaveInterval` asks it and serves both the
move and the close.

Plan 024 also added, and this plan extends:

- `src/server/platform/service-intervals.test.ts`: `describe('moving the billing of an Asset in service', ...)`,
  below the file's first block `describe('stopping billing for an Asset', ...)`. The file has the
  constants `ASSETS` and `INTERVALS`, the helper `assetIn(stage)` (the Asset `asset1`, serial
  `FOC111`) and a `beforeEach` that resets the fake. Its clock stays at 2025-11-09.
- `src/server/entry/billing.test.ts`: `describe('a save of a fleet asset', ...)` with the helpers
  `unit(stage, fields)`, `saved(before, after)` (stores the Asset and runs the rule's function
  `onAssetServiceChange`), `billed()` (each interval as `[Subscription line, Site, first day, last
  day]`) and `TODAY = '2026-11-11'`. Its `beforeEach` seeds one open interval:
  `sub1`, `site1`, from 2026-10-01.

### Deleting an interval from the rule

The rule runs in the save of whoever saved the Asset: a warehouse tech who receives a unit back, the
integration user of a Seen signal, a job. The table's ACLs name few roles:

```ts
// src/fluent/billing/access.now.ts:14-36 (the read ACL above them is left out)
Acl({
    $id: Now.ID['acl_service_interval_write'],
    type: 'record',
    table: 'x_daas_ham_service_interval',
    operation: 'write',
    roles: intervalEditors,
})

Acl({
    $id: Now.ID['acl_service_interval_create'],
    type: 'record',
    table: 'x_daas_ham_service_interval',
    operation: 'create',
    roles: intervalEditors,
})

Acl({
    $id: Now.ID['acl_service_interval_delete'],
    type: 'record',
    table: 'x_daas_ham_service_interval',
    operation: 'delete',
    roles: [admin],
})
```

`intervalEditors` is the asset manager and finance (`src/fluent/shared/roles.now.ts:117-118`). The
rule already inserts and ends intervals in the saves of users who hold neither role, because the
ACLs do not apply to it:

```md
<!-- docs/adr/0005-visibility-by-before-query-rules.md:111 and :139 -->
across levels. The app's own logic saves through GlideRecord, which no ACL checks.
- A server script's GlideRecord is not checked by ACLs. A read the app makes for a restricted user and returns to them,
```

So the delete needs no more privilege than the update the close makes today, and the delete ACL
stays `[admin]` for a delete by hand. The app relies on the same thing for job locks: their delete
ACL is `[admin]` too (`src/fluent/operations/operations.now.ts`, `acl_job_lock_delete`), and every
save that took a lock releases it with `deleteRecord()` (`src/server/platform/locks.ts`, `release`).
No business rule of the app runs on `x_daas_ham_service_interval`, and no table references it, so a
delete triggers nothing else. That an instance lets a user who is not an admin delete an interval
through the rule was not run for this plan. Step 5 adds the check to `docs/verify-on-instance.md`.

### Decisions already made (do not reopen them)

1. **Remove, do not end.** An interval that starts after the day it is closed on delivered no day.
   Any end date bills at least its first day. Ending it the day before its start would store an
   interval that ends before it starts, which every reader would have to know to skip.
2. **`intervalEnd` keeps its name and returns null for "no last day".** The decision stays a pure
   domain function with its test, as `withinLine` in the same file returns null for "no days". A
   second function, or a tagged result, would add a shape for one caller.
3. **`leaveInterval` serves the close and the move.** Both end an open interval on a day, both
   remove one that has not started, both return false when the platform refuses. The warning for a
   refused delete is the close's own: *its Service interval did not close*. The interval is then
   still open, which is what the message says.
4. **Intervals already stored with one wrong day are not repaired.** Nothing tells one from the
   interval of a unit that was in service for one day.

### What the spec says today

```md
<!-- docs/spec/p3-billing.md:5-11, followed by the bullet plan 024 inserts -->
- **Service intervals** record the days each Asset delivered a Subscription line. A rule on stage
  changes opens one when the Asset enters service (in service or temporary): from its in-service
  date on first go-live, else that day (e.g. a missing unit found again). The same rule closes it
  the day the Asset leaves service (a Return order, declared missing, a manual move). Both days are
  billed. An Asset back in service on or before the day its interval on the same line closed gets
  that interval reopened, so no day is billed twice. The rule also runs when the stage change clears
  the Asset's Subscription line, so the interval still closes.
- A Service interval records its Asset's Subscription line and Site once, as it opens. So the rule
```

### Conventions that apply (AGENTS.md, README.md "Development")

- Layers: `src/server/domain/` is pure, with no Glide. `src/server/platform/` holds the Glide
  services and never imports `entry/`.
- A relative import in `src/server` names the `.ts` file. This plan adds no import:
  `service-intervals.ts` already imports `intervalEnd`.
- A test is a `*.test.ts` file beside its module. A test of `platform/` or `entry/` runs against
  `src/server/test-support/fake-glide.ts`, which runs no business rule: a test calls the rule's
  function itself.
- Use the words of `CONTEXT.md`: Asset, Service interval, Subscription line, Site.
- Comments only for a non-obvious why. No comment that narrates a test's phases.
- `npx vitest run <path>` needs no build. `npm test` and `npm run check` need `npm run build` first.
  `npm run check` builds before it tests.
- `npm run build` rewrites the tracked `src/fluent/generated/keys.ts`. This plan adds no Fluent
  record and changes no client file, so the build must leave that file unchanged.
- When documented behaviour changes, the spec line changes in the same commit.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Lint | `npm run lint` | exit 0 |
| This plan's tests | `npx vitest run src/server/domain/billing.test.ts src/server/platform/service-intervals.test.ts src/server/entry/billing.test.ts` | all pass |
| Build | `npm run build` | exit 0; rewrites `dist/` |
| Every test | `npx vitest run` (after a build) | 0 failed |
| Full gate | `npm run check` | exit 0, all tests pass |

## Scope

**In scope** (the only files you should modify):

- `src/server/domain/billing.ts` (only `intervalEnd` and its doc comment)
- `src/server/domain/billing.test.ts` (one test changed)
- `src/server/platform/service-intervals.ts` (`closeHolding`, `leaveInterval`, and one sentence of the doc comment of `closeServiceIntervals`)
- `src/server/platform/service-intervals.test.ts` (two tests added)
- `src/server/entry/billing.test.ts` (one test added)
- `docs/spec/p3-billing.md` (one bullet added)
- `docs/verify-on-instance.md` (one section added)

**Out of scope** (do NOT touch, even though they look related):

- `restartInterval`. A restart elsewhere still starts the day after. That rule is what keeps a day
  from being billed twice.
- `openServiceInterval`, `openHolding`, `openInterval`, `moveServiceInterval`, `moveHolding` and
  `underIntervalLock`. They call `closeHolding` or `leaveInterval` and get the new behaviour through
  them.
- `src/fluent/billing/access.now.ts`. The delete ACL stays `[admin]`. The rule does not need it
  (see "Deleting an interval from the rule").
- `src/server/entry/billing.ts` and `src/fluent/billing/logic.now.ts`. The rule and its function do
  not change.
- `src/server/test-support/fake-glide.ts`. It has `deleteRecord` and refuses one through
  `platform.refuses`.
- A repair of intervals stored with one wrong day (decision 4).
- `docs/adr/0009-billing-from-per-asset-service-intervals.md`. It says the rule opens and closes
  intervals, which stays true.
- Any `src/fluent` file. `src/fluent/generated/keys.ts` must not change.

## Git workflow

- Branch: `advisor/042-interval-closed-before-it-starts`, from `main`.
- One commit. Subject in the repo's style, an imperative sentence under 72 characters, for example
  `Remove a Service interval not yet started when its unit leaves`. The body says what was wrong
  and why (the close ended such an interval on its first day, so a day the unit was not in service
  was billed and costed).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Branch and confirm the baseline

```sh
git checkout main && git checkout -b advisor/042-interval-closed-before-it-starts
grep -c "^function leaveInterval" src/server/platform/service-intervals.ts
grep -c "describe('a save of a fleet asset'" src/server/entry/billing.test.ts
grep -rn "intervalEnd(" src --include=*.ts | grep -v "\.test\.ts"
npx vitest run src/server/domain/billing.test.ts
npx vitest run src/server/platform/service-intervals.test.ts
npx vitest run src/server/entry/billing.test.ts
npm run build && npx vitest run
git status --short
```

**Verify**: the first two `grep` commands print `1`. If either prints `0`, plan 024 has not landed:
STOP. The third prints exactly two lines: the definition in `src/server/domain/billing.ts` and the
call in `closeHolding` in `src/server/platform/service-intervals.ts`. If it prints another caller,
STOP. Every test run reports 0 failed. Write down three numbers of passed tests: D for
`domain/billing.test.ts` (55, or 57 if plan 025 landed), P for `service-intervals.test.ts` (12) and
E for `entry/billing.test.ts` (30, or 31 if plan 041 landed). Write down the total of the full run:
the last step calls it T (1840 in 113 files if plans 023, 024, 025 and 041 landed and no other).
`git status --short` prints nothing.

### Step 2: Write the failing tests

Edit `src/server/domain/billing.test.ts`. In `describe('intervalEnd', ...)`, replace the test
`it('never ends one before it started', ...)` (three lines, quoted in "Current state") with:

```ts
    it('gives no last day to one that starts later: it delivered no day, and is removed', () => {
        expect(intervalEnd('2026-11-08', '2026-11-07')).toBeNull()
        expect(intervalEnd('2026-11-10', '2026-11-07')).toBeNull()
    })
```

Edit `src/server/platform/service-intervals.test.ts`. The first `describe` of the file,
`describe('stopping billing for an Asset', ...)`, ends with these lines:

```ts
        expect(interval().end_date).toBe('')
    })
})
```

Replace them with:

```ts
        expect(interval().end_date).toBe('')
    })

    describe('whose open interval has not started yet', () => {
        beforeEach(() => {
            // It left service on the 9th, went back in service elsewhere that day (billed from the 10th), and leaves again.
            platform.tables[INTERVALS] = [
                { sys_id: 'int1', asset: 'asset1', subscription_line: 'sub1', start_date: '2025-10-01', end_date: '2025-11-09' },
                { sys_id: 'int2', asset: 'asset1', subscription_line: 'sub2', start_date: '2025-11-10', end_date: '' },
            ]
            platform.tables[ASSETS] = [assetIn('pending_return')]
        })

        it('removes that interval, which delivered no day, and keeps the one before it as it ended', () => {
            closeServiceIntervals('asset1', '2025-11-09')

            expect(platform.tables[INTERVALS]).toEqual([expect.objectContaining({ sys_id: 'int1', start_date: '2025-10-01', end_date: '2025-11-09' })])
            expect(platform.tables.x_daas_ham_job_lock).toEqual([])
        })

        it('says so when the platform refuses to remove it, and leaves it open', () => {
            platform.refuses = (table, _row, operation) => (table === INTERVALS && operation === 'delete' ? 'no' : '')

            closeServiceIntervals('asset1', '2025-11-09')

            expect(platform.tables[INTERVALS]?.map((row) => [row.sys_id, row.end_date])).toEqual([
                ['int1', '2025-11-09'],
                ['int2', ''],
            ])
            expect(platform.warnings).toEqual(['[x_daas_ham] FOC111 left service on 2025-11-09, its Service interval did not close: no'])
        })
    })
})
```

The text `expect(interval().end_date).toBe('')` occurs once in the file, so the place is not in
doubt.

Edit `src/server/entry/billing.test.ts`. In `describe('a save of a fleet asset', ...)`, insert this
test directly above the test
`it('closes the interval, and opens none, for a save that takes the unit out of service and clears its line and Site', () => {`,
followed by one blank line:

```ts
    it('bills no day at the Site a unit came back to and left again on the day it first left service', () => {
        const elsewhere = { x_daas_ham_site: 'site2' }
        saved(unit('in_service'), unit('missing'))
        saved(unit('missing'), unit('in_service', elsewhere))
        expect(billed()).toEqual([
            ['sub1', 'site1', '2026-10-01', TODAY],
            ['sub1', 'site2', '2026-11-12', ''],
        ])

        saved(unit('in_service', elsewhere), unit('missing', elsewhere))

        expect(billed()).toEqual([['sub1', 'site1', '2026-10-01', TODAY]])
    })
```

**Verify**: run the three test files of step 1 in one command:

```sh
npx vitest run src/server/domain/billing.test.ts src/server/platform/service-intervals.test.ts src/server/entry/billing.test.ts
```

It reports `4 failed`, and D+P+E-1 passed. The four failures are exactly:

- `intervalEnd > gives no last day to one that starts later: it delivered no day, and is removed`
- `stopping billing for an Asset > whose open interval has not started yet > removes that interval, which delivered no day, and keeps the one before it as it ended`
  (the interval `int2` is still stored, from 2025-11-10 to 2025-11-10)
- `stopping billing for an Asset > whose open interval has not started yet > says so when the platform refuses to remove it, and leaves it open`
- `a save of a fleet asset > bills no day at the Site a unit came back to and left again on the day it first left service`
  (a second interval is stored, `sub1`, `site2`, from 2026-11-12 to 2026-11-12)

The second and the fourth show the bug: one day billed for a unit that was not in service. If the
set of failures differs, STOP.

### Step 3: Let the domain function say that no day was delivered

In `src/server/domain/billing.ts`, replace the whole of `intervalEnd` with its doc comment (the four
lines quoted in "Current state") with:

```ts
/**
 * The last day (inclusive) of a Service interval that started on `start` and is closed on `closedOn`, or null for one
 * that starts later (the day after an interval elsewhere ended, restartInterval): it delivered no day, so it is removed
 * and not ended, which would bill its first day.
 */
export function intervalEnd(start: string, closedOn: string): string | null {
    return closedOn < start ? null : closedOn
}
```

**Verify**: `npx vitest run src/server/domain/billing.test.ts` → D passed, 0 failed. Do not run the
typecheck yet: the next step changes the caller.

### Step 4: Close and move through one function

Edit `src/server/platform/service-intervals.ts`. Make these three changes.

(a) In `closeHolding`, replace these two lines:

```ts
        interval.setValue('end_date', intervalEnd(str(interval, 'start_date'), endIso))
        if (interval.update()) {
```

with:

```ts
        if (leaveInterval(interval, endIso)) {
```

Leave the rest of `closeHolding` as it is: the `closed = serial` and `continue` inside the `if`, the
`warnRefused` after it, and the `lock.lostAfter` at the end.

(b) Replace the whole of `leaveInterval` with its doc comment (the ten lines quoted in "What plan
024 added") with:

```ts
/**
 * End the open `interval` on `lastIso` for an Asset that left service or moved elsewhere: false when the platform
 * refuses. One that starts later (the day after an interval elsewhere ended that day) has delivered no day and is
 * deleted (intervalEnd), so the Asset goes on from the interval before it.
 */
function leaveInterval(interval: GlideRecord, lastIso: string): boolean {
    const end = intervalEnd(str(interval, 'start_date'), lastIso)
    if (end === null) return interval.deleteRecord()
    interval.setValue('end_date', end)
    return Boolean(interval.update())
}
```

(c) In the doc comment of `closeServiceIntervals`, replace the line

```ts
 * Stop billing an Asset: its open intervals end on `endIso` (inclusive). It takes turns with the open under the Asset's
```

with these two lines:

```ts
 * Stop billing an Asset: its open intervals end on `endIso` (inclusive), and one that starts later, which delivered no
 * day, is removed (leaveInterval). It takes turns with the open under the Asset's
```

**Verify**:

```sh
npx vitest run src/server/domain/billing.test.ts src/server/platform/service-intervals.test.ts src/server/entry/billing.test.ts
npm run typecheck
npm run lint
grep -c "intervalEnd(" src/server/platform/service-intervals.ts
```

The test run reports D+P+E+3 passed and 0 failed (P+2 and E+1 new tests, and D unchanged). The
typecheck and the lint exit 0. The `grep` prints `1`: `leaveInterval` is now the only caller.

### Step 5: Change the documents

In `docs/spec/p3-billing.md`, insert this bullet directly above the line that starts
`- A Service interval records its Asset's Subscription line and Site once, as it opens.` (the bullet
plan 024 added):

```md
- An interval that has not started yet when its Asset leaves service is removed, not closed. An
  Asset back in service at another line or Site on the day its interval closed gets its new
  interval from the day after, so that day is billed once. If it leaves service again that same
  day, the new interval has delivered no day. Closing it would bill its first day, a day the Asset
  was not in service, so the rule deletes it. A delete the platform refuses is logged as a warning,
  as a refused close is, and the interval stays open, to remove by hand.
```

In `docs/verify-on-instance.md`, insert this section directly above the line
`### Replacement SLA stop`, with one blank line before and after it:

```md
### Service interval not yet started

As a user who is not an admin, take a fleet asset in service that has an open Service interval out
of service (declare it missing): the interval gets today as its *Last day*. Put it back in service
the same day at another *Site* (a Seen signal, or its stage set by hand): a new interval is
created with tomorrow as its *First day*. Take it out of service again the same day: the new
interval is gone, and the first one still ends today. No interval of the Asset is left with a
*First day* after today. The rule deletes the interval in the save of that user, as it creates and
ends one. If the platform refuses the delete, the interval stays open and the log has
*[x_daas_ham] <serial> left service on <date>, its Service interval did not close: ...* (warning):
an admin deletes it by hand.

**After an upgrade:** an interval closed this way before this release has one day, the day after
its Asset's interval before it ended, and bills that day. Nothing tells it from the interval of a
unit that was in service for one day, so none is removed.
```

**Verify**:

- `grep -c "An interval that has not started yet when its Asset leaves service is removed" docs/spec/p3-billing.md` → `1`
- `grep -c "### Service interval not yet started" docs/verify-on-instance.md` → `1`

### Step 6: Run the full gate and commit

```sh
npm run check
git status --short
```

**Verify**: `npm run check` exits 0 and the test run reports T+3 passed (three tests added, one
changed), in the same number of files as in step 1. `git status --short` lists exactly the seven
in-scope files. `src/fluent/generated/keys.ts` is not among them.

Commit the seven files in one commit, with the subject from "Git workflow" and a body that says what
was wrong and why.

## Test plan

- `src/server/domain/billing.test.ts`, 1 test changed in `describe('intervalEnd', ...)`: an
  interval that starts after the day it is closed on has no last day (null), whether it starts the
  day after or later. The test beside it stays: an interval closed on or after its first day ends
  that day, so a unit in service for one day still bills that day.
- `src/server/platform/service-intervals.test.ts`, 2 new tests in a nested `describe`, modelled on
  the two tests above them:
  - the regression this plan fixes: the interval that starts tomorrow is removed when its Asset
    leaves service today, the interval before it keeps its dates, and the lock is released;
  - a delete the platform refuses leaves the interval open and logs the close's warning.
- `src/server/entry/billing.test.ts`, 1 new test in `describe('a save of a fleet asset', ...)`,
  through the rule's function: a unit declared missing, found at another Site and declared missing
  again on one day ends with one interval, the first, closed today.
- Unchanged tests that guard the rest: `closes its open interval on the day it left service`, and
  plan 024's `takes back a move made earlier the same day` and `bills no day on a line the Asset
  was moved to and off again the same day`, which run the same `leaveInterval`.
- Verification: the command of step 4 → D+P+E+3 passed.

What the tests cannot show: the fake runs no business rule and no ACL. That the instance lets the
rule delete an interval in the save of a user who is not an admin rests on ADR 0005 and on the job
locks, which the same saves delete. The fake is single-threaded, so two saves at once are not run.

Local and instance checks: every done criterion below is local. The instance check is the new
section of `docs/verify-on-instance.md` (step 5). It is the final proof of this fix and it is not
run by this plan. Say in your report that it was not run, unless you ran it.

## Done criteria

ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm run lint` exits 0
- [ ] The test command of step 4 reports 0 failed and D+P+E+3 passed
- [ ] `npm run check` exits 0 and reports T+3 passed
- [ ] `grep -c "closedOn < start ? null : closedOn" src/server/domain/billing.ts` prints `1`
- [ ] `grep -rn "intervalEnd(" src --include=*.ts | grep -v "\.test\.ts"` prints two lines: the definition and the call in `leaveInterval`
- [ ] `grep -c "leaveInterval(interval, endIso)" src/server/platform/service-intervals.ts` prints `1`
- [ ] `grep -c "never ends one before it started" src/server/domain/billing.test.ts` prints `0`
- [ ] The two `grep -c` checks of step 5 each print `1`
- [ ] `git diff --stat main..HEAD -- src/fluent src/server/entry/billing.ts src/server/test-support docs/adr` prints nothing
- [ ] `git status --short` is empty and only the seven in-scope files differ from `main`
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `intervalEnd`, `closeHolding` or `leaveInterval` does not match the excerpts in "Current state".
- Either of the first two `grep` commands of step 1 prints `0`. Plan 024 has not landed, and this
  plan changes its `leaveInterval` and extends its tests.
- The third `grep` of step 1 shows a caller of `intervalEnd` other than `closeHolding`. That caller
  would get null where it expects a date. Report the file and line.
- Step 2 gives a different set of failing tests than the four listed.
- A test that existed before this plan fails at any step, other than the one this plan changes. The
  close of an interval that has started, and the move of plan 024, must behave as before.
- A business rule on `x_daas_ham_service_interval`, or a column that references that table, exists
  by now (`grep -rn "x_daas_ham_service_interval" src/fluent --include=*.now.ts` prints only lines
  of `src/fluent/billing/access.now.ts`, `tables.now.ts` and `forms.now.ts` at the planned-at
  commit). A delete could then trigger more than this plan assumes. Report what you found.
- A test fails with a message that starts with `fake Glide:`. Report the message. Do not extend
  `fake-glide.ts` under this plan.
- `npm run build` leaves `src/fluent/generated/keys.ts` modified. Report the diff.
- You are tempted to change the delete ACL, to end the interval the day before it starts, or to
  change `restartInterval`. Those were considered and rejected (see "Decisions already made").
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- `intervalEnd` now has two answers, a last day or null, and `leaveInterval` is the one place that
  acts on them. New code that ends an open interval calls `leaveInterval`. Code that sets
  `end_date` itself can store the one-day interval again.
- The close can now delete a row. A future business rule or a reference on
  `x_daas_ham_service_interval` (a Cost fact that names its interval, say) has to allow for an
  interval that goes away on the day it was opened.
- An Asset put in service with an in-service date in the future has an interval that starts in the
  future. If it leaves service before that date, the interval is removed too. That is the same
  rule: no day was delivered.
- Known limit, not changed here: a unit that goes in service and leaves on one day at one place
  bills that day, once. Both days of an interval are billed, and here they are the same day.
- Not repaired: intervals stored with one wrong day before this release (decision 4). They sit in
  whatever Billing periods billed them. A period still *Ready for review* is put right by deleting
  the interval by hand and *Regenerate*.
- The instance check in `docs/verify-on-instance.md` is the only proof that a user who is not an
  admin deletes an interval through the rule. If an instance refuses it, the warning in the log
  says so, and the fix is then a decision about the table, not about this code.
- A reviewer should check three things: that `closeHolding` still sets `closed` and calls
  `lock.lostAfter` for a removed interval as for an ended one, that `intervalEnd` has no caller but
  `leaveInterval`, and that `src/fluent/billing/access.now.ts` is unchanged.
