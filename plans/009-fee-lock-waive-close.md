# Plan 009: Waive a fee under its lock and its Billing period's lock, so a waiver never lands inside a Close

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 1864b17..HEAD -- src/server/platform/fees.ts src/server/platform/billing.ts src/server/platform/returns.ts src/server/platform/locks.ts src/server/domain/lock-names.ts src/server/entry/billing.test.ts docs/adr/0013-margin-recomputes-supersede-under-a-job-lock.md docs/spec/p3-billing.md docs/spec/p2-aftersales.md docs/verify-on-instance.md`
> Plan 008 lands before this one and changes `lock-names.ts` (three new entries after
> `oemCoverageRun`), ADR 0013 (three new paragraphs), `returns.ts` (`chaseOverdue` only) and
> `docs/verify-on-instance.md` (one new section). Those changes are expected. For anything else that
> changed, compare the "Current state" excerpts against the live code before proceeding. On a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/001-lint-tracked-sources.md (so `npm run lint` is a usable gate), plans/008-job-run-locks.md (both edit `domain/lock-names.ts` and ADR 0013; 008 goes first)
- **Category**: bug
- **Planned at**: commit `1864b17`, 2026-11-12

## Why this matters

When a unit that was declared missing is scanned in at the depot, its open lost-asset fee is waived:
the Customer must not pay for a unit that came back. A Billing period bills that fee. Its
generation puts the fee on the period under the fee's job lock, and *Close period* takes waived fees
off the period, saves the period closed and marks the remaining fees billed under the period's job
lock. The waiver is the only writer of a fee's status that takes no lock. So a waiver that commits
while a Close runs can end in two wrong states:

- (a) The waiver lands after the Close took the waived fees off and before it saved the period. The
  fee reads *waived*, but its line stays on the closed, locked bill. The Customer is billed and the
  records disagree.
- (b) The waiver lands while the Close marks the fees billed. The Close's save overwrites it. The
  fee reads *billed* and nobody is told a waiver was lost.

Confidence is medium: this comes from reading the code. The in-memory Glide used by the tests is
single-threaded, so the overlap cannot be run for real.

After this plan the waiver takes the fee's lock and, for a fee on a period, the period's lock. It
then lands wholly before a Close (which removes the fee and its line) or wholly after it (when it
finds the period closed and leaves the fee as billed). A waiver that cannot be made is logged as an
error that says what to do by hand. The records never disagree.

## Current state

### Files and their roles

- `src/server/platform/fees.ts`: charges and waives Fee events. `waiveOpenFees` is the unlocked writer.
- `src/server/platform/returns.ts`: the only caller of `waiveOpenFees` (line 410), in a depot receipt.
- `src/server/platform/billing.ts`: generation (`billOnPeriod`) and Close (`closeReady`,
  `dropWaivedFeeLines`, `markFeesBilled`). Read-only for this plan.
- `src/server/domain/lock-names.ts`: every lock name, declared in the lock order.
- `src/server/platform/locks.ts`: `attemptLock`, `whyNotRun`.
- `docs/adr/0013-margin-recomputes-supersede-under-a-job-lock.md`: who takes which lock under what.

### The unlocked waiver and its caller

```ts
// src/server/platform/fees.ts:77-87
/** Waive the not-yet-billed charges of `identity`. */
export function waiveOpenFees(identity: FeeIdentity): void {
    const fee = new GlideRecord(FEE)
    fee.addEncodedQuery(openFeeQuery(identity))
    fee.query()
    while (fee.next()) {
        fee.setValue('status', FEE_STATUS.waived)
        // Left open, it is billed for a unit that came back.
        if (!fee.update()) warnRefused(fee, `${identity.type} fee ${fee.getUniqueValue()} not waived`)
    }
}
```

```ts
// src/server/platform/returns.ts:408-413
    if (turnedUp) {
        // Declared missing, then found: it is late, not lost, and its line needs evaluating again.
        waiveOpenFees({ type: 'lost', assetId: asset.getUniqueValue(), returnOrderId: returnOrder.getUniqueValue() })
        returnOrder.setValue('state', TASK_STATE.workInProgress)
        if (!returnOrder.update()) warnRefused(returnOrder, `${str(returnOrder, 'number')} not reopened for ${serial}`)
    }
