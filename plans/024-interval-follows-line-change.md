# Plan 024: Move an Asset's Service interval when its Subscription line or Site changes in service

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 805d5da..HEAD -- src/server/platform/service-intervals.ts src/server/platform/service-intervals.test.ts src/server/entry/billing.ts src/server/entry/billing.test.ts src/server/domain/billing.ts src/server/domain/lock-names.ts src/fluent/billing/logic.now.ts docs/spec/p3-billing.md docs/adr/0009-billing-from-per-asset-service-intervals.md docs/verify-on-instance.md CONTEXT.md`
> If any of these files changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding. On a
> mismatch, treat it as a STOP condition. (Plan 023 adds tests and helpers to
> `src/server/entry/billing.test.ts`. That alone is not a mismatch.)

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/023-billing-pull-reset-export-tests.md for landing order only (both append to `src/server/entry/billing.test.ts`). No code of 023 is needed.
- **Category**: bug
- **Planned at**: commit `805d5da`, 2026-11-12

## Why this matters

Per-device Subscription lines are billed from Service intervals, and Margin is costed from them. An
interval records its Asset's Subscription line, Site and Customer once, when it opens. Only a stage
change opens or closes one. An asset manager may change a unit's Subscription line by hand, and
equipment handlers may change its Site. When they do that to a unit in service, nothing touches
the interval:

- a unit that went into service on no line and is given one later opens no interval. It is never
  billed, and the *In service without a subscription line* tile stops counting it, because it now
  has a line;
- a unit moved from line A to line B keeps billing on A, at A's rate, for as long as it is in service;
- a unit moved to another Site keeps its device-days and its Margin at the old Site.

After this plan, the rule that starts and stops billing also runs when the line or the Site
changes, and moves the interval of a unit that stays in service.

## Current state

### Who changes the line or the Site by hand

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

ADR 0005 states this as intended (`docs/adr/0005-visibility-by-before-query-rules.md:103-105`):
"the Agreement, subscription line, lease and Legal owner are changed by hand by asset managers".
`x_daas_ham_site` has no field ACL of its own, so whoever may save the Asset may change it.

The app's own code never changes the line or the Site of a unit that stays in service. It sets the
Site as a unit is shipped or installed (`src/server/platform/delivery.ts:159-162` and `:209`), sets
the line in the save that puts the unit in service (`src/server/platform/subscriptions.ts:51`), and
clears both in the save that receives it back (`src/server/platform/returns.ts:390-391`). So the
gap is hand edits, lists and the Table API.

### The one rule that opens and closes intervals

```ts
// src/fluent/billing/logic.now.ts:172-181
BusinessRule({
    $id: Now.ID['br_asset_left_service'],
    name: 'NaaS - start or stop billing on service',
    table: 'alm_hardware',
    when: 'after',
    action: ['update'],
    order: 210,
    condition: CURRENT_FLEET_STAGE_CHANGED,
    script: onAssetServiceChange,
})
```

```ts
// src/server/domain/fleet.ts:26-27 and 35-36
/** The same as a script condition on `current`, an Asset: what a business rule's or UI action's condition tests. */
export const CURRENT_IS_FLEET = `current.${FLEET_FIELD} == true`

/** A fleet asset changed its stage: the change test and the Fleet flag every stage rule on alm_hardware starts with. */
export const CURRENT_FLEET_STAGE_CHANGED = `(current.install_status.changes() || current.substatus.changes()) && ${CURRENT_IS_FLEET}`
```

```ts
// src/server/entry/billing.ts:106-115
export function onAssetServiceChange(current: ForeignRecord, previous: ForeignRecord): void {
    const change = billingChange(readStage(previous), readStage(current), {
        inServiceDate: glideToIsoDate(str(current, 'x_daas_ham_in_service_date')),
        today: todayIso(),
    })
    if (!change) return
    const lineId = str(current, 'x_daas_ham_subscription_line')
    if ('stop' in change) closeServiceIntervals(current.getUniqueValue(), change.stop)
    else if (lineId) openServiceInterval(current, lineId, change.start)
}
```

`billingChange` (`src/server/domain/lifecycle.ts:319-323`) is null when the stage is billable both
before and after, or neither. The billable stages are `in_service` and `temporary_deployment`
(`isBillable`, `lifecycle.ts:302-304`).

### How an interval is opened and closed

`src/server/platform/service-intervals.ts` (160 lines) holds it all. The parts this plan reuses:

```ts
// src/server/platform/service-intervals.ts:40-46
function underIntervalLock(assetId: string, work: (lock: HeldLock) => void): string | null {
    const attempt = attemptLock(LOCK.serviceInterval(assetId), (lock) => {
        work(lock)
    })
    if (attempt.ran) return null
    return whyNotRun(attempt, 'left to another save holding its lock, which has not finished')
}
```

```ts
// src/server/platform/service-intervals.ts:58-89
function openInterval(lock: HeldLock, asset: ForeignRecord, lineId: string, startIso: string): boolean {
    const assetId = asset.getUniqueValue()
    const place = { lineId, siteId: str(asset, 'x_daas_ham_site') }
    const latest = latestClosedInterval(assetId)
    const closed = latest && {
        record: latest,
        lineId: str(latest, 'subscription_line'),
        siteId: str(latest, 'site'),
        end: str(latest, 'end_date'),
    }
    const restart = restartInterval(closed, place, startIso)
    const reopen = 'reopen' in restart
    let interval: GlideRecord
    if (reopen) {
        interval = restart.reopen.record
        interval.setValue('end_date', '')
    } else {
        interval = new GlideRecord('x_daas_ham_service_interval')
        interval.initialize()
        interval.setValue('asset', assetId)
        interval.setValue('subscription_line', lineId)
        interval.setValue('customer', str(asset, 'company'))
        interval.setValue('site', place.siteId)
        interval.setValue('start_date', restart.start)
    }
    const opened = `${str(asset, 'serial_number')} in service from ${startIso}`
    // The save that took a lost lock over may have opened one too.
    const late = { check: 'check only one is open', level: 'error' } as const
    const saved = lock.save(`${opened}, interval opened`, () => (reopen ? interval.update() : interval.insert()), late)
    if (saved === 'refused') warnRefused(interval, `${opened}, no interval open`)
    return saved === 'saved'
}
```

```ts
// src/server/platform/service-intervals.ts:136-160
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

