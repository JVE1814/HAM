# Plan 029: Raise a case's replacement under a job lock, so two presses raise one Order

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 805d5da..HEAD -- src/server/domain/lock-names.ts src/server/domain/lock-names.test.ts src/server/platform/breakfix.ts src/server/platform/breakfix.test.ts src/server/platform/orders.ts src/server/platform/locks.ts src/server/entry/breakfix.ts docs/adr/0013-margin-recomputes-supersede-under-a-job-lock.md docs/spec/p2-aftersales.md docs/verify-on-instance.md`
> If any of these files changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding. On a
> mismatch, treat it as a STOP condition. (Plan 024 changes one comment lower
> in `lock-names.ts` and adds a section to `docs/verify-on-instance.md`. That
> alone is not a mismatch if `refreshOrders` is still declared directly before
> `agreementUsage` and the other excerpts still match.)

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none. `plans/024-interval-follows-line-change.md` changes one comment in
  `lock-names.ts` (above `serviceInterval`) and adds a section to `docs/verify-on-instance.md`. It
  adds no lock. Land the two plans one at a time, in either order.
- **Category**: bug
- **Planned at**: commit `805d5da`, 2026-11-12

## Why this matters

**Raise replacement** on a CSM case raises a *device replace* Order for the case's failed Asset,
links it to the case and submits it. Nothing stops two presses doing that at once: two agents on
the same case, or one agent pressing twice before the form reloads. Each press reads the case as
linking no Order, so each raises and submits its own. The case then links only the second one. The
first goes ahead unlinked: it reserves a spare or buys a unit for a failure that already has a
replacement on the way, and nothing on the case shows it.

The app solves this kind of race with a job lock (ADR 0013). This plan gives Raise replacement a
lock per case. The second press at once is told a replacement is being raised. A press that comes
just after reads the case's link afresh under the lock and keeps the Order the first one linked.

## Current state

### How job locks work here (ADR 0013)

A job lock is a row in `x_daas_ham_job_lock` behind a unique index on `name`. Taking a lock is one
insert. Releasing it deletes the row. `withLock(name, work)` in `src/server/platform/locks.ts:37`
runs `work` holding the lock and returns `{ ran: true, value }`, or `{ ran: false }` at once when
another holder has it. It tries once and does not wait. A lock held for more than 10 minutes
(`ABANDONED_AFTER_MINUTES`) is taken as abandoned and cleared by the next taker.

Every lock name is declared once, in `LOCK` in `src/server/domain/lock-names.ts`. The order of the
declarations is the lock order. ADR 0013 states the rule:

```md
<!-- docs/adr/0013-margin-recomputes-supersede-under-a-job-lock.md:78-81 (line 81 goes on) -->
Locks are not re-entrant: a holder that takes a lock it already holds is refused, as any other taker
would be. A take never waits either: it tries and gives up. So locks are taken in one order, and a
holder only takes locks later in it than those it holds. The order is the order `LOCK` declares the
locks in (`src/server/domain/lock-names.ts`), and nowhere else.
```

The head of the registry, and where the new lock goes (between `refreshOrders` and
`agreementUsage`):

```ts
// src/server/domain/lock-names.ts:17-25
export const LOCK = {
    /** Held by the daily refresh run from its read of the Assets due to its last Order. */
    refreshOrders: () => named('refresh_orders'),
    /**
     * An Agreement's submissions take turns under it: each reads the Agreement's usage, assesses its Order and saves it
     * out of draft, which makes it count in flight, before the next reads. Two read at once would each miss the other
     * and could both go ahead within a Contracted quantity only one fits.
     */
    agreementUsage: (agreementId: string) => named(`agreement_usage_${agreementId}`),
```

Why that position is right. Raise replacement is a form button. It holds no lock when it starts,
so its lock may sit after nothing. What matters is what it takes while it holds the lock. It
submits the Order through `submitOrder`, which takes two locks:

```ts
// src/server/platform/orders.ts:203-210
function submitAccepted(order: GlideRecord, tries: number): Submission {
    const lines = requestedLines(order.getUniqueValue())
    if (lines.length === 0) return { submitted: false, message: 'Add at least one order line before submitting' }
    if (!readsUsage(lines)) return submitUnderOrderLock(null, order)
    const usageLock = LOCK.agreementUsage(str(order, 'agreement'))
    const underUsage = withLockTries(usageLock, (lock) => submitUnderOrderLock(lock, order), LONG_HOLD_LOCK_TRIES)
    return underUsage.ran ? underUsage.value : submitLater(order, tries)
}
```

```ts
// src/server/platform/orders.ts:218-221
function submitUnderOrderLock(usageLock: HeldLock | null, order: GlideRecord): Submission {
    const underOrder = withLockTries(LOCK.sourceOrder(order.getUniqueValue()), () => submitHolding(usageLock, order), LONG_HOLD_LOCK_TRIES)
    return underOrder.ran ? underOrder.value : notSubmitted('it is being cancelled. Try again shortly')
}
```

So under the new lock a press takes `source_order_<Order sys_id>`, and `agreement_usage_<Agreement
sys_id>` only when a linked draft gained a line that adds a unit. Both must be declared after the
new lock. `agreementUsage` is the second entry of `LOCK`, so the new lock goes directly before it.
`createOrder` (`orders.ts:85`) only inserts the Order and its lines. No business rule of the app
runs on those inserts, and the rule on the case (`takeFailedAssetTerms`) takes no lock. The daily
refresh run holds `refresh_orders` and never raises a case's replacement, so the new lock is never
taken under `refresh_orders`, and nothing under the new lock takes `refresh_orders`.

The test that holds each name:

```ts
// src/server/domain/lock-names.test.ts:32-33
        expect(LOCK.refreshOrders()).toBe('refresh_orders')
        expect(LOCK.agreementUsage(a)).toBe(`agreement_usage_${a}`)
```

The other tests of that file read `LOCK` by reflection. A lock that takes one record id needs no
edit there.

### Raise replacement today

```ts
// src/server/platform/breakfix.ts:1-7
import type { GlideRecord } from '@servicenow/glide'
import { isAnotherCustomers, replacementProblem, replacementStep } from '../domain/breakfix.ts'
import { ORDER_STAGE, type OrderStage } from '../domain/vocabulary.ts'
import { isFleetAsset, readStage } from './assets.ts'
import { log } from './log.ts'
import { createOrder, submitOrder } from './orders.ts'
import { bool, findById, refusal, str, warnRefused, type ForeignRecord } from './records.ts'
```

```ts
// src/server/platform/breakfix.ts:47-67
/**
 * Saves the case,
 * the record of the form it was asked from, first: a refused save raises nothing, as the failed asset and linked Order
 * would be values the case does not hold.
 * One that cannot be submitted as raised stays a draft, still linked to the case so a second one is not raised, for
 * the user to correct. "Raise replacement" is offered while the case links no Order or one rejected or cancelled, but
 * a form opened before then can still send it: then a linked draft is submitted again and a linked Order going ahead
 * is kept.
 */
export function raiseReplacement(kase: GlideRecord): Replacement {
    if (!kase.update()) return notRaised('')
    const linked = findById('x_daas_ham_order', str(kase, 'x_daas_ham_replacement_order'))
    const step = replacementStep(linked ? (str(linked, 'stage') as OrderStage) : null)
    if (linked && step === 'submit_draft') return submitReplacement(linked)
    if (linked && step === 'keep') {
        return { outcome: 'already_raised', number: str(linked, 'number'), stageLabel: linked.getDisplayValue('stage') }
    }
    const failed = findById('alm_hardware', str(kase, 'x_daas_ham_failed_asset'))
    if (!failed) return notRaised('Set the failed asset on the case first')
    const problem = replacementProblem({ fleet: isFleetAsset(failed), stage: readStage(failed), customerId: str(failed, 'company') }, str(kase, 'account'))
    if (problem) return notRaised(problem)
```

The function goes on (lines 68 to 96) to call `createOrder`, set
`x_daas_ham_replacement_order` on `kase`, save `kase` and call `submitReplacement(order)`. That
part does not change.

Two things are wrong at line 58. No lock is held. And the link is read from `kase`, the record the
form handed in, which was read before another press linked its Order. Even a press that waits its
turn would not see that Order.

What must be kept:

- The case is saved first, before anything else (`if (!kase.update()) return notRaised('')`). The
  docstring says why. The save stays outside the lock.
- A form opened earlier can still send the button. A linked draft is then submitted again, and a
  linked Order going ahead is kept and reported as `already_raised`. `replacementStep`
  (`src/server/domain/breakfix.ts:16`) decides which. That logic stays, only its input changes.

### How the outcome reaches the user

`raiseReplacement` tells the user nothing. It returns a `Replacement`, and the UI action's adapter
words it:

```ts
// src/server/entry/breakfix.ts:17-18
        case 'not_raised':
            if (replacement.why) gs.addErrorMessage(replacement.why)
```

So a press that finds the lock held returns `{ outcome: 'not_raised', why }`, and `why` is shown
as an error message. The adapter needs no change. The wording follows the other form buttons that
find a lock held, which say what is running and what to do, for example Cancel order's
`'it is being submitted or sourced. Try again in a minute'` (`orders.ts:507`).

### The existing tests and how a test holds a lock

`src/server/platform/breakfix.test.ts` has 5 tests. Its `Raise replacement` block has 2, neither
about two presses. Its setup:

```ts
// src/server/platform/breakfix.test.ts:45-51
beforeEach(() => {
    platform.reset()
    platform.references = { [`${ASSETS}.x_daas_ham_agreement`]: 'x_daas_ham_agreement' }
    platform.tables.x_daas_ham_agreement = [{ sys_id: 'agr1', replacement_tier: 'nbd' }]
    platform.tables[ASSETS] = [failedUnit('acme')]
    platform.tables[CASES] = [{ sys_id: 'case1', number: 'CS0001', account: 'acme', x_daas_ham_failed_asset: 'asset1' }]
})
```

A test plays another holder by storing a lock row, and it must tell the fake that the lock table
has a unique key, or a second insert of the same name is accepted:

```ts
// src/server/platform/order-submission.test.ts:31-39
function holdUsageLock(): Row {
    const theirs = { sys_id: 'theirs', name: LOCK.agreementUsage('agr1'), sys_created_on: '2025-11-09 12:00:00' }
    ;(platform.tables[LOCKS] ??= []).push(theirs)
    return theirs
}

beforeEach(() => {
    platform.reset()
    platform.uniqueKeys = { [LOCKS]: 'name' }
```

`2025-11-09 12:00:00` is the fake's clock at start, so the row is fresh and not taken as abandoned.

### Documentation to change

ADR 0013 names who takes the usage lock holding nothing. Raise replacement will hold its case lock:

```md
<!-- docs/adr/0013-margin-recomputes-supersede-under-a-job-lock.md:104-105 -->
a second submission of the same Order finds it gone ahead and says so. *Submit*, the record
producer, *Raise replacement* and a submission queued again take it holding no lock. An Order whose
```

The paragraph about submissions ends, and the next begins, here. The new lock's paragraph goes
between these two lines:

```md
<!-- docs/adr/0013-margin-recomputes-supersede-under-a-job-lock.md:123-125 -->
The lock orders submissions only: usage that changes without one (a line added to an Order already
submitted, its Agreement changed, Assets adopted into the Agreement) is not assessed.
The Asset rule that takes a unit lost in transit off its Order line takes no lock: it queues the
```

The spec's bullet about the button:

```md
<!-- docs/spec/p2-aftersales.md:22-25 -->
- **Raise replacement** is offered while the case links no Order, or one that was rejected or
  cancelled: a new Order then takes its place on the case. A form opened before the link can still send
  it: a linked draft is then submitted again, and a linked Order awaiting approval, going ahead or
  complete is kept (`domain/breakfix.ts`).
```

`docs/verify-on-instance.md` has one section per lock under `## Job locks (ADR 0013)`. The new
section goes directly before `### Spare-pool lock` (line 694).

### Conventions that apply (README.md "Development", AGENTS.md)

- A lock name goes in `src/server/domain/lock-names.ts`, in the order ADR 0013 gives, with its
  assertion in `lock-names.test.ts`.
- A test is a `*.test.ts` file beside the module it tests. A platform test runs against
  `src/server/test-support/fake-glide.ts`. The fake throws `fake Glide: ...` on anything it does
  not know. It runs no business rule, ACL or flow.
- A relative import in `src/server` names the `.ts` file (`./locks.ts`). ESLint enforces it.
- `npx vitest run <path>` needs no build. `npm test` and `npm run check` do.
- `npm run build` rewrites the tracked file `src/fluent/generated/keys.ts`. This plan changes no
  Fluent file, so the build must leave it unchanged.
- Comments only for a non-obvious why. Use the words of `CONTEXT.md`: Order, Asset, Agreement.
- When documented behaviour changes, the matching spec and ADR lines change in the same commit.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Lint | `npm run lint` | exit 0 |
| This plan's tests | `npx vitest run src/server/domain/lock-names.test.ts src/server/platform/breakfix.test.ts` | all pass |
| Build | `npm run build` | exit 0; rewrites `dist/` |
| Full gate | `npm run check` | exit 0; all tests pass |

## Scope

**In scope** (the only files you should modify):

- `src/server/domain/lock-names.ts`
- `src/server/domain/lock-names.test.ts`
- `src/server/platform/breakfix.ts` (only `raiseReplacement`, its docstring and two imports)
- `src/server/platform/breakfix.test.ts`
- `docs/adr/0013-margin-recomputes-supersede-under-a-job-lock.md`
- `docs/spec/p2-aftersales.md`
- `docs/verify-on-instance.md`

**Out of scope** (do NOT touch, even though they look related):

- `src/server/entry/breakfix.ts`. It already shows a `not_raised` reason as an error message.
- `src/server/platform/orders.ts`. `createOrder` and `submitOrder` keep their locks and their order.
- `src/server/platform/locks.ts` and `src/server/domain/job-lock.ts`. The lock mechanism is right.
- `src/fluent/break-fix/break-fix.now.ts`. The UI action, its condition and its name stay. No
  Fluent record is added, so `src/fluent/generated/keys.ts` must not change.
- `takeFailedAssetTerms` and `noteReplacementComplete` in `breakfix.ts`.
- A retry of the lock. A second press must not wait behind the first: it is told at once.

## Git workflow

- Branch: `advisor/029-raise-replacement-lock`, from `main`.
- One commit. Subject in the repo's style, an imperative sentence under 72 characters, for example
  `Raise a case's replacement under a job lock on the case`. The body says what was wrong and why
  (two presses at once each raised and submitted an Order, and only one stayed linked).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Branch and confirm the baseline

```sh
git checkout main && git checkout -b advisor/029-raise-replacement-lock
npx vitest run src/server/domain/lock-names.test.ts src/server/platform/breakfix.test.ts
```

**Verify**: all tests pass, 0 failed (at the planned-at commit: 6 in `lock-names.test.ts`, 5 in
`breakfix.test.ts`).

### Step 2: Declare the lock name

In `src/server/domain/lock-names.ts`, insert these five lines directly after the `refreshOrders`
line (line 19) and before the doc comment of `agreementUsage`. The position is part of the change:
it is the lock order.

```ts
    /**
     * Raise replacement on a case reads the Order the case links, raises one, links it and submits it under it, so two
     * presses at once never raise an Order each.
     */
    replacementCase: (caseId: string) => named(`replacement_case_${caseId}`),
```

In `src/server/domain/lock-names.test.ts`, in the test `names each lock as the locks held across an
upgrade are named`, insert this line directly after the `LOCK.refreshOrders()` line (line 32):

```ts
        expect(LOCK.replacementCase(a)).toBe(`replacement_case_${a}`)
```

Change nothing else in the test file.

**Verify**: `npx vitest run src/server/domain/lock-names.test.ts` → 6 passed.

### Step 3: Write the failing tests

Edit `src/server/platform/breakfix.test.ts`.

Add this import directly after the `import { fieldsOf } from '../domain/lifecycle.ts'` line:

```ts
import { LOCK } from '../domain/lock-names.ts'
```

Add this constant directly after the `const ASSETS = 'alm_hardware'` line:

```ts
const LOCKS = 'x_daas_ham_job_lock'
```

In `beforeEach`, add this line directly after `platform.reset()`:

```ts
    platform.uniqueKeys = { [LOCKS]: 'name' }
```

In the test `goes on to raise the Order for the Asset's Customer, at its Site, when that is the
case's account`, add this line directly after
`expect(tried).toEqual([{ customer: 'acme', site: 'site1' }])`:

```ts
        expect(rows(LOCKS)).toEqual([])
```

Then add these two tests at the end of `describe('Raise replacement', ...)`, after that test and
before the closing `})` of the block:

```ts
    it('raises nothing while another press holds the lock of the case, and says so', () => {
        const theirs = { sys_id: 'theirs', name: LOCK.replacementCase('case1'), sys_created_on: '2025-11-09 12:00:00' }
        platform.tables[LOCKS] = [theirs]

        expect(raiseReplacement(storedCase())).toEqual({ outcome: 'not_raised', why: 'A replacement is being raised for this case. Reload the case to see its Order' })

        expect(rows(ORDERS)).toEqual([])
        expect(rows(LOCKS)).toEqual([theirs])
    })

    it('keeps the Order another press linked after this form read the case, and raises no second one', () => {
        const readBefore = storedCase()
        platform.tables[ORDERS] = [{ sys_id: 'order1', number: 'ORD0001', stage: 'sourcing' }]
        platform.tables[CASES] = [{ sys_id: 'case1', number: 'CS0001', account: 'acme', x_daas_ham_failed_asset: 'asset1', x_daas_ham_replacement_order: 'order1' }]

        expect(raiseReplacement(readBefore)).toEqual({ outcome: 'already_raised', number: 'ORD0001', stageLabel: 'sourcing' })

        expect(rows(ORDERS)).toHaveLength(1)
        expect(rows(LOCKS)).toEqual([])
    })
```

The first test plays another press by storing its lock row. The second reads the case into
`readBefore`, as a form does, then stores what another press did meanwhile (an Order going ahead,
linked to the case), then presses with the stale record.

**Verify**: `npx vitest run src/server/platform/breakfix.test.ts` → `2 failed | 5 passed`. The two
failures are exactly the two new tests. Each fails with an error thrown from `submitOrder`:
`fake Glide: x_daas_ham_order.site is dot-walked but not declared in platform.references`. That
error is the bug showing: the press went on to raise and submit an Order. It is expected in this
step only. If the set of failures differs, STOP.

### Step 4: Hold the case lock and read the link afresh

Edit `src/server/platform/breakfix.ts`.

Add two imports. `LOCK` goes directly after the `../domain/breakfix.ts` import (line 2), and
`withLock` directly after the `./assets.ts` import (line 4):

```ts
import { LOCK } from '../domain/lock-names.ts'
```

```ts
import { withLock } from './locks.ts'
```

Replace the end of the docstring and the first two statements of `raiseReplacement`. These lines
(54 to 58):

```ts
 * is kept.
 */
export function raiseReplacement(kase: GlideRecord): Replacement {
    if (!kase.update()) return notRaised('')
    const linked = findById('x_daas_ham_order', str(kase, 'x_daas_ham_replacement_order'))
```

become:

```ts
 * is kept.
 * Two presses at once would each find the case linking no Order and raise one each, so the Order is raised, linked and
 * submitted holding the case's job lock (domain/lock-names `replacementCase`, ADR 0013); a press that finds it held
 * raises nothing and says so. Taking the lock throws only when an insert is refused with no lock row (platform/locks):
 * that error escapes.
 */
export function raiseReplacement(kase: GlideRecord): Replacement {
    if (!kase.update()) return notRaised('')
    const raising = withLock(LOCK.replacementCase(kase.getUniqueValue()), () => raiseHolding(kase))
    return raising.ran ? raising.value : notRaised('A replacement is being raised for this case. Reload the case to see its Order')
}

/**
 * The raise, holding the case's lock. The Order the case links is read from the stored case, not from `kase`: a press
 * that held the lock before this one may have linked its Order after this form's case was read.
 */
function raiseHolding(kase: GlideRecord): Replacement {
    const stored = findById('sn_customerservice_case', kase.getUniqueValue())
    if (!stored) return notRaised('The case can no longer be read')
    const linked = findById('x_daas_ham_order', str(stored, 'x_daas_ham_replacement_order'))
```

Everything that followed line 58 in `raiseReplacement` (from `const step = replacementStep(...)`
down to `return submitReplacement(order)` and the closing `}`) stays exactly as it is. It is now
the rest of `raiseHolding`. It still reads the failed asset and the account from `kase` and still
saves the link through `kase`: the save on the first line of `raiseReplacement` has just stored
those values, so `kase` and the stored case differ only in the link another press may have saved.

**Verify**:

- `npx vitest run src/server/platform/breakfix.test.ts` → 7 passed, 0 failed.
- `grep -c "withLock(LOCK.replacementCase(kase.getUniqueValue())" src/server/platform/breakfix.ts` → `1`.
- `grep -c "str(kase, 'x_daas_ham_replacement_order')" src/server/platform/breakfix.ts` → `1`
  (the one left is in `noteReplacementComplete`, which has its own `kase`).
- `npm run typecheck` → exit 0. `npm run lint` → exit 0.

### Step 5: Document the lock

In `docs/adr/0013-margin-recomputes-supersede-under-a-job-lock.md`, replace lines 104 and 105
(quoted under "Documentation to change") with:

```md
a second submission of the same Order finds it gone ahead and says so. *Submit*, the record
producer and a submission queued again take it holding no lock, and *Raise replacement* holding
only its case's lock (`replacement_case_`, below). An Order whose
```

In the same file, insert the following paragraph between the line that ends
`its Agreement changed, Assets adopted into the Agreement) is not assessed.` and the line that
starts `The Asset rule that takes a unit lost in transit`. Keep it as plain lines with no blank
line before or after, like the paragraphs around it:

```md
*Raise replacement* on a case runs under `replacement_case_<case sys_id>`, holding no other lock
when it takes it: it reads the Order the case links afresh there, raises the replacement Order,
links it to the case and submits it. Two presses at once would otherwise each find the case
linking no Order and raise one each, the first left going ahead unlinked. It does not retry: a
press that finds the lock held raises nothing and says a replacement is being raised. Under it,
the submission takes the Order's `source_order_` and, for a linked draft that gained a line adding
a unit, its Agreement's `agreement_usage_`, so `replacement_case` comes before `agreement_usage`.
The daily refresh run never takes it, and nothing under it takes `refresh_orders`. A press holds
it for one raise, far short of `ABANDONED_AFTER_MINUTES`, so it does not check for a lost lock.
```

In `docs/spec/p2-aftersales.md`, append these four lines to the bullet quoted under
"Documentation to change", directly after its last line
(`  complete is kept (`domain/breakfix.ts`).`), indented by two spaces like the rest of the bullet:

```md
  Two presses at once take turns under a job lock on the case (`LOCK.replacementCase` in
  `domain/lock-names.ts`, ADR 0013): one that finds it held raises nothing and says *A replacement
  is being raised for this case*, and each press reads the Order the case links afresh under the
  lock, so a press that follows another keeps the Order that one linked.
```

In `docs/verify-on-instance.md`, insert this section directly before the line
`### Spare-pool lock`, with one blank line before and after it:

```md
### Replacement lock

*Raise replacement* on a case ([how a job lock behaves](#how-a-job-lock-behaves)). The press raises,
links and submits the replacement Order under the job lock `replacement_case_<case sys_id>`. With
a row of that name in *Job lock*, *Raise replacement* on that case raises no Order. It logs two
*Unique Key violation* errors and shows *A replacement is being raised for this case. Reload the
case to see its Order*. Delete the row and the next press raises the Order.
```

**Verify**:

- `grep -c "replacement_case" docs/adr/0013-margin-recomputes-supersede-under-a-job-lock.md` → `3`.
- `grep -c "LOCK.replacementCase" docs/spec/p2-aftersales.md` → `1`.
- `grep -c "### Replacement lock" docs/verify-on-instance.md` → `1`.

### Step 6: Run the full gate and commit

```sh
npm run check
git status --short
```

**Verify**: `npm run check` exits 0 (1806 tests passed at the planned-at commit, 2 more than
before; more if other plans landed). `git status --short` lists only the seven in-scope files. If
`src/fluent/generated/keys.ts` shows as modified, see the STOP conditions.

Commit the seven files in one commit, with the subject from "Git workflow" and a body that says
what was wrong and why.

## Test plan

- `src/server/domain/lock-names.test.ts`: one assertion added, for the new name. Its reflection
  tests then also check that the name is unique per case and fits the lock column.
- `src/server/platform/breakfix.test.ts`, modelled on the lock tests of
  `src/server/platform/order-submission.test.ts` (a stored lock row plays the other holder):
  - a press that finds the case's lock held returns `not_raised` with the wording above, raises no
    Order and leaves the other holder's lock row alone;
  - a press whose record was read before another press linked an Order going ahead returns
    `already_raised` for that Order and raises no second one. This is the regression test for the
    stale read;
  - the existing test of a refused Order insert now also asserts that the lock is released.
- Verification: `npx vitest run src/server/domain/lock-names.test.ts src/server/platform/breakfix.test.ts`
  → 13 passed, 0 failed (6 and 7).

What the tests cannot show: the fake Glide is single-threaded, so two presses never truly overlap.
The tests show that a press takes the lock, raises nothing when it is held, and reads the link
afresh. That the lock row excludes a second press on a real instance rests on the unique index,
which every other job lock already relies on.

ATF and instance checks: ATF runs on an instance only, and no ATF test presses the button twice.
The instance check is the new section of `docs/verify-on-instance.md` (create a *Job lock* row by
hand, press, read the message). It is optional for handing the work back. Say in your report
whether it was run.

## Done criteria

ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm run lint` exits 0
- [ ] The test command in the test plan reports 13 passed, 0 failed
- [ ] `npm run check` exits 0
- [ ] `grep -n "replacementCase\|agreementUsage:\|refreshOrders:" src/server/domain/lock-names.ts` shows the three declarations in the order `refreshOrders`, `replacementCase`, `agreementUsage`
- [ ] `grep -c "withLock(LOCK.replacementCase(kase.getUniqueValue())" src/server/platform/breakfix.ts` prints `1`
- [ ] `grep -c "### Replacement lock" docs/verify-on-instance.md` prints `1`
- [ ] `git diff --stat main..HEAD -- src/fluent src/server/entry` prints nothing
- [ ] `git status --short` is empty and only the seven in-scope files differ from `main`
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" does not match the excerpts.
- `LOCK` in `lock-names.ts` already has a lock for a case or for Raise replacement, or an entry
  now sits between `refreshOrders` and `agreementUsage`. The position decides the lock order, so
  do not guess a new one.
- Step 3 gives a different set of failing tests than the two listed, or they fail with another
  error than the one quoted.
- After step 4, any test fails with a message that starts with `fake Glide:`. Report the message.
  Do not extend `fake-glide.ts` under this plan.
- You find that `createOrder`, `submitOrder` or anything they call takes `refresh_orders`, or a
  lock declared before `agreementUsage` other than the new one (search the functions they call for
  `LOCK.`). The position chosen would then break the lock order.
- A change seems to need a new parameter on `raiseReplacement` or `uiRaiseReplacement`, or a
  change in `src/fluent`. The UI action calls `uiRaiseReplacement(current)`.
- `npm run build` leaves `src/fluent/generated/keys.ts` modified. Report the diff.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- A new lock taken while raising or submitting a replacement must be declared after
  `replacementCase` in `LOCK`. Today only `refreshOrders` is declared before it.
- The lock is taken with one try. A slow first press (a submission that waits on
  `agreement_usage_` or `source_order_`) keeps a second press out for that long, and the second
  press is told so. Do not turn the take into `withLockTries`: a press that waited would then
  submit beside a user who has already been told the outcome.
- `raiseHolding` reads the case with `findById`, as the signed-in user. Customer Service's case
  query rules can hide a case from a user without `case_admin`. A user who pressed the button on
  the case's form can read it, so this holds for the UI action. A new caller that runs for another
  user would get `The case can no longer be read`.
- A press that dies holding the lock keeps the button from raising for up to 10 minutes on that
  case. The message tells the user to reload. After 10 minutes the next press clears the lock.
- A reviewer should check three things: the position of `replacementCase` in `LOCK`, that the
  first `kase.update()` is still outside the lock and still first, and that the body of
  `raiseHolding` below the fresh read is the old body unchanged.
- Deferred: the first press's Order can still be created and then fail to link (the case save
  refused). That path is unchanged: the Order stays a draft that names the case, and the user is
  told to link and submit it.