```

That call runs inside a depot receipt, which holds the unit's `receive_asset_<Asset sys_id>` lock
and no other (`src/server/platform/receiving.ts:125`).

The imports of `fees.ts` today. `attemptLock`, `whyNotRun`, `log`, `findById`, `str`, `warnRefused`
and `LOCK` are already there:

```ts
// src/server/platform/fees.ts:1-9
import { GlideRecord } from '@servicenow/glide'
import { chargedFeeQuery, type FeeIdentity, openFeeQuery } from '../domain/fees.ts'
import type { HeldLock } from '../domain/job-lock.ts'
import { LOCK } from '../domain/lock-names.ts'
import { FEE_STATUS, type FeeType } from '../domain/vocabulary.ts'
import { todayIso } from './clock.ts'
import { attemptLock, whyNotRun } from './locks.ts'
import { log } from './log.ts'
import { exists, findById, num, str, warnRefused } from './records.ts'
```

### What the waiver races

Generation bills a fee under the fee's lock, from a fresh read. This is the pattern the waiver copies:

```ts
// src/server/platform/billing.ts:380-392
function billOnPeriod(fee: GlideRecord, periodId: string, addLine: (fee: GlideRecord) => void): FeeBilling {
    const attempt = attemptLock(LOCK.fee(feeIdentityOf(fee)), (): FeeBilling => {
        const current = findById(FEE, fee.getUniqueValue())
        if (!current || !billableOn(current, periodId)) return 'left'
        addLine(current)
        const unlinked = putOnPeriod(current, periodId)
        return unlinked ? { failed: `fee not linked to the period: ${unlinked}` } : 'billed'
    })
    if (attempt.ran) return attempt.value
    const now = findById(FEE, fee.getUniqueValue())
    if (!now || !billableOn(now, periodId)) return 'left'
    return { failed: whyNotRun(attempt, 'another run held its lock through every try') }
}
```

A Close runs wholly under the period's lock (`closePeriod` calls `takingTurns`, which calls
`closeReady`):

```ts
// src/server/platform/billing.ts:420-427
function takingTurns(period: GlideRecord, undone: string, act: (stored: GlideRecord) => PeriodOutcome): PeriodOutcome {
    const attempt = attemptLock(LOCK.billingPeriod(period.getUniqueValue()), (): PeriodOutcome => {
        const stored = findById(PERIOD, period.getUniqueValue())
        return stored ? act(stored) : { done: false, why: `${str(period, 'period')} ${undone}: the period is gone` }
    })
    if (attempt.ran) return attempt.value
    return { done: false, why: `${str(period, 'period')} ${undone}: ${whyNotRun(attempt, 'a Close or Regenerate of it is running; try again')}` }
}
```

Inside it, the three steps a waiver can land between:

```ts
// src/server/platform/billing.ts:540-553
    const stuck = dropWaivedFeeLines(period)
    if (stuck.length > 0) {
        const named = stuck.slice(0, 3).join('; ') + (stuck.length > 3 ? `; and ${stuck.length - 3} more` : '')
        return { done: false, why: `${name} not closed, as ${stuck.length} waived fee(s) could not leave it: ${named}. Fix them and Close again` }
    }
    // Always: finance may have adjusted lines during review, and the locked total must match the locked lines.
    setTotals(period)
    period.setValue('status', BILLING_PERIOD_STATUS.closed)
    period.setValue('closed_at', nowGlide())
    period.setValue('closed_by', gs.getUserID())
    // Closed first: a refused form save (the platform says why) leaves its fees open, so a Regenerate still bills them.
    if (!period.update()) return { done: false, refusedSave: true }
    const unmarked = markFeesBilled(period)
    if (unmarked.length === 0) return { done: true }