function openIntervals(assetId: string): GlideRecord {
    const interval = new GlideRecord('x_daas_ham_service_interval')
    interval.addQuery('asset', assetId)
    interval.addNullQuery('end_date')
    interval.query()
    return interval
}
```

The rule that decides how billing restarts, which this plan relies on and does not change:

```ts
// src/server/domain/billing.ts:46-63
interface IntervalPlace {
    lineId: string
    siteId: string
}

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

What reads the interval's line and Site: billing groups a line's intervals by Site
(`src/server/platform/billing.ts:238-258`, query `subscription_lineIN...`), and Margin attributes
costs by them. The dashboard tile counts only a unit with no line
(`src/server/domain/billing.ts:102` and `:108`, `x_daas_ham_subscription_lineISEMPTY`).

The lock both use, and its place in the lock order (ADR 0013: a holder only takes locks declared
later in `LOCK` than those it holds):

```ts
// src/server/domain/lock-names.ts:87-95
    /** A pending Subscription line is started under it: nothing is taken under it. */
    subscriptionLine: (lineId: string) => named(`subscription_line_${lineId}`),
    /** The open and the close of an Asset's Service interval take turns under it. */
    serviceInterval: (assetId: string) => named(`service_interval_${assetId}`),
    /**
     * A Billing period's Close and Regenerate take turns under it, each reading its status afresh, and a fee's waiver
     * takes it under the fee's lock so that it never lands inside a Close: nothing is taken under it.
     */
    billingPeriod: (periodId: string) => named(`billing_period_${periodId}`),
```

### Decisions already made (do not reopen them)

1. **One rule, not two.** The existing rule's condition is widened to the two fields, and its one
   function decides. Two rules could both fire on one save (a go-live changes the stage and the
   line together, a receipt changes the stage and clears the line and the Site), and each would
   then open or close an interval. With one rule a save is handled once. It also needs no new
   Fluent record and no new entry point.
2. **The old line bills the day of the move.** The spec says of an interval's first and last day
   "Both days are billed", and `restartInterval` already says what happens when a unit is at two
   places on one day: the interval "elsewhere makes the new interval start the day after it ends".
   A move is that case. So the interval at the old line or Site ends today, and the one at the new
   line and Site starts tomorrow. No day is billed twice, and none of the existing date rules
   changes. A unit that had no interval open (its first line) starts today.
3. **The move reads the Asset afresh under the lock** and makes the open interval match the line
   and Site the Asset has then. It does not use the values of the save that triggered it. Two such
   saves at once then leave the interval where the later save put the Asset, whichever rule runs
   last, and running the move twice changes nothing more.
4. **An interval that has not started yet is removed, not ended.** After a move today, the new
   interval starts tomorrow. If the unit is moved again today, that interval has billed no day.
   Ending it would bill one day on a line the unit left before the day began (`intervalEnd` never
   ends an interval before its start). So it is deleted, and the move goes on from the interval
   before it. A move taken back the same day then reopens the first interval as it was.

### Constraints on the rule (README.md "Development", `src/server/built-metadata.test.ts`)

- `alm_hardware` is another scope's table and also holds the Provider IT's equipment. A rule on it
  starts its condition with the change test and tests the Fleet flag right after it, before anything
  else. The test holds every rule on `alm_hardware` to that:

  ```ts
  // src/server/built-metadata.test.ts:378-382
          for (const { name, condition } of onSaves) {
              const [change, fleet] = andTerms(condition ?? '')
              expect({ name, change: /\.changes\(\)/.test(change ?? '') }).toEqual({ name, change: true })
              expect({ name, fleet }).toEqual({ name, fleet: CURRENT_IS_FLEET.replace(/\s+/g, '') })
          }
  ```

  So the condition must have the form `(<change tests joined by ||>) && current.x_daas_ham_fleet == true`.
- A condition fits the 254 characters of its field. The new one is 188 characters.
- A function wired to a rule on `alm_hardware` takes its record as a `ForeignRecord`
  (`src/server/platform/records.ts:120-122`) and is listed in `ON_FOREIGN_TABLES`
  (`built-metadata.test.ts:317-331`), which the test compares with what the built rules call.
  `onAssetServiceChange` is listed already. This plan adds no new function wired from Fluent, so
  that list does not change.
- A `.now.ts` file holds constants, template literals over constants and imports of constants. No
  function call, loop or spread. The new condition is a template literal over `CURRENT_IS_FLEET`,
  as the condition of the rack rule `br_rack_placement_model` is (`src/fluent/racks/racks.now.ts:42-53`).
- The rule's name stays as it is (39 characters; the limit is 40).
- `npm run build` rewrites the tracked `src/fluent/generated/keys.ts`. This plan adds no Fluent
  record, so the build must leave it unchanged.

### Other conventions that apply (AGENTS.md)

- Layers: `src/server/domain/` is pure. `platform/` holds the Glide services and never imports
  `entry/`. `entry/` holds thin adapters.
- A relative import in `src/server` names the `.ts` file (`./records.ts`). A `.now.ts` import is
  written without it.
- A test is a `*.test.ts` file beside its module, on `src/server/test-support/fake-glide.ts`, which
  runs no business rule: a test calls `onAssetServiceChange(current, previous)` itself.
