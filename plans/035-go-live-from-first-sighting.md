# Plan 035: Start billing from the first sighting since the install, also when the go-live is put off

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 805d5da..HEAD -- src/server/domain/in-service.ts src/server/domain/in-service.test.ts src/server/platform/in-service.ts src/server/platform/in-service.test.ts src/server/platform/subscriptions.ts src/fluent/shared/platform-tables.now.ts docs/spec/p1-fulfilment.md docs/spec/p3-billing.md docs/verify-on-instance.md README.md`
> If any of these files changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding. On a
> mismatch, treat it as a STOP condition. (Plan 024 inserts a bullet after
> line 11 of `docs/spec/p3-billing.md` and a section in
> `docs/verify-on-instance.md`. Plans 029 and 038 also edit
> `docs/verify-on-instance.md`. None of that is a mismatch if the lines quoted
> under "Documentation to change" still read as quoted. Find them by their
> text, not by their line numbers. `src/fluent/generated/keys.ts` is left out
> on purpose: every build of another plan rewrites it.)

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED (it moves billing start dates earlier for Assets whose go-live was put off, and
  adds a column to `alm_hardware`)
- **Depends on**: none for the code. Land it after `plans/024-interval-follows-line-change.md`
  when that plan is in the queue: 024 quotes lines 5 to 12 of `docs/spec/p3-billing.md` as they
  are today, and this plan rewrites lines 6 and 7.
- **Category**: bug
- **Planned at**: commit `805d5da`, 2026-11-12

## Why this matters

An Asset goes in service, and its Subscription line starts billing, at the first Seen signal after
its install. The spec says so, and the code agrees when everything works at that first sighting.
When it does not, the Asset stays pending in service and a later sighting or detection run puts it
in service. The code then takes the time of that later sighting as the in-service date, because the
only time it keeps is *Last seen*, which every sighting moves forward. The days between the first
sighting and the later one are never billed.

The go-live is put off whenever the Asset's Subscription line cannot be started: another go-live
holds the line's lock through every try, or the platform refuses the line's save, or the line was
ended by hand. A refused save can last days, until someone fixes the line. Every Asset waiting on
that line then loses those days of revenue, and nothing flags it.

This plan makes the Asset keep the first sighting since its install in a column of its own. A
go-live that is put off starts billing from that sighting, whichever later sighting or run
completes it.

## Current state

### The words (CONTEXT.md)

- **In service**: an Asset installed at a Site and seen by monitoring; the moment billing starts.
- **Seen signal**: evidence from Discovery, a connector or the Provider's NMS that an Asset is
  alive on the network.
- **Service interval**: the days one Asset delivered a Subscription line.

Use these words in names and comments. Do not write "live", "active" or "heartbeat" for them.

### The decision (pure domain code)

```ts
// src/server/domain/in-service.ts:4-26
/**
 * In service: an Asset installed at a Site and seen by monitoring after the install. That instant
 * starts billing for its Subscription line.
 */
export interface InServiceFacts {
    stage: Stage | null
    installCompletedAt?: number
    lastSeenAt?: number
    temporary: boolean
}

export type InServiceDecision =
    | { goesLive: true; at: number; stage: 'in_service' | 'temporary_deployment' }
    | { goesLive: false; reason: string }

export function decideInService(facts: InServiceFacts): InServiceDecision {
    if (facts.stage !== 'pending_in_service') return { goesLive: false, reason: 'not pending in service' }
    if (facts.installCompletedAt === undefined) return { goesLive: false, reason: 'install not completed' }
    if (facts.lastSeenAt === undefined || facts.lastSeenAt < facts.installCompletedAt) {
        return { goesLive: false, reason: 'not seen since install' }
    }
    return { goesLive: true, at: facts.lastSeenAt, stage: facts.temporary ? 'temporary_deployment' : 'in_service' }
}
```

Line 25 is the finding: the go-live time is `lastSeenAt`, the last sighting, not the first one
since the install.

### Where sightings are applied (platform code)

```ts
// src/server/platform/in-service.ts:21-26
function recordSeen(asset: GlideRecord, at: number, source: SeenSource): void {
    const previous = glideToMs(str(asset, 'x_daas_ham_last_seen'))
    if (previous !== undefined && previous >= at) return
    asset.setValue('x_daas_ham_last_seen', msToGlide(at))
    asset.setValue('x_daas_ham_seen_source', source)
}
```

```ts
// src/server/platform/in-service.ts:28-56
/**
 * Put a pending Asset in service if it has been seen since its install, and save it. False when it saved nothing:
 * having outlasted its sighting `lock` (ADR 0013), as the sighting that took the lock over read the Asset after this
 * one, or because the save was refused (logged), so the sighting is applied again when sent again or at the next run.
 */