```

```ts
// src/server/platform/billing.ts:563-568
function markFeesBilled(period: GlideRecord): string[] {
    const refused: string[] = []
    visitInKeyOrder(FEE, feesOnPeriod(period.getUniqueValue(), FEE_STATUS.open), (fee) => {
        fee.setValue('status', FEE_STATUS.billed)
        if (!fee.update()) refused.push(`${feeLabel(fee)}: ${refusal(fee)}`)
    })
```

### The lock order, and why the fix fits it

`LOCK` declares the locks in the one order they may be taken in. A holder only takes locks
declared after those it holds. Locks are not re-entrant and a take never waits (ADR 0013). The two
entries this plan uses, at the planned-at commit (each is 6 lines further down once plan 008 has
landed):

```ts
// src/server/domain/lock-names.ts:67-72
    /**
     * One per fee identity. Charging checks the fee and inserts it under it (platform/fees `recordFee`), and a period's
     * generation reads it afresh, adds its line and saves it (platform/billing `billOnPeriod`): each tries again while the
     * other holds it for that long.
     */
    fee: (fee: FeeIdentity) => named(`fee_${fee.type}_${fee.assetId}_${fee.returnOrderId}`),
```

```ts
// src/server/domain/lock-names.ts:84-85
    /** A Billing period's Close and Regenerate take turns under it, each reading its status afresh: nothing is taken under it. */
    billingPeriod: (periodId: string) => named(`billing_period_${periodId}`),
```

`receiveAsset` is declared before `fee`, and `fee` before `billingPeriod`. So a receipt that holds
`receive_asset_` may take `fee_`, and under it `billing_period_`. That is the chain this plan adds:

`receive_asset_<Asset>` (the receipt, already held) → `fee_<identity>` → `billing_period_<period>`

The design decision, and the alternative that was rejected:

- The waiver takes the fee's lock and reads the open charges under it. That excludes a generation
  that is putting the fee on a period, so the waiver knows for certain whether the fee is on a
  period. For a fee on a period it then takes the period's lock under the fee's and reads the
  period's status. A Close holds that lock from before it takes the waived fees off until after it
  marked the fees billed, so the waiver lands before the Close or after it, never inside.
- Rejected: taking the fee's lock in the Close (`markFeesBilled`). The Close holds
  `billing_period_`, which is declared after `fee`, so the Close may not take `fee_` without
  reordering `LOCK`. And the fee's lock alone does not close case (a): the fee lock says nothing
  about a Close that is between its two steps.
- So `billing.ts` is not changed. The Close needs no fee lock once every waiver of a fee on its
  period takes the period's lock.

The ADR paragraphs that describe the two locks today (each is 18 lines further down once plan 008
has landed):

```md
<!-- docs/adr/0013-margin-recomputes-supersede-under-a-job-lock.md:170-182 -->
A fee is charged under `fee_<type>_<Asset sys_id>_<Return order sys_id>`, and a billing generation
bills it under the same lock: it reads the fee afresh there and adds its line and links it only
while it is open and on no other period, so a month generating beside a *Regenerate* of another
never bills one fee on both. The generation holds no other lock when it takes it, tries `LOCK_TRIES`
times
back to back, and counts a fee held through them as failed unless another period has it by then.
Nothing is taken under it.
*Close period* and *Regenerate* of a Billing period run under `billing_period_<period sys_id>`,
holding no other lock, and each reads the period's status afresh there. So a Regenerate never
deletes the lines of a period Close is locking, and Close never locks a period a Regenerate has
emptied. Each tries `LOCK_TRIES` times back to back, and one that finds the lock held through them
changes
nothing and asks the user to try again. Nothing is taken under it.
```

### Facts the fix relies on (checked at the planned-at commit)

- `waiveOpenFees` has one caller, `returns.ts:410`, which holds `receive_asset_` only.
- No before-query visibility rule covers `x_daas_ham_billing_period`
  (`src/server/domain/visibility.ts` does not name the table), so the depot user's session reads a
  period by id.
- `attemptLock(name, work)` tries `LOCK_TRIES` (5) times back to back and returns `{ ran: true,
  value }`, or `{ ran: false, held: true }` when the lock was held through every try, or `{ ran:
  false, held: false, error }` when taking it threw. `whyNotRun(attempt, held)` turns the last two
  into a reason string (`src/server/platform/locks.ts:55-65`).
- The fake Glide calls `platform.onSave(table, row, operation)` just before a row is stored. A test
  uses it to make another transaction's write land in the middle of a save. The existing test
  `leaves the period to the Close running on it` in `src/server/entry/billing.test.ts:198-214` does
  exactly that and is the model for the new Close test.

### Conventions that apply (README.md "Development")

- A test is a `*.test.ts` file beside the module it tests. A platform test runs against
  `src/server/test-support/fake-glide.ts` and mocks Glide with
  `vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)`.
  The fake throws `fake Glide: ...` on anything it does not know. It runs no business rule.
- A relative import in `src/server` names the `.ts` file (ESLint enforces it).
- Every stored choice value comes from `domain/vocabulary.ts` (`FEE_STATUS`, `BILLING_PERIOD_STATUS`).
- Log through `platform/log.ts` (`log.error`, `log.warn`), never `gs` directly. A refused save is
  logged with `warnRefused`.
- `src/server/built-metadata.test.ts` fails when a file under `src/server` is newer than `dist/app`.
  Run `npm run build` before the full test run.
- Comments only for a non-obvious why.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Lint | `npm run lint` | exit 0 (needs plan 001; before it, use `npx eslint src`) |
| This plan's tests | `npx vitest run src/server/platform/fees.test.ts src/server/entry/billing.test.ts` | all pass |
| Tests around it | `npx vitest run src/server/platform/returns.test.ts src/server/platform/receiving.test.ts src/server/domain/lock-names.test.ts` | all pass |
| Build | `npm run build` | exit 0; rewrites `dist/` |
| Full gate | `npm run check` | exit 0; all tests pass |

## Scope

**In scope** (the only files you should modify):

- `src/server/platform/fees.ts` (only `waiveOpenFees`, two new helpers, one import, one constant)
- `src/server/platform/fees.test.ts` (create)
- `src/server/entry/billing.test.ts` (one import, one new `describe`)
- `src/server/domain/lock-names.ts` (two doc comments only)
- `docs/adr/0013-margin-recomputes-supersede-under-a-job-lock.md`
- `docs/spec/p3-billing.md`
- `docs/spec/p2-aftersales.md`
- `docs/verify-on-instance.md`

**Out of scope** (do NOT touch, even though they look related):

- `src/server/platform/billing.ts`. The Close and the generation stay as they are. See "The lock
  order, and why the fix fits it".
- The order of the entries in `LOCK`. Do not move `billingPeriod` or `fee`.
- `src/server/platform/returns.ts`. The call site keeps calling `waiveOpenFees(identity)` and
  ignores what comes of it.
- `recordFee` and `chargeHolding` in `fees.ts`.
- A retry of a waiver that could not be made (a queued event). It is deferred, see "Maintenance notes".
- A fee's status edited by hand on its form. Staff edits take no lock and are not part of this plan.

## Git workflow

- Branch: `advisor/009-fee-lock-waive-close`, from `main` with plan 008 merged.
- One commit. Subject in the repo's style, an imperative sentence under 72 characters, for example
  `Waive a fee under its lock and its Billing period's`. The body says what was wrong (the two
  interleavings with a Close) and why the waiver takes the period's lock instead of the Close
  taking the fee's.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Branch and confirm the starting point