- Use the words of `CONTEXT.md`: Asset, Subscription line, Site, Service interval, Customer.
- `npx vitest run <path>` needs no build. `npm test` needs `npm run build` first
  (`src/server/built-metadata.test.ts` checks that `dist/app` is fresh). `npm run check` does both.
- When documented behaviour changes, the spec, ADR or README line changes in the same commit.

### Documentation that describes today's behaviour

```md
<!-- docs/spec/p3-billing.md:5-12 -->
- **Service intervals** record the days each Asset delivered a Subscription line. A rule on stage
  changes opens one when the Asset enters service (in service or temporary): from its in-service
  date on first go-live, else that day (e.g. a missing unit found again). The same rule closes it
  the day the Asset leaves service (a Return order, declared missing, a manual move). Both days are
  billed. An Asset back in service on or before the day its interval on the same line closed gets
  that interval reopened, so no day is billed twice. The rule also runs when the stage change clears
  the Asset's Subscription line, so the interval still closes.
- The rule opens or reopens the interval under a job lock on the Asset (`LOCK.serviceInterval` in
```

```md
<!-- docs/adr/0009-billing-from-per-asset-service-intervals.md:7-9 -->
interval is opened and closed by one rule on stage changes into and out of a billable stage, so every
path (first go-live, a missing unit found again, a Return order, declared missing, a manual move)
starts or stops billing without each caller having to remember. Site packages are billed from
```

```md
<!-- CONTEXT.md:266-268 -->
**Service interval**:
The days one Asset delivered a Subscription line, from the day it went in service to the day it left service.
_Avoid_: usage, billable period
```

`docs/verify-on-instance.md` has the section `### Returns and site packages` (line 776), which ends
with an `**After an upgrade:**` list, followed by `### Replacement SLA stop` (line 812).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Lint | `npm run lint` | exit 0 |
| This plan's tests | `npx vitest run src/server/platform/service-intervals.test.ts src/server/entry/billing.test.ts` | all pass |
| Build | `npm run build` | exit 0; rewrites `dist/` |
| Built-metadata checks | `npx vitest run src/server/built-metadata.test.ts` (after a build) | all pass |
| Full gate | `npm run check` | exit 0, all tests pass |

## Scope

**In scope** (the only files you should modify):

- `src/server/domain/billing.ts` (export one interface, with a doc comment)
- `src/server/platform/service-intervals.ts`
- `src/server/platform/service-intervals.test.ts`
- `src/server/entry/billing.ts` (only `onAssetServiceChange` and two import lines)
- `src/server/entry/billing.test.ts` (imports, and one `describe` appended)
- `src/fluent/billing/logic.now.ts` (one import, and the condition of one rule)
- `src/server/domain/lock-names.ts` (one comment)
- `docs/spec/p3-billing.md`
- `docs/adr/0009-billing-from-per-asset-service-intervals.md`
- `docs/verify-on-instance.md`
- `CONTEXT.md` (one line)

**Out of scope** (do NOT touch, even though they look related):

- `openServiceInterval`, `openHolding`, `openInterval`, `closeServiceIntervals`, `closeHolding` and
  `underIntervalLock` in `service-intervals.ts`. The move calls them. Their behaviour for a stage
  change must not change.
- `restartInterval`, `intervalEnd` and `billingChange`. The date rules stay as they are.
- `src/server/domain/fleet.ts`. `CURRENT_FLEET_STAGE_CHANGED` is still used by the rules in
  `src/fluent/fleet/logic.now.ts` and `src/fluent/orders/logic.now.ts`.
- `src/server/built-metadata.test.ts`. No new entry point is wired, so `ON_FOREIGN_TABLES` stays.
- `src/fluent/generated/keys.ts`. No Fluent record is added, so it must not change.
- A second business rule, a new lock name, a new ACL, or an ATF test.
- A dashboard tile for units in service whose open interval is missing or on another line. Deferred
  (see "Maintenance notes").
- `docs/adr/0013-margin-recomputes-supersede-under-a-job-lock.md`. No lock is added and the lock
  order does not change: the move takes `service_interval_` where the opening and the closing take
  it, in the after rule of an Asset's save.
- A repair of intervals already on the wrong line on an installed instance. The plan documents how
  to find them. It ships no script.

## Git workflow

- Branch: `advisor/024-interval-follows-line-change`, from `main`.
- One commit. Subject in the repo's style, an imperative sentence under 72 characters, for example
  `Move a unit's Service interval when its line or Site changes`. The body says what was wrong and
  why (a line or Site changed in service left the interval on the old one: unbilled units, billing
  on the old line, Margin at the old Site).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Branch and confirm the baseline

```sh
git checkout main && git checkout -b advisor/024-interval-follows-line-change
npx vitest run src/server/platform/service-intervals.test.ts src/server/entry/billing.test.ts
```

**Verify**: 0 failed. At the planned-at commit: 2 passed in `service-intervals.test.ts` and 10 in
`entry/billing.test.ts` (24 if plan 023 landed). Note the number for `entry/billing.test.ts`: the
steps below call it N.

### Step 2: Name where an Asset is billed

In `src/server/domain/billing.ts`, replace the line `interface IntervalPlace {` (line 46) with:

```ts
/** Where an Asset in service is billed: the Subscription line it delivers ('' for none) and its Site. A Service interval records both once, as it opens. */
export interface IntervalPlace {
```

Change nothing else in that file.

**Verify**: `npm run typecheck` → exit 0.

### Step 3: Add the move to the platform service, with its tests

Edit `src/server/platform/service-intervals.ts`.

Replace line 2 with:

```ts
import { intervalEnd, restartInterval, type IntervalPlace } from '../domain/billing.ts'
```

Insert this block directly above the line `function openIntervals(assetId: string): GlideRecord {`
(line 154), followed by one blank line:

```ts
/**
 * Move the billing of an Asset in service to the Subscription line and Site it has now, after a save that changed
 * either and left it in service: an interval records both once, as it opens, so the open one names the old ones. The
 * interval at the old place ends on `todayIso`, which it bills as any last day, and the one at the new place starts the
 * day after (restartInterval), so no day is billed twice; an Asset that had no interval open starts on `todayIso`, and
 * one left without a line gets none. Under the Asset's interval lock, with the Asset read afresh there, so two such
 * saves at once leave the interval where the later one put the Asset, whichever runs last. A save that finds the lock
 * held tries again, then leaves the move to the holder; an interval still elsewhere when it gives up is logged as an
 * error, to move by hand.
 */
export function moveServiceInterval(assetId: string, todayIso: string): void {
    const why = underIntervalLock(assetId, (lock) => moveHolding(lock, assetId, todayIso))
    if (why === null) return
    const asset = findById('alm_hardware', assetId, { beyondVisibility: true })
    if (!asset || !isBillable(readStage(asset)) || billedAt(assetId, placeOf(asset))) return
    const unmoved = `${str(asset, 'serial_number')} changed its Subscription line or Site on ${todayIso}, its Service interval not moved`
    log.error(`${unmoved}: ${why}; move it by hand if it is still on the old one`)
}

function placeOf(asset: ForeignRecord): IntervalPlace {
    return { lineId: str(asset, 'x_daas_ham_subscription_line'), siteId: str(asset, 'x_daas_ham_site') }
}

function isAt(interval: GlideRecord, place: IntervalPlace): boolean {
    return str(interval, 'subscription_line') === place.lineId && str(interval, 'site') === place.siteId
}

/** Whether the Asset's open intervals are what `place` asks for: one there when it names a line, and none elsewhere. */
function billedAt(assetId: string, place: IntervalPlace): boolean {
    const interval = openIntervals(assetId)
    let there = false
    while (interval.next()) {
        if (!isAt(interval, place)) return false
        there = true
    }
    return there || !place.lineId
}

/**
 * Move the open interval holding `lock`. An Asset out of service by now has what is open closed, as the close of the
 * save that took it out would. An interval the platform refuses to end stays open and none is opened beside it, which
 * would bill the Asset twice.
 */
function moveHolding(lock: HeldLock, assetId: string, todayIso: string): void {
    const asset = findById('alm_hardware', assetId, { beyondVisibility: true })
    if (!asset || !isBillable(readStage(asset))) return closeHolding(lock, assetId, todayIso)
    const place = placeOf(asset)
    const serial = str(asset, 'serial_number')
    const interval = openIntervals(assetId)
    let there = false
    let left = false
    while (interval.next()) {
        if (isAt(interval, place)) {
            there = true
            continue
        }
        if (!lock.held()) return
        if (!leaveInterval(interval, todayIso)) return void warnRefused(interval, `${serial} changed its Subscription line or Site on ${todayIso}, its Service interval not moved`)
        left = true
    }
    // The save that took a lost lock over may have moved the interval too.
    if (left && lock.lostAfter(`${serial} interval ended at its old line or Site`, { check: 'check only one is open, at the line and Site the Asset has', level: 'error' })) return
    if (!there && place.lineId) openInterval(lock, asset, place.lineId, todayIso)
}

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

Every other import the block needs (`isBillable`, `readStage`, `findById`, `str`, `warnRefused`,
`log`, `HeldLock`, `ForeignRecord`, `GlideRecord`) is in the file already.

Edit `src/server/platform/service-intervals.test.ts`.

Replace the line `import { closeServiceIntervals } from './service-intervals.ts'` with:

```ts
import { LOCK } from '../domain/lock-names.ts'
import { closeServiceIntervals, moveServiceInterval } from './service-intervals.ts'
```

Append this block to the end of the file, after one blank line:

```ts
describe('moving the billing of an Asset in service', () => {
    const LOCKS = 'x_daas_ham_job_lock'
    const TODAY = '2025-11-09'
    const TOMORROW = '2025-11-10'

    /** The Asset in service, as stored after the save that changed its line or Site. */
    const inService = (fields: Row = {}): Row => ({ ...assetIn('in_service'), company: 'acme', x_daas_ham_subscription_line: 'sub1', x_daas_ham_site: 'site1', ...fields })
    const stored = (id: string, lineId: string, start: string, end: string, siteId = 'site1'): Row => ({ sys_id: id, asset: 'asset1', subscription_line: lineId, site: siteId, start_date: start, end_date: end })
    /** Each interval as [Subscription line, Site, first day, last day], in the order stored. */
    const billed = () => (platform.tables[INTERVALS] ?? []).map((row) => [row.subscription_line, row.site, row.start_date, row.end_date ?? ''])

    beforeEach(() => {
        platform.tables[INTERVALS] = [stored('int1', 'sub1', '2025-10-01', '')]
    })

    it('ends the interval on the old line today and starts one on the new line tomorrow, so the day is billed once', () => {
        platform.tables[ASSETS] = [inService({ x_daas_ham_subscription_line: 'sub2' })]

        moveServiceInterval('asset1', TODAY)

        expect(billed()).toEqual([
            ['sub1', 'site1', '2025-10-01', TODAY],
            ['sub2', 'site1', TOMORROW, ''],
        ])
        expect(platform.tables[INTERVALS]?.[1]).toMatchObject({ asset: 'asset1', customer: 'acme' })
        expect(platform.tables[LOCKS]).toEqual([])
    })

    it('does the same for an Asset moved to another Site on its line', () => {
        platform.tables[ASSETS] = [inService({ x_daas_ham_site: 'site2' })]

        moveServiceInterval('asset1', TODAY)

        expect(billed()).toEqual([
            ['sub1', 'site1', '2025-10-01', TODAY],
            ['sub1', 'site2', TOMORROW, ''],
        ])
    })

    it('starts an interval today for an Asset given its first line while in service', () => {
        platform.tables[INTERVALS] = []
        platform.tables[ASSETS] = [inService()]

        moveServiceInterval('asset1', TODAY)

        expect(billed()).toEqual([['sub1', 'site1', TODAY, '']])
    })

    it('ends the interval of an Asset left without a line, and starts none', () => {
        platform.tables[ASSETS] = [inService({ x_daas_ham_subscription_line: '' })]

        moveServiceInterval('asset1', TODAY)

        expect(billed()).toEqual([['sub1', 'site1', '2025-10-01', TODAY]])
    })

    it('leaves the interval of an Asset already billed where it is alone, however often it runs', () => {
        platform.tables[ASSETS] = [inService({ x_daas_ham_subscription_line: 'sub2' })]

        moveServiceInterval('asset1', TODAY)
        moveServiceInterval('asset1', TODAY)

        expect(billed()).toEqual([
            ['sub1', 'site1', '2025-10-01', TODAY],
            ['sub2', 'site1', TOMORROW, ''],
        ])
    })

    it('takes back a move made earlier the same day: the interval not yet started is removed and the old one reopened', () => {
        platform.tables[INTERVALS] = [stored('int1', 'sub1', '2025-10-01', TODAY), stored('int2', 'sub2', TOMORROW, '')]
        platform.tables[ASSETS] = [inService()]

        moveServiceInterval('asset1', TODAY)

        expect(billed()).toEqual([['sub1', 'site1', '2025-10-01', '']])
    })

    it('bills no day on a line the Asset was moved to and off again the same day', () => {
        platform.tables[INTERVALS] = [stored('int1', 'sub1', '2025-10-01', TODAY), stored('int2', 'sub2', TOMORROW, '')]
        platform.tables[ASSETS] = [inService({ x_daas_ham_subscription_line: 'sub3' })]

        moveServiceInterval('asset1', TODAY)

        expect(billed()).toEqual([
            ['sub1', 'site1', '2025-10-01', TODAY],
            ['sub3', 'site1', TOMORROW, ''],
        ])
    })

    it('closes what is open for an Asset that has left service since, and starts nothing', () => {
        platform.tables[ASSETS] = [{ ...inService({ x_daas_ham_subscription_line: 'sub2' }), ...assetIn('pending_return') }]

        moveServiceInterval('asset1', TODAY)

        expect(billed()).toEqual([['sub1', 'site1', '2025-10-01', TODAY]])
    })

    it('starts no second interval when the platform refuses to end the old one, and says so', () => {
        platform.tables[ASSETS] = [inService({ x_daas_ham_subscription_line: 'sub2' })]
        platform.refuses = (table, _row, operation) => (table === INTERVALS && operation === 'update' ? 'no' : '')

        moveServiceInterval('asset1', TODAY)

        expect(billed()).toEqual([['sub1', 'site1', '2025-10-01', '']])
        expect(platform.warnings).toEqual([`[x_daas_ham] FOC111 changed its Subscription line or Site on ${TODAY}, its Service interval not moved: no`])
    })

    it('logs an interval left on the old line when another save holds its lock through every try', () => {
        platform.tables[ASSETS] = [inService({ x_daas_ham_subscription_line: 'sub2' })]
        platform.tables[LOCKS] = [{ sys_id: 'held', name: LOCK.serviceInterval('asset1'), sys_created_on: '2025-11-09 12:00:00' }]

        moveServiceInterval('asset1', TODAY)

        expect(billed()).toEqual([['sub1', 'site1', '2025-10-01', '']])
        expect(platform.logs).toContainEqual(
            `error [x_daas_ham] FOC111 changed its Subscription line or Site on ${TODAY}, its Service interval not moved: left to another save holding its lock, which has not finished; move it by hand if it is still on the old one`,
        )
    })
})
```

The file's own `beforeEach` leaves the fake's clock at its start, 2025-11-09 12:00 UTC, which is why
the lock row in the last test is not taken as abandoned. A logged line starts with `[x_daas_ham] `
(`src/server/platform/log.ts`).

**Verify**: `npx vitest run src/server/platform/service-intervals.test.ts` → 12 passed.

### Step 4: Write the failing tests of the rule's function

Edit `src/server/entry/billing.test.ts`.

In the import from `'./billing.ts'`, add the name `onAssetServiceChange`. Directly after the line
`import { EVENT } from '../domain/events.ts'`, add:

```ts
import { fieldsOf, type Stage } from '../domain/lifecycle.ts'
```

Append this block to the end of the file, after one blank line:

```ts
describe('a save of a fleet asset', () => {
    const ASSETS = 'alm_hardware'
    const INTERVALS = 'x_daas_ham_service_interval'
    const TODAY = '2026-11-11'

    function unit(stage: Stage, fields: Row = {}): Row {
        const { installStatus, substatus } = fieldsOf(stage)
        return {
            sys_id: 'a1',
            serial_number: 'FOC111',
            company: 'acme',
            install_status: installStatus,
            substatus: substatus ?? '',
            x_daas_ham_subscription_line: 'sub1',
            x_daas_ham_site: 'site1',
            ...fields,
        }
    }

    /** Run the rule as the platform does after a save that took the Asset from `before` to `after`. */
    function saved(before: Row, after: Row): void {
        platform.tables[ASSETS] = [after]
        onAssetServiceChange(recordOf(ASSETS, after), recordOf(ASSETS, before))
    }

    /** Each interval as [Subscription line, Site, first day, last day], in the order stored. */
    const billed = () => rows(INTERVALS).map((row) => [row.subscription_line, row.site, row.start_date, row.end_date ?? ''])

    beforeEach(() => {
        platform.references = { ...platform.references, [`${INTERVALS}.asset`]: ASSETS }
        platform.tables[INTERVALS] = [{ sys_id: 'int1', asset: 'a1', subscription_line: 'sub1', site: 'site1', start_date: '2026-10-01', end_date: '' }]
    })

    it('moves the interval of a unit in service whose Subscription line was changed by hand', () => {
        saved(unit('in_service'), unit('in_service', { x_daas_ham_subscription_line: 'sub2' }))

        expect(billed()).toEqual([
            ['sub1', 'site1', '2026-10-01', TODAY],
            ['sub2', 'site1', '2026-11-12', ''],
        ])
    })

    it('moves it when only the Site changed, and when the stage changed between two stages in service too', () => {
        saved(unit('in_service'), unit('temporary_deployment', { x_daas_ham_site: 'site2' }))

        expect(billed()).toEqual([
            ['sub1', 'site1', '2026-10-01', TODAY],
            ['sub1', 'site2', '2026-11-12', ''],
        ])
    })

    it('starts billing a unit in service the day it is given a line', () => {
        platform.tables[INTERVALS] = []

        saved(unit('in_service', { x_daas_ham_subscription_line: '' }), unit('in_service'))

        expect(billed()).toEqual([['sub1', 'site1', TODAY, '']])
    })

    it('leaves the interval alone of a unit billed where it already is, and of one that is not in service', () => {
        saved(unit('in_service'), unit('in_service', { asset_tag: 'P-1' }))
        saved(unit('available'), unit('available', { x_daas_ham_subscription_line: 'sub2' }))

        expect(billed()).toEqual([['sub1', 'site1', '2026-10-01', '']])
    })

    it('opens one interval, from the in-service date, for a go-live that attaches the line in the same save', () => {
        platform.tables[INTERVALS] = []

        saved(unit('pending_in_service', { x_daas_ham_subscription_line: '' }), unit('in_service', { x_daas_ham_in_service_date: '2026-11-09 08:00:00' }))

        expect(billed()).toEqual([['sub1', 'site1', '2026-11-09', '']])
    })

    it('closes the interval, and opens none, for a save that takes the unit out of service and clears its line and Site', () => {
        saved(unit('in_service'), unit('pending_evaluation', { x_daas_ham_subscription_line: '', x_daas_ham_site: '' }))

        expect(billed()).toEqual([['sub1', 'site1', '2026-10-01', TODAY]])
    })
})
```

The file's `beforeEach` sets the clock to `2026-11-11T12:00:00Z`, so today is 2026-11-11 and
tomorrow 2026-11-12.

**Verify**: `npx vitest run src/server/entry/billing.test.ts` → `3 failed | N+3 passed`. The three
failures are exactly:

- `a save of a fleet asset > moves the interval of a unit in service whose Subscription line was changed by hand`
- `a save of a fleet asset > moves it when only the Site changed, and when the stage changed between two stages in service too`
- `a save of a fleet asset > starts billing a unit in service the day it is given a line`

Each fails because the interval is where it was. That is the bug. If the set of failures differs,
STOP.

### Step 5: Let the rule's function move the interval

Edit `src/server/entry/billing.ts`.

Replace the line `import { billingChange } from '../domain/lifecycle.ts'` with:

```ts
import { billingChange, isBillable } from '../domain/lifecycle.ts'
```

Replace the line `import { closeServiceIntervals, openServiceInterval } from '../platform/service-intervals.ts'` with:

```ts
import { closeServiceIntervals, moveServiceInterval, openServiceInterval } from '../platform/service-intervals.ts'
```

Replace the whole function `onAssetServiceChange` (lines 106-115) with:

```ts
/**
 * A save of a fleet asset that changed its stage, its Subscription line or its Site. One that takes it into or out of
 * service starts or stops its billing. One that leaves it in service (on another line or none, at another Site, or in
 * the other stage in service) moves its Service interval to the line and Site it has now.
 */