function goLiveIfSeen(lock: HeldLock, asset: GlideRecord, readers: LifecycleReaders): boolean {
    const stage = readStage(asset)
    const decision = decideInService({
        stage,
        installCompletedAt: glideToMs(str(asset, 'x_daas_ham_install_completed')),
        lastSeenAt: glideToMs(str(asset, 'x_daas_ham_last_seen')),
        // Only a pending Asset can go live, so only it pays for the dot-walk to its Order.
        temporary: stage === 'pending_in_service' && choice<OrderType>(asset, 'x_daas_ham_order_line.order.order_type') === 'temporary',
    })
    if (!lock.held()) return false
    // An Asset whose Subscription line could not be started stays pending, so a later sighting or run attaches it.
    if (!decision.goesLive || !attachToSubscription(asset, decision.at)) {
        if (asset.update()) return true
        log.error(`in-service detection: sighting of ${str(asset, 'serial_number')} not saved: ${refusal(asset)}`)
        return false
    }
    asset.setValue('x_daas_ham_in_service_date', msToGlide(decision.at))
    applyLifecycleDates(asset, readers)
    if (moveAndSave(asset, decision.stage, 'in-service detection')) return true
    // A line started above stays active: the sighting applied again finds it active and joins it, its start date kept.
    const pending = `${str(asset, 'serial_number')} stays pending in service, its Subscription line possibly active`
    log.error(`in-service detection: ${pending}: left to the next sighting or run`)
    return false
}
```

How the days are lost, step by step. Install completed on day 0. Sighting on day 1:
`recordSeen` sets *Last seen* to day 1, the decision is to go live at day 1,
`attachToSubscription` (`src/server/platform/subscriptions.ts:19`) returns false because the line
cannot be started, and line 45 saves the Asset, still pending, with *Last seen* day 1. Sighting on
day 4: `recordSeen` moves *Last seen* to day 4, the decision is to go live at day 4, the line
starts now, and line 49 sets the in-service date to day 4. Billing reads that date:

```ts
// src/server/domain/lifecycle.ts:319-323
export function billingChange(before: Stage | null, after: Stage | null, dates: BillingDates): BillingChange | null {
    if (isBillable(before) === isBillable(after)) return null
    if (!isBillable(after)) return { stop: dates.today }
    return { start: (before === 'pending_in_service' && dates.inServiceDate) || dates.today }
}
```

So the Service interval starts on day 4. Days 1 to 3 are not billed.

`goLiveIfSeen` has two callers, and both lose the first sighting the same way:

- `applyDeviceEvent` (line 89), for an NMS event sent to `POST /api/x_daas_ham/naas/device_events`.
- `applyCiSighting` (line 119), for the scheduled job *NaaS - in-service detection*, which runs
  every 15 minutes over every pending fleet asset and reads its CI's `last_discovered`. This is
  the "next run" of the comments. It retries a pending Asset with whatever *Last seen* the Asset
  holds, moved forward to the CI's latest discovery when that is later.

`goLiveIfSeen` runs for every sighting, of an Asset in any stage. Only a pending Asset can go live.

Install completion sets the install time and makes the Asset pending in one save
(`src/server/platform/delivery.ts:208-210`), so a sighting at or after the install time can only
find the Asset pending in service or later. An Asset that was in service, came back, and is
installed again gets a new, later install time.

### Why a new column, and not data already stored

Three places already hold sighting times. None can give the first sighting since the install:

- *Last seen* (`x_daas_ham_last_seen`) is the last sighting by definition. It also feeds the
  installed-base reconciliation and the workspace's lists, so it cannot be frozen while an Asset
  is pending.
- Device events (`x_daas_ham_device_event`) are stored for NMS state changes only: a second *seen*
  after a stored *seen* adds none (`in-service.ts:91`), the detection job stores none at all, and
  they are purged after `x_daas_ham.events.retention_days`. An Asset first seen by Discovery has
  no event to read.
- The in-service date (`x_daas_ham_in_service_date`) could be stamped early, on a pending Asset.
  But it means "the day the Asset went into service" to billing (`onAssetServiceChange` in
  `entry/billing.ts`), to the margin's write-off (`withAssets` in `platform/margin.ts`) and to
  the refresh date (`stampInputs` in `platform/lifecycle-dates.ts`). An Asset returned before it ever went in service would keep
  an in-service date it never had.

So the Asset gets one new date/time column, `x_daas_ham_first_seen`, labelled *First seen since
install*. It is written only while the Asset is pending in service, and it holds the first
sighting at or after the install time. A value older than the install time is from an earlier
install and is passed over, then replaced by the next sighting since the new install. Nothing
needs to clear it when an install is completed again.

### Where the column goes

Columns the app adds to a platform table live in one `Table({ augments })` per table in
`src/fluent/shared/platform-tables.now.ts` (README "Where a Fluent record goes"). The neighbours:

```ts
// src/fluent/shared/platform-tables.now.ts:61-64
        x_daas_ham_install_completed: DateTimeColumn({ label: 'Install completed' }),
        x_daas_ham_in_service_date: DateTimeColumn({ label: 'In-service date', readOnly: true }),
        x_daas_ham_last_seen: DateTimeColumn({ label: 'Last seen', readOnly: true }),
        x_daas_ham_seen_source: ChoiceColumn({
```

A column is a property of the table, not a record of its own, so it takes no `$id`. `npm run build`
then adds two entries for it to the tracked file `src/fluent/generated/keys.ts` (one
`sys_dictionary`, one `sys_documentation`, 17 lines in all, with generated ids). That file is
committed with the change.

### What this plan does not fix

When the go-live's own save of the Asset is refused (line 51, `moveAndSave`), nothing of the
sighting is stored on the Asset, the new column included. An existing test holds that behaviour:

```ts
// src/server/platform/in-service.test.ts:140-146
    it('is reported busy when its go-live save is refused, its line left active, and joins that line when sent again', () => {
        platform.refuses = (table, _row, operation) => (table === ASSETS && operation === 'update' ? 'stage rule said no' : '')

        expect(applyDeviceEvents([event()])).toEqual({ unknown: [], busy: ['FOC111'] })

        expect(asset()).toMatchObject(stage('pending_in_service'))
        expect(asset().x_daas_ham_last_seen ?? '').toBe('')
```

That test goes on to send a sighting one day later and expects the in-service date of that later
day. It must keep passing unchanged. The NMS is told the event is busy and sends the same event
again with its own time, which is the first sighting. Only when a different, later sighting
arrives first is the later time used. Fixing that needs a second, narrower save after a refused
one, which is a different change. This plan documents the limit in the spec.

The detection job reads only the CI's latest discovery. When Discovery saw the CI several times
between two runs of the job, the first of them is not known to the app. With a run every 15
minutes that is at most a few minutes, and this plan leaves it.

### The existing tests (written by plan 011)

- `src/server/domain/in-service.test.ts`: 18 tests. `decideInService` has 5, built on
  `const installed = { stage: 'pending_in_service' as const, installCompletedAt: 1_000, temporary: false }`.
  The file imports from `'./in-service'`, without the `.ts`. Keep its style.
- `src/server/platform/in-service.test.ts`: 26 tests, against the fake Glide. Its fixtures:
  `INSTALLED = '2025-11-08 10:00:00'`, `SEEN = '2025-11-09 09:00:00'`, `SEEN_MS`, `unit(stage,
  fields)`, `event(fields)`, `asset()`, `line()`, `stage(of)`, and in the job's block
  `discovered(fields)`. The test at line 123 makes the line's save refused with
  `platform.refuses = (table, _row, operation) => (table === LINES && operation === 'update' ? 'line locked by finance' : '')`.
  The new tests use the same line.

### Documentation to change

```md
<!-- docs/spec/p1-fulfilment.md:286-289 -->
- An Asset is in service at the first sighting at or after its install completion. A temporary Order
  gives a temporary deployment instead.
- At that moment:
  - the in-service date is set;
```

```md
<!-- docs/spec/p1-fulfilment.md:305-307 -->
  not applied and is returned in `busy_identifiers`; the detection job leaves that Asset to its next
  run. A go-live whose save is refused after its Subscription line was started leaves the line
  active: the sighting applied again joins it, its start date kept.
```

```md
<!-- docs/spec/p3-billing.md:5-7 -->
- **Service intervals** record the days each Asset delivered a Subscription line. A rule on stage
  changes opens one when the Asset enters service (in service or temporary): from its in-service
  date on first go-live, else that day (e.g. a missing unit found again). The same rule closes it
```

```md
<!-- docs/verify-on-instance.md:649-654 -->
A go-live starts a pending Subscription line under `subscription_line_<line sys_id>`. With a row of
that name in *Job lock*, a *seen* event for an Asset going live on that line is accepted. The Asset
stays pending in service, two *Unique Key violation* errors a try are logged, and so is *[x_daas_ham]
<serial> stays pending in service, line not started: another go-live held its lock through every
try* (warning). Delete the row, or leave it until it is abandoned, and the next sighting starts the
line.
```

README "Upgrading" (lines 154 to 185) is a bullet list of what to do on an instance that had an
earlier version. Its last bullet starts `- Work through the checks marked **After an upgrade**`.

### Conventions that apply (README.md "Development", AGENTS.md)

- `src/server/domain/` is pure: no Glide, nothing from `platform/` or `entry/`. The new rule is a
  pure function there, and the platform code calls it.
- A relative import in `src/server` names the `.ts` file. ESLint enforces it (test files of the
  domain folder are the exception you see in the existing import).
- A `.now.ts` file holds constants only: no function call, loop or spread. The new column line is
  a plain property like its neighbours.
- A test is a `*.test.ts` file beside its module. A platform test runs against
  `src/server/test-support/fake-glide.ts`, which throws `fake Glide: ...` on anything it does not
  know and runs no business rule.
- `npx vitest run <path>` needs no build. `npm test` and `npm run check` do: the tests in
  `src/server/built-metadata.test.ts` fail when a file under `src/fluent` or `src/server` is newer
  than `dist/app`.
- `npm run build` rewrites the tracked `src/fluent/generated/keys.ts`. Commit it with the change.
- When documented behaviour changes, the matching spec and README lines change in the same commit.
- ATF tests run on an instance only. Say so in your report when you could not run them.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Lint | `npm run lint` | exit 0 |
| This plan's tests | `npx vitest run src/server/domain/in-service.test.ts src/server/platform/in-service.test.ts` | all pass |
| Build | `npm run build` | exit 0; rewrites `dist/` and `src/fluent/generated/keys.ts` |
| Full gate | `npm run check` | exit 0; all tests pass |

## Scope

**In scope** (the only files you should modify):

- `src/fluent/shared/platform-tables.now.ts` (one line added)
- `src/fluent/generated/keys.ts` (rewritten by `npm run build`, never by hand)
- `src/server/domain/in-service.ts`
- `src/server/domain/in-service.test.ts`
- `src/server/platform/in-service.ts` (only `goLiveIfSeen`, one constant and one import)
- `src/server/platform/in-service.test.ts`
- `docs/spec/p1-fulfilment.md`
- `docs/spec/p3-billing.md`
- `docs/verify-on-instance.md`
- `README.md` (one bullet under "Upgrading")

**Out of scope** (do NOT touch, even though they look related):

- `recordSeen`. *Last seen* keeps moving forward with every sighting, for every stage.
- `src/server/platform/subscriptions.ts`. `attachToSubscription` and the line's lock are right.
- `src/server/entry/billing.ts` and `billingChange` in `src/server/domain/lifecycle.ts`. Billing
  keeps starting from the in-service date. This plan only makes that date right.
- `src/server/platform/delivery.ts`. Install completion does not need to clear the new column:
  a value older than the install time is passed over.
- The go-live whose Asset save is refused (see "What this plan does not fix"). The existing test
  for it must pass unchanged.
- Forms, lists and the workspace catalog (`src/client/workspace/catalog.ts`). The column is not
  shown anywhere by this plan.
- `src/server/entry/demo-seed.ts`. Demo Assets in service need no first sighting.
- `CONTEXT.md`. The definition of *In service* already says billing starts when the Asset is seen.

## Git workflow

- Branch: `advisor/035-go-live-from-first-sighting`, from `main`.
- One commit. Subject in the repo's style, an imperative sentence under 72 characters, for example
  `Go live from the first sighting since the install, not the last`. The body says what was wrong
  and why (a go-live put off took the later sighting as the in-service date, so the days between
  went unbilled).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Branch and confirm the baseline

```sh
git checkout main && git checkout -b advisor/035-go-live-from-first-sighting
npx vitest run src/server/domain/in-service.test.ts src/server/platform/in-service.test.ts
```

**Verify**: 44 passed, 0 failed (18 and 26 at the planned-at commit).

### Step 2: Add the column

In `src/fluent/shared/platform-tables.now.ts`, insert this line directly after the
`x_daas_ham_last_seen` line (line 63), with the same indentation:

```ts
        x_daas_ham_first_seen: DateTimeColumn({ label: 'First seen since install', readOnly: true }),
```

`DateTimeColumn` is already imported in that file. Do not add an index for the column: nothing
queries by it.

**Verify**: `grep -c "x_daas_ham_first_seen: DateTimeColumn({ label: 'First seen since install', readOnly: true })," src/fluent/shared/platform-tables.now.ts` → `1`.

### Step 3: Write the failing domain tests

Edit `src/server/domain/in-service.test.ts`.

Replace the import on line 2 with:

```ts
import { chooseSubscriptionLine, decideInService, firstSeenSinceInstall, seenSourceOf } from './in-service'
```

Inside `describe('decideInService', ...)`, insert these two tests directly before
`it('waits for the install to be completed', ...)`:

```ts
    it('goes live from the first sighting since the install, not from a later one', () => {
        expect(decideInService({ ...installed, firstSeenAt: 1_200, lastSeenAt: 1_500 })).toEqual({ goesLive: true, at: 1_200, stage: 'in_service' })
    })

    it('passes over a first sighting kept from before the install', () => {
        expect(decideInService({ ...installed, firstSeenAt: 500, lastSeenAt: 1_500 })).toMatchObject({ goesLive: true, at: 1_500 })
        expect(decideInService({ ...installed, firstSeenAt: 500, lastSeenAt: 900 })).toEqual({ goesLive: false, reason: 'not seen since install' })
    })
```

Insert this block directly before `describe('chooseSubscriptionLine', ...)`, with one blank line
before and after it:

```ts
describe('firstSeenSinceInstall', () => {
    it('keeps the stored first sighting however far the last one has moved on', () => {
        expect(firstSeenSinceInstall({ installCompletedAt: 1_000, firstSeenAt: 1_000, lastSeenAt: 9_000 })).toBe(1_000)
    })

    it('is the last sighting when none since the install is stored', () => {
        expect(firstSeenSinceInstall({ installCompletedAt: 1_000, lastSeenAt: 1_500 })).toBe(1_500)
        expect(firstSeenSinceInstall({ installCompletedAt: 1_000, firstSeenAt: 500, lastSeenAt: 1_500 })).toBe(1_500)
    })

    it('is none while the Asset is not seen since its install, or has no install time', () => {
        expect(firstSeenSinceInstall({ installCompletedAt: 1_000, firstSeenAt: 500, lastSeenAt: 900 })).toBeUndefined()
        expect(firstSeenSinceInstall({ installCompletedAt: 1_000 })).toBeUndefined()
        expect(firstSeenSinceInstall({ firstSeenAt: 1_200, lastSeenAt: 1_500 })).toBeUndefined()
    })
})
```

**Verify**: `npx vitest run src/server/domain/in-service.test.ts` → `4 failed | 19 passed`. The
four failures are exactly:

- `decideInService > goes live from the first sighting since the install, not from a later one`
- the three tests of `firstSeenSinceInstall`, each with `TypeError: firstSeenSinceInstall is not a function`

`passes over a first sighting kept from before the install` passes already: today's code ignores
`firstSeenAt`. If the set of failures differs, STOP.

### Step 4: Decide the go-live from the first sighting since the install

Edit `src/server/domain/in-service.ts`. Replace lines 4 to 26 (the doc comment of
`InServiceFacts` through the end of `decideInService`, quoted in "Current state") with:

```ts
/**
 * In service: an Asset installed at a Site and seen by monitoring after the install. That instant
 * starts billing for its Subscription line: the first sighting since the install, which the Asset keeps
 * (`firstSeenAt`) so that a go-live put off (its Subscription line could not be started) still starts from it.
 */
export interface InServiceFacts {
    stage: Stage | null
    installCompletedAt?: number
    /** The first sighting since the install, as stored on the Asset when an earlier sighting found one. */
    firstSeenAt?: number
    lastSeenAt?: number
    temporary: boolean
}

export type InServiceDecision =
    | { goesLive: true; at: number; stage: 'in_service' | 'temporary_deployment' }
    | { goesLive: false; reason: string }

/**
 * The first sighting since the install that the Asset's record knows of: the one stored, unless it is from before the
 * install (the install was completed again since), else the last sighting when that is since the install. Undefined
 * while the Asset has not been seen since its install, or has no install time.
 */
export function firstSeenSinceInstall(facts: Pick<InServiceFacts, 'installCompletedAt' | 'firstSeenAt' | 'lastSeenAt'>): number | undefined {
    const { installCompletedAt, firstSeenAt, lastSeenAt } = facts
    if (installCompletedAt === undefined) return undefined
    if (firstSeenAt !== undefined && firstSeenAt >= installCompletedAt) return firstSeenAt
    return lastSeenAt !== undefined && lastSeenAt >= installCompletedAt ? lastSeenAt : undefined
}

export function decideInService(facts: InServiceFacts): InServiceDecision {
    if (facts.stage !== 'pending_in_service') return { goesLive: false, reason: 'not pending in service' }
    if (facts.installCompletedAt === undefined) return { goesLive: false, reason: 'install not completed' }
    const at = firstSeenSinceInstall(facts)
    if (at === undefined) return { goesLive: false, reason: 'not seen since install' }
    return { goesLive: true, at, stage: facts.temporary ? 'temporary_deployment' : 'in_service' }
}
```

Leave the rest of the file (`seenSourceOf`, `SubscriptionLineView`, `chooseSubscriptionLine`) as
it is.

Why the last sighting is the fallback. Before a first sighting is stored, the sighting being
applied has just been written to *Last seen*, so the last sighting is the first one. An Asset
pending from before this change has no stored first sighting either, and goes live from its last
sighting since the install, as it does today.

**Verify**: `npx vitest run src/server/domain/in-service.test.ts src/server/platform/in-service.test.ts`
→ 49 passed, 0 failed (23 and 26). The platform tests pass unchanged: nothing passes `firstSeenAt`
yet.

### Step 5: Write the failing platform tests

Edit `src/server/platform/in-service.test.ts`.

Inside `describe('a seen event for a pending Asset', ...)`, insert these two tests directly before
`it('is reported busy when its go-live save is refused, its line left active, and joins that line when sent again', ...)`:

```ts
    it('goes live from its first sighting since the install when its line could only be started at a later one', () => {
        platform.refuses = (table, _row, operation) => (table === LINES && operation === 'update' ? 'line locked by finance' : '')
        applyDeviceEvents([event()])

        expect(asset()).toMatchObject({ ...stage('pending_in_service'), x_daas_ham_first_seen: SEEN })

        platform.refuses = () => ''
        expect(applyDeviceEvents([event({ observedAt: SEEN_MS + 86_400_000 })])).toEqual({ unknown: [], busy: [] })

        expect(asset()).toMatchObject({
            ...stage('in_service'),
            x_daas_ham_first_seen: SEEN,
            x_daas_ham_last_seen: '2025-11-10 09:00:00',
            x_daas_ham_in_service_date: SEEN,
            x_daas_ham_subscription_line: 'sub1',
        })
        expect(line()).toMatchObject({ status: 'active', start_date: '2025-11-09' })
    })

    it('goes live from the sighting since its install when it kept a first sighting from an earlier install', () => {
        const earlier = '2025-11-01 09:00:00'
        platform.tables[ASSETS] = [unit('pending_in_service', { x_daas_ham_first_seen: earlier, x_daas_ham_last_seen: earlier })]

        applyDeviceEvents([event()])

        expect(asset()).toMatchObject({ ...stage('in_service'), x_daas_ham_first_seen: SEEN, x_daas_ham_in_service_date: SEEN })
    })
```

Inside `describe('a sighting of an Asset already in service', ...)`, in the test `moves last seen
forward and changes nothing else`, add this line directly after the
`expect(asset()).toMatchObject({ ...stage('in_service'), x_daas_ham_last_seen: '2025-11-09 10:00:00', ...` line:

```ts
        expect(asset().x_daas_ham_first_seen ?? '').toBe('')
```

Inside `describe('the in-service detection job', ...)`, insert these two tests directly before
`it('reads any other discovery source as a connector', ...)`:

```ts
    it('puts it in service from the first discovery since its install when its line could only be started after a later one', () => {
        platform.refuses = (table, _row, operation) => (table === LINES && operation === 'update' ? 'line locked by finance' : '')
        detectPendingInService()

        expect(asset()).toMatchObject({ ...stage('pending_in_service'), x_daas_ham_first_seen: SEEN })

        platform.refuses = () => ''
        platform.tables.cmdb_ci = [discovered({ last_discovered: '2025-11-10 09:00:00' })]
        detectPendingInService()

        expect(asset()).toMatchObject({ ...stage('in_service'), x_daas_ham_last_seen: '2025-11-10 09:00:00', x_daas_ham_in_service_date: SEEN })
        expect(line()).toMatchObject({ status: 'active', start_date: '2025-11-09' })
    })

    it('puts in service, from the sighting it kept, a pending Asset whose CI shows none', () => {
        platform.tables[ASSETS] = [unit('pending_in_service', { ci: '', x_daas_ham_last_seen: SEEN, x_daas_ham_seen_source: 'nms' })]

        detectPendingInService()

        expect(asset()).toMatchObject({ ...stage('in_service'), x_daas_ham_in_service_date: SEEN, x_daas_ham_seen_source: 'nms' })
    })
```

Add no import. Every name used is already in the file.

**Verify**: `npx vitest run src/server/platform/in-service.test.ts` → `3 failed | 27 passed`. The
three failures are exactly:

- `a seen event for a pending Asset > goes live from its first sighting since the install when its line could only be started at a later one`
- `a seen event for a pending Asset > goes live from the sighting since its install when it kept a first sighting from an earlier install`
- `the in-service detection job > puts it in service from the first discovery since its install when its line could only be started after a later one`

`puts in service, from the sighting it kept, a pending Asset whose CI shows none` passes already.
It holds the behaviour of an Asset pending from before this change. If the set of failures
differs, STOP.

### Step 6: Keep the first sighting on the Asset and go live from it

Edit `src/server/platform/in-service.ts`.

On line 5, add `firstSeenSinceInstall` to the import:

```ts
import { decideInService, firstSeenSinceInstall, seenSourceOf } from '../domain/in-service.ts'
```

Insert this constant directly before `function recordSeen(` (line 21), with one blank line after
it:

```ts
/**
 * The first sighting since the Asset's install, kept while it is pending in service (domain/in-service
 * `firstSeenSinceInstall`): last_seen moves on with every sighting, so a go-live put off would otherwise start billing
 * from a later one.
 */
const FIRST_SEEN = 'x_daas_ham_first_seen'
```

In the doc comment of `goLiveIfSeen`, replace its first line

```ts
 * Put a pending Asset in service if it has been seen since its install, and save it. False when it saved nothing:
```

with these two lines:

```ts
 * Put a pending Asset in service if it has been seen since its install, from its first sighting since then, and save
 * it. False when it saved nothing:
```

In `goLiveIfSeen`, replace these six lines (lines 35 to 40):

```ts
    const decision = decideInService({
        stage,
        installCompletedAt: glideToMs(str(asset, 'x_daas_ham_install_completed')),
        lastSeenAt: glideToMs(str(asset, 'x_daas_ham_last_seen')),
        // Only a pending Asset can go live, so only it pays for the dot-walk to its Order.
        temporary: stage === 'pending_in_service' && choice<OrderType>(asset, 'x_daas_ham_order_line.order.order_type') === 'temporary',
```

with:

```ts
    const seen = {
        installCompletedAt: glideToMs(str(asset, 'x_daas_ham_install_completed')),
        firstSeenAt: glideToMs(str(asset, FIRST_SEEN)),
        lastSeenAt: glideToMs(str(asset, 'x_daas_ham_last_seen')),
    }
    if (stage === 'pending_in_service') {
        const first = firstSeenSinceInstall(seen)
        asset.setValue(FIRST_SEEN, first === undefined ? '' : msToGlide(first))
    }
    const decision = decideInService({
        stage,
        ...seen,
        // Only a pending Asset can go live, so only it pays for the dot-walk to its Order.
        temporary: stage === 'pending_in_service' && choice<OrderType>(asset, 'x_daas_ham_order_line.order.order_type') === 'temporary',
```

The closing `})` of the `decideInService` call and everything after it stay as they are. The value
set here is saved by whichever save follows: line 45's `asset.update()` when the Asset stays
pending, or `moveAndSave` when it goes live. Setting the value it already has changes nothing, so
a later sighting causes no extra save. The stage test keeps the column untouched on an Asset that
is not pending.

**Verify**:

- `npx vitest run src/server/domain/in-service.test.ts src/server/platform/in-service.test.ts` →
  53 passed, 0 failed (23 and 30).
- `grep -c "FIRST_SEEN" src/server/platform/in-service.ts` → `3`.
- `npm run typecheck` → exit 0. `npm run lint` → exit 0.

### Step 7: Update the specs, the instance check and the upgrade note

In `docs/spec/p1-fulfilment.md`, replace the four lines quoted first under "Documentation to
change" (lines 286 to 289) with:

```md
- An Asset is in service from the first sighting at or after its install completion. A temporary
  Order gives a temporary deployment instead. While it is pending in service the Asset keeps that
  sighting (*First seen since install*, `x_daas_ham_first_seen`), so a go-live that is put off
  (its Subscription line could not be started, below) still starts from it, whichever later
  sighting or detection run completes it. A value from before the install completion (an Asset
  installed again) is passed over. For a CI, the first sighting is the latest discovery the
  detection job read at its first run after the install.
- At that moment:
  - the in-service date is set to that first sighting;
```

In the same file, replace the last three lines quoted second (lines 305 to 307) with:

```md
  not applied and is returned in `busy_identifiers`; the detection job leaves that Asset to its next
  run. A go-live whose save is refused after its Subscription line was started leaves the line
  active: the sighting applied again joins it, its start date kept. That refused save stores
  nothing on the Asset, its first sighting included. The NMS sends the event again with its own
  time, but when a later sighting completes the go-live first, the in-service date is that later
  sighting.
```

In `docs/spec/p3-billing.md`, replace lines 6 and 7 (the second and third lines quoted) with:

```md
  changes opens one when the Asset enters service (in service or temporary): from its in-service
  date on first go-live (the first sighting since its install, also when the go-live was put off
  to a later sighting: fulfilment spec, *In service and billing start*), else that day (e.g. a
  missing unit found again). The same rule closes it
```

In `docs/verify-on-instance.md`, in the paragraph quoted last (lines 649 to 654), replace its last
two lines

```md
try* (warning). Delete the row, or leave it until it is abandoned, and the next sighting starts the
line.
```

with:

```md
try* (warning). The Asset's *First seen since install* (`x_daas_ham_first_seen`, added to a list
of Assets by hand) holds the time of that event. Delete the row, or leave it until it is
abandoned, and the next sighting starts the line: the Asset's *In-service date* and the line's
start date are those of the first event, not of the later sighting.
```

In `README.md`, under "### Upgrading", insert this bullet directly before the bullet that starts
`- Work through the checks marked **After an upgrade**`:

```md
- Nothing to enter for the new *First seen since install* on Assets
  (`alm_hardware.x_daas_ham_first_seen`): an Asset pending in service since before the upgrade
  has none, and goes in service from its last sighting since its install, as before.
```

**Verify**:

- `grep -c "x_daas_ham_first_seen" docs/spec/p1-fulfilment.md docs/verify-on-instance.md README.md`
  prints `1` for each of the three files.
- `grep -c "the first sighting since its install, also when the go-live was put off" docs/spec/p3-billing.md` → `1`.
- `grep -c "is in service at the first sighting" docs/spec/p1-fulfilment.md` → `0`.

### Step 8: Build, run the full gate and commit

```sh
npm run check
git status --short
git diff --stat -- src/fluent/generated/keys.ts
```

**Verify**:

- `npm run check` exits 0 (1813 tests passed at the planned-at commit, 9 more than before; more if
  other plans landed).
- `git status --short` lists only the ten in-scope files.
- `git diff --stat -- src/fluent/generated/keys.ts` shows insertions only (17 at the planned-at
  commit, no deletions), and `git diff -- src/fluent/generated/keys.ts | grep -c "element: 'x_daas_ham_first_seen'"`
  → `2`. Any other change to `keys.ts`, or any deleted line, is a STOP condition.

Commit the ten files in one commit, `src/fluent/generated/keys.ts` included, with the subject from
"Git workflow" and a body that says what was wrong and why.

## Test plan

- `src/server/domain/in-service.test.ts` (5 tests added, modelled on the `decideInService` tests
  already there):
  - the decision goes live from the stored first sighting, not from a later last sighting. This is
    the regression test for the finding;
  - a stored first sighting older than the install is passed over, and without a sighting since
    the install the Asset waits;
  - `firstSeenSinceInstall`: keeps a stored value, falls back to the last sighting, is undefined
    without an install time or a sighting since it.
- `src/server/platform/in-service.test.ts` (4 tests and 1 assertion added, modelled on the test
  `stays pending, the sighting saved, when its line cannot be started, and goes live when the event is sent again`):
  - NMS path: the line refuses to start at the first sighting, a sighting one day later goes live
    with the in-service date and the line start date of the first day;
  - an Asset that kept a first sighting from an earlier install goes live from the new one;
  - detection job path: the same put-off go-live, with the CI discovered again a day later;
  - an Asset pending with a kept *Last seen* and no first sighting goes live from it at the next
    run (the upgrade case);
  - a sighting of an Asset already in service leaves the column empty.
- The 44 existing tests stay unchanged and must pass, the refused go-live save at
  `in-service.test.ts:140` included.
- Verification: `npx vitest run src/server/domain/in-service.test.ts src/server/platform/in-service.test.ts`
  → 53 passed, 0 failed.

What the tests cannot show: the fake runs no business rule, so they do not show the Service
interval opening on the earlier date. That rests on `billingChange` reading the in-service date,
which its own tests cover, and on the instance check below.

ATF and instance checks: ATF runs on an instance only. The suites *NaaS - P1* and *NaaS - P3*
cover go-live and billing start. Run them if you have an instance, and the check edited in
`docs/verify-on-instance.md` (*Sighting lock*). If you have none, say so in your report: the new
column is created by the install, and no local test can confirm that.

## Done criteria

ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm run lint` exits 0
- [ ] The test command in the test plan reports 53 passed, 0 failed
- [ ] `npm run check` exits 0
- [ ] `grep -c "at: facts.lastSeenAt" src/server/domain/in-service.ts` prints `0`
- [ ] `grep -c "export function firstSeenSinceInstall" src/server/domain/in-service.ts` prints `1`
- [ ] `grep -c "x_daas_ham_first_seen" src/fluent/shared/platform-tables.now.ts` prints `1`
- [ ] `grep -c "element: 'x_daas_ham_first_seen'" src/fluent/generated/keys.ts` prints `2`
- [ ] `git diff main..HEAD --numstat -- src/fluent/generated/keys.ts` shows `0` deleted lines
- [ ] `git status --short` is empty and only the ten in-scope files differ from `main`
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" does not match the excerpts.
- `alm_hardware` already has a column that holds the first sighting since the install, or
  `goLiveIfSeen` already reads something other than *Last seen* for the go-live time. Another plan
  then fixed this, and a second column would disagree with it.
- Step 3 or step 5 gives a different set of failing tests than listed.
- The existing test `is reported busy when its go-live save is refused, its line left active, and
  joins that line when sent again` fails at any step. It holds the behaviour this plan leaves
  alone. Do not edit it.
- Any test fails with a message that starts with `fake Glide:`. Report the message. Do not extend
  `fake-glide.ts` under this plan.
- `npm run build` changes `src/fluent/generated/keys.ts` by more than added entries for
  `x_daas_ham_first_seen`, or deletes a line of it. Deleted keys generate delete records on the
  instance. Report the diff.
- A test in `src/server/built-metadata.test.ts` fails after the build. Report which. Do not edit
  that file.
- The fix seems to need a change to `recordSeen`, `attachToSubscription`, `billingChange` or
  `delivery.ts`.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- This moves billing start dates. Only an Asset whose go-live was put off is affected, and its
  Service interval now starts earlier, on the day of its first sighting. A reviewer from finance
  should know that such an Asset is billed for more days than before, which is what the spec
  always said.
- An interval can now start on a day in a Billing period that is already closed, when the go-live
  was put off across a month end. That already happens today when the NMS sends a refused event
  again late. This plan does not change how a closed period treats such days, and it was not
  examined here.
- The column is written only while the Asset is pending in service. After the go-live it keeps
  the first sighting of that install, which equals the in-service date. After a later install it
  holds a stale value until the next sighting, and that value is passed over because it is older
  than the install time. Do not read the column without comparing it to *Install completed*:
  call `firstSeenSinceInstall`.
- *Install completed* can be edited by hand (the column is not read-only). Moving it later than
  the stored first sighting makes that sighting count as from an earlier install.
- Any reader of the Asset can read the new column, as with *Last seen*. No ACL was added.
- Deferred: the go-live whose own Asset save is refused still loses the first sighting when a
  later, different sighting completes it. A fix needs a second, narrower save after the refused
  one. Deferred because the NMS path already recovers by sending the event again.
- Deferred: showing *First seen since install* in the workspace's list of Assets pending in
  service (`src/client/workspace/catalog.ts`). It would let staff see which pending Assets have
  been seen and are waiting on their Subscription line.
- A reviewer should check three things: that `recordSeen` is unchanged, that the column is set
  only under `stage === 'pending_in_service'`, and that `src/fluent/generated/keys.ts` only gained
  entries.