```sh
git checkout main && git checkout -b advisor/009-fee-lock-waive-close
grep -c "overdueReturnsRun" src/server/domain/lock-names.ts
grep -rn "waiveOpenFees(" src/server --include=*.ts | grep -v "\.test\.ts"
grep -c "x_daas_ham_billing_period" src/server/domain/visibility.ts
npx vitest run src/server/entry/billing.test.ts src/server/platform/returns.test.ts
```

**Verify**:

- the first `grep` prints `1` (plan 008 has landed). If it prints `0`, STOP;
- the second prints exactly two lines: the definition in `platform/fees.ts` and the call in
  `platform/returns.ts`. Any other caller is a STOP condition;
- the third prints `0` (`grep -c` exits 1 when it counts nothing, which is expected here). Anything
  else is a STOP condition;
- the vitest run reports 0 failed.

### Step 2: Write the failing tests

Create `src/server/platform/fees.test.ts` with exactly this content:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FeeIdentity } from '../domain/fees.ts'
import { LOCK } from '../domain/lock-names.ts'
import { waiveOpenFees } from './fees.ts'
import { platform, type Row } from '../test-support/fake-glide.ts'

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

const FEES = 'x_daas_ham_fee_event'
const PERIODS = 'x_daas_ham_billing_period'
const LOCKS = 'x_daas_ham_job_lock'

const LOST: FeeIdentity = { type: 'lost', assetId: 'a1', returnOrderId: 'ret1' }

const rows = (table: string): Row[] => platform.tables[table] ?? []
const errors = () => platform.logs.filter((line) => line.startsWith('error '))

/** The open lost fee of a1 on ret1, on the Billing period `periodId` ('' for none). */
function charged(periodId = ''): void {
    platform.tables[FEES] = [{ sys_id: 'fee1', fee_type: 'lost', asset: 'a1', return_order: 'ret1', status: 'open', billing_period: periodId }]
}

/** Another transaction holds the lock `name`, taken just now. */
function held(name: string): void {
    rows(LOCKS).push({ sys_id: `lock${rows(LOCKS).length}`, name, sys_created_on: '2026-11-11 12:00:00' })
}

beforeEach(() => {
    platform.reset()
    platform.clock = Date.parse('2026-11-11T12:00:00Z')
    platform.uniqueKeys = { [LOCKS]: 'name' }
    platform.tables[LOCKS] = []
    platform.tables[PERIODS] = [
        { sys_id: 'p9', period: '2026-09', status: 'closed' },
        { sys_id: 'p10', period: '2026-10', status: 'ready' },
    ]
})