export function onAssetServiceChange(current: ForeignRecord, previous: ForeignRecord): void {
    const today = todayIso()
    const change = billingChange(readStage(previous), readStage(current), {
        inServiceDate: glideToIsoDate(str(current, 'x_daas_ham_in_service_date')),
        today,
    })
    const lineId = str(current, 'x_daas_ham_subscription_line')
    if (!change) {
        if (isBillable(readStage(current))) moveServiceInterval(current.getUniqueValue(), today)
    } else if ('stop' in change) closeServiceIntervals(current.getUniqueValue(), change.stop)
    else if (lineId) openServiceInterval(current, lineId, change.start)
}
```

The function does not compare the old and the new line itself. The move finds an interval that is
already at the Asset's line and Site and leaves it alone, so a save that changed neither (a unit
moved between *in service* and *temporary deployment*) costs one lock and two reads and changes
nothing.

**Verify**: `npx vitest run src/server/entry/billing.test.ts` → N+6 passed, 0 failed. Then
`npm run typecheck` → exit 0 and `npm run lint` → exit 0.

### Step 6: Run the rule on a change of the line or the Site

Edit `src/fluent/billing/logic.now.ts`.

Replace the line `import { CURRENT_FLEET_STAGE_CHANGED } from '../../server/domain/fleet'` (line 18)
with:

```ts
import { CURRENT_IS_FLEET } from '../../server/domain/fleet'
```

Replace the last `BusinessRule` of the file (`br_asset_left_service`, lines 172-181) with:

```ts
// A Service interval records the Asset's Subscription line and Site once, as it opens, so the rule runs on a change of
// either as well as of the stage: a unit in service moved to another line or Site by hand has its interval moved.
BusinessRule({
    $id: Now.ID['br_asset_left_service'],
    name: 'NaaS - start or stop billing on service',
    table: 'alm_hardware',
    when: 'after',
    action: ['update'],
    order: 210,
    condition:
        `(current.install_status.changes() || current.substatus.changes() || current.x_daas_ham_subscription_line.changes() || current.x_daas_ham_site.changes()) && ${CURRENT_IS_FLEET}`,
    script: onAssetServiceChange,
})
```

The `$id`, the name, the table, `when`, `action`, `order` and `script` do not change.

```sh
npm run build
git status --short src/fluent/generated/keys.ts
npx vitest run src/server/built-metadata.test.ts
grep -l "x_daas_ham_subscription_line.changes() || current.x_daas_ham_site.changes()" dist/app/update/sys_script_*.xml | wc -l
```

**Verify**: the build exits 0. `git status --short src/fluent/generated/keys.ts` prints nothing.
The built-metadata tests all pass (75 at the planned-at commit). The `grep` prints `1`.

### Step 7: Change the comment and the documents

In `src/server/domain/lock-names.ts`, replace the comment line above `serviceInterval` (line 89) with:

```ts
    /** The open, the close and the move of an Asset's Service interval take turns under it. */
```

In `docs/spec/p3-billing.md`, insert this bullet between the line that ends
`the Asset's Subscription line, so the interval still closes.` (line 11) and the line that starts
`- The rule opens or reopens the interval under a job lock on the Asset` (line 12):

```md
- A Service interval records its Asset's Subscription line and Site once, as it opens. So the rule
  also runs when the Subscription line or the Site of a fleet asset is changed, and moves the
  interval of a unit that stays in service (an asset manager may change a unit's line by hand, ADR
  0005). The interval at the old line or Site ends that day, which it bills as any last day. The
  interval at the new line and Site starts the day after, so no day is billed twice. A unit in
  service given its first line gets an interval from that day. One whose line is cleared has its
  interval ended and none opened, and the *In service without a subscription line* tile counts it.
  An interval that has not started yet (it starts the day after an earlier move that day) has
  billed no day: it is removed, not ended, so a move taken back the same day leaves the first
  interval open as it was. The move takes the Asset's job lock as the opening and the closing do,
  and reads the Asset afresh under it, so two such saves at once leave the interval at the line
  and Site the Asset has. A move that cannot take the lock leaves it to the holder, and logs an
  error if the interval is then still elsewhere. An interval the platform refuses to end is logged
  as a warning, and no second one is opened beside it. A change of the Asset's company alone moves
  nothing: an interval keeps the Customer it opened with.
```