describe('waiving the lost fee of a unit that turned up', () => {
    it('waives an open charge on no Billing period, and lets its lock go', () => {
        charged()

        waiveOpenFees(LOST)

        expect(rows(FEES)[0]?.status).toBe('waived')
        expect(rows(LOCKS)).toEqual([])
        expect(platform.logs).toEqual([])
    })

    it('waives a charge on a period ready for review, and leaves it on the period for its Close to take off', () => {
        charged('p10')

        waiveOpenFees(LOST)

        expect(rows(FEES)[0]).toMatchObject({ status: 'waived', billing_period: 'p10' })
        expect(rows(LOCKS)).toEqual([])
    })

    it('leaves a charge on a closed period open, and says to credit it', () => {
        charged('p9')

        waiveOpenFees(LOST)

        expect(rows(FEES)[0]?.status).toBe('open')
        expect(errors()).toEqual([expect.stringContaining('Billing period 2026-09 bills it and is closed')])
        expect(rows(LOCKS)).toEqual([])
    })

    it('leaves the charge open while a generation holds its lock, and says so', () => {
        charged()
        held(LOCK.fee(LOST))

        waiveOpenFees(LOST)

        expect(rows(FEES)[0]?.status).toBe('open')
        expect(errors()).toEqual([expect.stringContaining('a run billing it holds its lock')])
    })

    it("leaves a charge open while its period's lock is held by a Close or Regenerate, and says so", () => {
        charged('p10')
        held(LOCK.billingPeriod('p10'))

        waiveOpenFees(LOST)

        expect(rows(FEES)[0]?.status).toBe('open')
        expect(errors()).toEqual([expect.stringContaining("its Billing period's lock is held")])
        expect(rows(LOCKS).map((lock) => lock.name)).toEqual([LOCK.billingPeriod('p10')])
    })
})
```

In `src/server/entry/billing.test.ts`, add this import directly below the existing
`import { generateNewPeriod } from '../platform/billing.ts'` line (line 3):

```ts
import { waiveOpenFees } from '../platform/fees.ts'
```

and insert this block directly above the line
`describe('Close and Regenerate of one period at once', () => {`, with one blank line after it:

```ts
describe('a fee waived while its period is being closed', () => {
    it('stays open for the Close to mark billed, as its line is on the closed bill, and is logged to credit', () => {
        Object.assign(fee('fee1') ?? {}, { return_order: 'ret1' })
        generate('2026-09')
        let scanned = false
        platform.onSave = (table, row) => {
            if (table !== PERIOD || row.status !== 'closed' || scanned) return
            scanned = true
            // The missing unit is scanned in at the depot while the Close saves the period, after it took the waived fees off.
            waiveOpenFees({ type: 'lost', assetId: 'a1', returnOrderId: 'ret1' })
        }

        expect(close(period('2026-09'))).toEqual(closed('2026-09'))

        expect(scanned).toBe(true)
        expect(fee('fee1')).toMatchObject({ status: 'billed', billing_period: periodRow('2026-09')?.sys_id })
        expect(linesOf('2026-09').map((line) => line.fee_event).filter(Boolean)).toEqual(['fee1'])
        expect(platform.logs).toContainEqual(expect.stringContaining("lost fee fee1 not waived: its Billing period's lock is held"))
    })
})
```

**Verify**: `npx vitest run src/server/platform/fees.test.ts src/server/entry/billing.test.ts`
→ 4 failed, every other test passed (`4 failed | 11 passed` at the planned-at commit). The four
failures are exactly:

- `waiving the lost fee of a unit that turned up > leaves a charge on a closed period open, and says to credit it`
- `waiving the lost fee of a unit that turned up > leaves the charge open while a generation holds its lock, and says so`
- `waiving the lost fee of a unit that turned up > leaves a charge open while its period's lock is held by a Close or Regenerate, and says so`
- `a fee waived while its period is being closed > stays open for the Close to mark billed, as its line is on the closed bill, and is logged to credit`

The last one is case (a) from "Why this matters": on the current code the fee ends *waived* with
its line on the closed period. If the set of failures differs, STOP.

### Step 3: Waive under the locks

Edit `src/server/platform/fees.ts`. Three changes.

Change the vocabulary import (line 5) to:

```ts
import { BILLING_PERIOD_STATUS, FEE_STATUS, type FeeType } from '../domain/vocabulary.ts'
```

Add the period table's name directly below `const FEE = 'x_daas_ham_fee_event'` (line 16):

```ts
const PERIOD = 'x_daas_ham_billing_period'
```

Replace the whole of `waiveOpenFees`, from its doc comment to its closing brace (lines 77-87, the
end of the file), with exactly this:

```ts
/**
 * Waive the not-yet-billed charges of `identity`. A generation puts a charge on its Billing period under the fee's lock,
 * and a Close takes waived charges off its period and marks the open ones billed under the period's (ADR 0013). So the
 * charges are read under the fee's lock, and one on a period is waived under that period's lock too, only while the
 * period is not closed: a waiver saved in the middle of a Close would stay on the closed bill, or be overwritten as
 * billed. A charge left open is billed for a unit that came back, so it is logged as an error to settle by hand.
 */
export function waiveOpenFees(identity: FeeIdentity): void {
    const attempt = attemptLock(LOCK.fee(identity), () => {
        const fee = new GlideRecord(FEE)
        fee.addEncodedQuery(openFeeQuery(identity))
        fee.query()
        while (fee.next()) waiveHolding(fee, `${identity.type} fee ${fee.getUniqueValue()}`)
    })
    if (attempt.ran) return
    const why = whyNotRun(attempt, 'a run billing it holds its lock')
    log.error(`${identity.type} fee of Asset ${identity.assetId} on Return order ${identity.returnOrderId} not waived: ${why}; waive it by hand`)
}

/** Waive the open charge `fee`, read holding its lock: under its Billing period's lock too when it is on one. */
function waiveHolding(fee: GlideRecord, what: string): void {
    const periodId = str(fee, 'billing_period')
    if (!periodId) return saveWaived(fee, what)
    const attempt = attemptLock(LOCK.billingPeriod(periodId), () => {
        const period = findById(PERIOD, periodId)
        if (!period || str(period, 'status') !== BILLING_PERIOD_STATUS.closed) return saveWaived(fee, what)
        log.error(`${what} not waived: Billing period ${str(period, 'period')} bills it and is closed; credit it by hand`)
    })
    if (attempt.ran) return
    const why = whyNotRun(attempt, "its Billing period's lock is held (a Close, a Regenerate or another waiver)")
    log.error(`${what} not waived: ${why}; waive it by hand, or credit it if its period is closed by then`)
}

function saveWaived(fee: GlideRecord, what: string): void {
    fee.setValue('status', FEE_STATUS.waived)
    if (!fee.update()) warnRefused(fee, `${what} not waived`)
}
```

How it works, so a detail that differs can be judged:

- The query for the open charges runs inside the fee's lock. That is the fresh read: every charge
  of one identity shares one lock.
- A charge on no period is waived at once. A generation that comes later finds it waived and
  leaves it.
- A charge on a period is waived under that period's lock, and only while the period is not
  closed. A Close that comes later takes the waived charge and its line off the period
  (`dropWaivedFeeLines`).
- A charge on a closed period is left open. Its line is on the locked bill. A Close that is still
  marking fees cannot be running then, because it would hold the lock.
- A refused save is still logged with `warnRefused`, as before. The three new outcomes are logged
  with `log.error`, because a fee left open is billed for a unit that came back.

**Verify**: `npx vitest run src/server/platform/fees.test.ts src/server/entry/billing.test.ts`
→ 0 failed (`15 passed` at the planned-at commit). Then
`npx vitest run src/server/platform/returns.test.ts src/server/platform/receiving.test.ts src/server/domain/lock-names.test.ts`
→ 0 failed.

### Step 4: Update the two lock comments

In `src/server/domain/lock-names.ts`, replace the doc comment of `fee` (quoted under "Current
state") with:

```ts
    /**
     * One per fee identity. Charging checks the fee and inserts it under it (platform/fees `recordFee`), and a period's
     * generation reads it afresh, adds its line and saves it (platform/billing `billOnPeriod`): each tries again while the
     * other holds it for that long. A waiver reads the open charges and waives them under it (platform/fees
     * `waiveOpenFees`), taking the lock of the Billing period a charge is on under it: the only lock taken under it.
     */
```

and the doc comment of `billingPeriod` with:

```ts
    /**
     * A Billing period's Close and Regenerate take turns under it, each reading its status afresh, and a fee's waiver
     * takes it under the fee's lock so that it never lands inside a Close: nothing is taken under it.
     */
```

Change no code line and no order in that file.

**Verify**: `git diff --stat -- src/server/domain/lock-names.ts` shows one file changed, and
`git diff -- src/server/domain/lock-names.ts | grep -E "^[+-] +[a-zA-Z]+: \("` prints nothing (no
entry line was added, removed or moved).

### Step 5: Update ADR 0013, the specs and the instance checklist

In `docs/adr/0013-margin-recomputes-supersede-under-a-job-lock.md`, make two replacements. The
sentence `Nothing is taken under it.` occurs twice, so match each together with the text before it.

First, in the fee paragraph, replace

```md
back to back, and counts a fee held through them as failed unless another period has it by then.
Nothing is taken under it.
```

with

```md
back to back, and counts a fee held through them as failed unless another period has it by then.
A waiver (a unit declared missing is scanned in at the depot) takes the same lock, under the unit's
`receive_asset_` lock, and reads the fee's open charges afresh there. A charge on no Billing period
is waived at once. For a charge on a period, the waiver takes that period's `billing_period_` lock
under the fee's, the only lock taken under a fee's, and waives the charge only while the period is
not closed. Each of the two takes is tried `LOCK_TRIES` times back to back. A charge whose lock or
whose period's lock is held through them, or whose period is closed, stays open and is logged as an
error, to waive by hand or to credit.
```

Second, in the Billing period paragraph, replace

```md
nothing and asks the user to try again. Nothing is taken under it.
```

with

```md
nothing and asks the user to try again. A fee's waiver takes the lock too, under the fee's lock
(above), so it lands wholly before a Close, which then takes the waived fee and its line off the
period, or after it, when it finds the period closed and leaves the fee as the Close billed it. A
waiver saved in the middle of a Close would otherwise stay on the closed bill (saved after the Close
took the waived fees off) or be overwritten as billed (saved while the Close marks the fees billed).
Nothing is taken under it.
```

In `docs/spec/p3-billing.md`, add this bullet directly after the bullet that starts
`- *Close period* and *Regenerate* of one period take turns under a job lock on it` and ends
`asks the user to try again.` (lines 65-70), before the bullet `- A period's month is entered as`:

```md
- A lost-asset fee is waived when its unit turns up at the depot (P2 after-sales). The waiver takes
  the fee's job lock and, once the fee is on a period, that period's lock too (ADR 0013), so it
  never lands inside a *Close period*. A fee waived before the Close leaves the period with its line
  when the period closes. A fee whose period is closed, or whose lock or period's lock is held
  through `LOCK_TRIES` tries (a generation billing it, a Close or Regenerate running), stays open
  and is logged as an error (*<type> fee <sys_id> not waived: ...*): waive it by hand while its
  period is open, or credit it once the period is closed.
```

In `docs/spec/p2-aftersales.md`, replace (lines 135-136)

```md
  - a unit declared missing that turns up settles its line again: the open lost-asset fee is
    waived, the late-return fee applies, and the Return order reopens for evaluation.
```

with

```md
  - a unit declared missing that turns up settles its line again: the open lost-asset fee is
    waived, the late-return fee applies, and the Return order reopens for evaluation. A fee on a
    Billing period that is closed, or that is being closed or regenerated just then, is not waived:
    it stays open and is logged as an error, to settle by hand (P3 billing, ADR 0013).
```

In `docs/verify-on-instance.md`, in the section `### Fee event and service interval locks`, the
last sentence ends `(warning) and records no fee.` (line 645). Add this directly after it, in the
same paragraph:

```md
A row named `billing_period_<sys_id of a period ready for review>` keeps the lost fee of a missing
unit open when the unit is scanned in at the depot while that fee is on the period: the unit is
received as usual, and the log shows *[x_daas_ham] lost fee <sys_id> not waived: its Billing
period's lock is held (a Close, a Regenerate or another waiver); waive it by hand, or credit it if
its period is closed by then* (error). Delete the row and set the fee to *Waived* by hand.
```

**Verify**:

- `grep -c "Nothing is taken under it\." docs/adr/0013-margin-recomputes-supersede-under-a-job-lock.md` → `1`
- `grep -c "the only lock taken under a fee's" docs/adr/0013-margin-recomputes-supersede-under-a-job-lock.md` → `1`
- `grep -c "A lost-asset fee is waived when its unit turns up" docs/spec/p3-billing.md` → `1`
- `grep -c "is not waived:" docs/spec/p2-aftersales.md` → `1`
- `grep -c "billing_period_<sys_id of a period ready for review>" docs/verify-on-instance.md` → `1`

### Step 6: Run the full gate and commit

```sh
npm run check
git status --short
```

**Verify**: `npm run check` exits 0. `git status --short` lists only the eight in-scope files. If
`src/fluent/generated/keys.ts` shows as modified, see the STOP conditions.

Commit the eight files in one commit, with the subject from "Git workflow" and a body that says
what was wrong and why.

## Test plan

- `src/server/platform/fees.test.ts` (new, 5 tests), modelled on
  `src/server/platform/returns.test.ts` (a held lock is a seeded row in `x_daas_ham_job_lock`):
  - an open charge on no period is waived, and no lock is left;
  - a charge on a period ready for review is waived and stays on the period for its Close;
  - a charge on a closed period stays open, with an error naming the period;
  - a charge whose fee lock is held stays open, with an error;
  - a charge whose period's lock is held stays open, with an error, and the held lock is untouched.
- `src/server/entry/billing.test.ts` (1 test added), modelled on `leaves the period to the Close
  running on it` in the same file: a waiver that arrives while the Close saves the period leaves the
  fee open, the Close marks it billed, its line stays, and the lost waiver is logged.
- Verification: `npx vitest run src/server/platform/fees.test.ts src/server/entry/billing.test.ts`
  → 0 failed, the 6 new tests among those passed.

What the tests can and cannot show. The fake Glide is single-threaded. The tests show that the
waiver takes both locks, reads afresh under them, skips a closed period, and gives way to a held
lock with an error. The Close test replays one real interleaving through the `onSave` hook. No test
can show that two transactions on an instance exclude each other. That rests on the unique index
behind the lock table, which every other lock of the app already relies on.

Local and instance checks: every done criterion below is local. The instance check is the sentence
added to `docs/verify-on-instance.md` (a *Job lock* row made by hand, then a depot scan). It is
optional for handing the work back. Say in your report whether it was run.

## Done criteria

ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm run lint` exits 0
- [ ] `npx vitest run src/server/platform/fees.test.ts src/server/entry/billing.test.ts` reports 0 failed, with the 6 new tests passed
- [ ] `npm run check` exits 0
- [ ] `grep -c "attemptLock(LOCK.fee(identity)" src/server/platform/fees.ts` prints `1` and `grep -c "attemptLock(LOCK.billingPeriod(periodId)" src/server/platform/fees.ts` prints `1`
- [ ] `git diff --stat main..HEAD -- src/server/platform/billing.ts src/server/platform/returns.ts src/fluent` prints nothing
- [ ] `grep -c "Nothing is taken under it\." docs/adr/0013-margin-recomputes-supersede-under-a-job-lock.md` prints `1`
- [ ] `git status --short` is empty and only the eight in-scope files differ from `main`
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Plan 008 has not landed (step 1's first check prints `0`).
- The code at the locations in "Current state" does not match the excerpts, beyond what plan 008
  changed.
- In `LOCK`, `receiveAsset` is no longer declared before `fee`, or `fee` no longer before
  `billingPeriod`. The nested takes of this plan are legal only in that order.
- `waiveOpenFees` has a caller other than `returns.ts` `settleReceivedLine`, or that caller now
  runs while holding a `fee_` or `billing_period_` lock, or any lock declared after `fee` in `LOCK`.
  A nested take would then be refused or break the lock order.
- `closeReady` in `billing.ts` no longer runs wholly inside `takingTurns` (the removal of waived
  fees, the save of the period and `markFeesBilled` must all happen under the period's lock). The
  fix depends on that.
- `src/server/domain/visibility.ts` names `x_daas_ham_billing_period`. The waiver reads the period
  in the depot user's session. A visibility rule could hide a closed period from it, and the waiver
  would then waive a billed fee.
- Step 2 gives a different set of failing tests than the four listed.
- A test fails with a message that starts with `fake Glide:`. Report the message. Do not extend
  `fake-glide.ts` under this plan.
- The fix seems to need a change in `billing.ts`, in the order of `LOCK`, or in any file outside
  the scope.
- `npm run build` leaves `src/fluent/generated/keys.ts` modified. This plan adds no Fluent record.
  Report the diff.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- New behaviour to know about: a waiver that meets a held lock is not retried. The fee stays open,
  the receipt goes through, and an error line says what to do. The window is short (a generation
  billing that one fee, or a Close or Regenerate of that one period). If the error shows up in
  practice, the follow-up is to queue the waiver as an event that tries again later, the way a
  tracking update that gives up is queued (ADR 0013). It was left out to keep this change small.
- Two waivers of different fees on one period take the same period lock, one after the other. Each
  holds it for one read and one save. Two depot scans in the same instant can still make one of them
  give up after its tries, with the same error line.
- Any new writer of a fee's `status` or `billing_period` must take the fee's lock, and the period's
  lock too when it must not land inside a Close. Any new code that calls `waiveOpenFees` must hold
  no lock declared after `fee` in `LOCK`.
- If a later change makes the Close take a fee's lock, `billingPeriod` would have to be declared
  before `fee`, and then this waiver's nested take (fee, then period) would be illegal. The two
  designs exclude each other. Keep the period lock as the one thing a waiver and a Close share.
- A reviewer should scrutinize: that the open charges are queried inside the fee's lock, not
  before it; that the period's status is read inside the period's lock; that a closed period is
  never waived on; and that the wording in ADR 0013 matches what the code does.
- Not covered: a fee set to *Waived* by hand on its form while its period closes. Staff edits take
  no lock. The Close then behaves as before this plan.