In `docs/adr/0009-billing-from-per-asset-service-intervals.md`, replace lines 7-9 (quoted in
"Current state") with:

```md
interval is opened and closed by one rule on stage changes into and out of a billable stage, so every
path (first go-live, a missing unit found again, a Return order, declared missing, a manual move)
starts or stops billing without each caller having to remember. The same rule moves the interval of
a unit that stays in service when its Subscription line or Site is changed, since an interval
records both as it opens: the old one ends that day and one at the new line and Site starts the day
after. Site packages are billed from
```

In `CONTEXT.md`, replace the definition line of **Service interval** (line 267) with:

```md
The days one Asset delivered a Subscription line at a Site, from the day it went in service or was moved there to the day it left service or was moved elsewhere.
```

In `docs/verify-on-instance.md`, insert this section directly above the line
`### Replacement SLA stop`, with one blank line before and after it:

```md
### Subscription line or Site changed in service

As an asset manager, open a fleet asset in service that has an open Service interval, and change
its *Subscription line* to another line of its Agreement. The open interval gets today as its *Last
day*, and a new interval on the new line and the Asset's Site is created with tomorrow as its
*First day*. Change the line back the same day: the new interval is gone and the first one is open
again. Clear the line: the open interval ends today and none is created. Change the *Site* of a
unit in service: its interval moves the same way. With a row named `service_interval_<Asset
sys_id>` in *Job lock* ([how a job lock behaves](#how-a-job-lock-behaves)), the same change leaves
the interval where it was and logs *[x_daas_ham] <serial> changed its Subscription line or Site on
<date>, its Service interval not moved: ...* (error).

**After an upgrade:** a unit whose line or Site was changed in service before this release still
has its open interval on the old one. List open Service intervals (*Last day* empty) whose
*Subscription line* or *Site* differs from their Asset's. For each, set its *Last day* and create
the interval at the line and Site the Asset has now. List fleet assets in service that have a
Subscription line and no open Service interval, and create theirs.
```

**Verify**:

- `grep -c "the close and the move of an Asset's Service interval" src/server/domain/lock-names.ts` → `1`
- `grep -c "A Service interval records its Asset's Subscription line and Site once" docs/spec/p3-billing.md` → `1`
- `grep -c "The same rule moves the interval of" docs/adr/0009-billing-from-per-asset-service-intervals.md` → `1`
- `grep -c "or was moved there to the day it left service" CONTEXT.md` → `1`
- `grep -c "### Subscription line or Site changed in service" docs/verify-on-instance.md` → `1`

### Step 8: Run the full gate and commit

```sh
npm run check
git status --short
```

**Verify**: `npm run check` exits 0 and the test run reports 16 more passed tests than before this
plan (1820 in 113 files at the planned-at commit, 1837 if plan 023 landed). `git status --short`
lists exactly the eleven in-scope files. `src/fluent/generated/keys.ts` is not among them.

Commit the eleven files in one commit, with the subject from "Git workflow" and a body that says
what was wrong and why.

## Test plan

- `src/server/platform/service-intervals.test.ts`, 10 new tests in one `describe`, modelled on the
  two tests already in that file (same fake, same `assetIn` helper):
  - a move to another line: old interval ends today, new one starts tomorrow, with the Asset's
    Customer, and the lock is released;
  - a move to another Site on the same line;
  - a first line given in service: an interval from today;
  - a line cleared: the interval ends and none opens;
  - running the move twice changes nothing more;
  - a move taken back the same day: the interval not yet started is removed and the old one reopened;
  - a second move the same day: no day on the line in between;
  - an Asset that left service since: what is open is closed, nothing opened;
  - a refused end: no second interval, and a warning;
  - the lock held by another save through every try: nothing moved, and an error logged.
- `src/server/entry/billing.test.ts`, 6 new tests in one `describe`, modelled on the tests already
  in that file (`recordOf` for `current` and `previous`):
  - the regression this plan fixes, three ways: the line changed, the Site changed (with a move
    between the two stages in service), the first line given;
  - nothing changes for a unit already billed where it is, nor for a unit not in service;
  - a go-live that attaches the line in the same save still opens one interval from the in-service date;
  - a save that takes the unit out of service and clears its line and Site still only closes.
- Verification: `npx vitest run src/server/platform/service-intervals.test.ts src/server/entry/billing.test.ts`
  → 0 failed (12 and N+6).

What the tests cannot show: the fake runs no business rule. The tests call the rule's function as
the platform would. That the built condition fires on a hand edit of the line or the Site, and
that a fresh read in an after rule sees the saved values, can only be confirmed on an instance.
The fake is single-threaded too, so two saves at once are not run.

Local and instance checks: every done criterion below is local. The instance check is the new
section of `docs/verify-on-instance.md` (step 7). It is the final proof of this fix and it is not
run by this plan. Say in your report that it was not run, unless you ran it.

## Done criteria

ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm run lint` exits 0
- [ ] The test command in the test plan reports 0 failed, and the 16 new tests are among those passed
- [ ] `npm run check` exits 0
- [ ] `grep -c "export function moveServiceInterval" src/server/platform/service-intervals.ts` prints `1`
- [ ] `grep -c "moveServiceInterval(current.getUniqueValue(), today)" src/server/entry/billing.ts` prints `1`
- [ ] `grep -c "CURRENT_FLEET_STAGE_CHANGED" src/fluent/billing/logic.now.ts` prints `0`
- [ ] `grep -c "BusinessRule(" src/fluent/billing/logic.now.ts` prints `5` (no rule added)
- [ ] `git diff --stat main..HEAD -- src/fluent/generated/keys.ts src/server/built-metadata.test.ts src/server/domain/fleet.ts` prints nothing
- [ ] The five `grep -c` checks of step 7 each print `1`
- [ ] `git status --short` is empty and only the eleven in-scope files differ from `main`
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" does not match the excerpts.
- Step 4 gives a different set of failing tests than the three listed.
- A test that existed before this plan fails at any step. The open and the close for a stage change
  must behave as before.
- `npx vitest run src/server/built-metadata.test.ts` fails after step 6. Report the test name and
  message. The likely ones are the Fleet flag test (the condition's second `&&` term must be exactly
  `current.x_daas_ham_fleet == true`) and the 254-character limit.
- `npm run build` leaves `src/fluent/generated/keys.ts` modified. Report the diff. A rule was added
  or renamed by mistake.
- The fix seems to need a second business rule, a new function wired from Fluent, or a change to
  `src/server/built-metadata.test.ts`.
- You find code of the app that saves the Subscription line or the Site of a unit that stays in
  service while it holds a `billing_period_` lock or a job's own lock (`LOCK.job`). Those are
  declared after `serviceInterval` in `src/server/domain/lock-names.ts`, so the move's take of
  `service_interval_` under them would break the lock order of ADR 0013. Search with
  `grep -rn "x_daas_ham_subscription_line'\|x_daas_ham_site'" src/server/platform src/server/entry | grep setValue`.
  At the planned-at commit that lists `delivery.ts` (two lines), `returns.ts` (two lines) and
  `subscriptions.ts` (one line), each in a save that also moves the unit into or out of service or
  is made before it is in service, and one line of `customer-page.ts` that only reads the Site.
- A test fails with a message that starts with `fake Glide:`. Report the message. Do not extend
  `fake-glide.ts` under this plan.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- The move makes the open interval match the Asset as stored. It runs on every save that changes
  the line or the Site of a unit in service, and on a move between *in service* and *temporary
  deployment*. On a unit whose interval was already on the wrong line before this release, the
  next such save puts it right.
- Deferred, with the reason: a *Billing integrity* tile for units in service whose open interval is
  missing or on another line. A tile is one encoded filter on one table
  (`src/client/workspace/dashboard.ts`). This count needs Assets with no matching row in
  `x_daas_ham_service_interval`, which takes a related-list query that the tests' encoded-query
  evaluator does not know. The lists in the new `docs/verify-on-instance.md` section find the same
  units by hand.
- Known limits, not changed here:
  - A unit moved today and taken out of service today: its new interval starts tomorrow, and the
    close ends it on its start day (`intervalEnd` never ends an interval before it started), so one
    day is billed on the new line. The same already happens today to a unit that leaves service,
    returns elsewhere and leaves again on one day. Removing an interval that has not started when
    its unit leaves service would fix both. It changes `closeHolding` and the spec, so it needs its
    own plan.
  - A unit given its first line in service and moved to another line the same day: the first line
    bills that day, because its interval started today.
  - A unit attached by hand to a *Pending* Subscription line gets its interval, but billing skips
    pending lines (`status!=pending` in `src/server/platform/billing.ts:144`) and only a go-live
    starts a line (`src/server/platform/subscriptions.ts:64-82`). Its *Start date* is read-only on
    the form. Such a unit is not billed and no tile counts it.
  - A change of the Asset's company alone is not followed. The interval keeps its Customer.
- Plan 025 (`plans/025-ended-line-needs-end-date.md`) edits `docs/spec/p3-billing.md` and
  `docs/verify-on-instance.md` too, in other places. It expects this plan to have landed first.
- A reviewer should check four things: that the condition keeps the Fleet flag as its second `&&`
  term; that `openServiceInterval`, `closeServiceIntervals` and the functions they call are
  unchanged in the diff; that `src/fluent/generated/keys.ts` is unchanged; and that the day rule in
  the spec bullet (old line bills the day of the move, new line from the day after) is the one the
  tests assert.
