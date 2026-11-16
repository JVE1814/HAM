# Plan 045: Close the open Return orders that no line keeps open, in the daily overdue-returns job

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 805d5da..HEAD -- src/server/platform/returns.ts src/server/platform/returns.test.ts src/server/domain/chunked-job.ts src/server/platform/chunked.ts src/server/platform/clock.ts src/server/platform/customer-page.ts docs/adr/0007-chunked-jobs-with-persistent-cursors.md docs/adr/0013-margin-recomputes-supersede-under-a-job-lock.md docs/spec/p2-aftersales.md`
> This plan lands after plans 032 and 038, so the check is expected to show
> their changes. Plan 032 adds two imports and the function
> `contactReturnInsertRefusal` to `returns.ts` (which moves the code this
> plan quotes down by 1 to 23 lines), adds 4 tests to `returns.test.ts` and
> one bullet to `docs/spec/p2-aftersales.md`. Plan 038 adds two names to
> `JOB` in `chunked-job.ts`, rewrites the *Scheduled returns* bullet of ADR
> 0007 and adds one bullet to `docs/spec/p2-aftersales.md`. Plan 029 adds a
> paragraph to ADR 0013 well above the lines this plan edits. None of that
> is a mismatch. Find each excerpt by its text, not by its line number. Only
> a mismatch in an excerpt this plan quotes is a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none in code. Land after `plans/032-customer-direct-insert-checks.md` and
  `plans/038-scheduled-returns-rotation.md`: they edit the same files in other places, and plan
  032 knowingly leaves one of the cases this plan closes.
- **Category**: bug
- **Planned at**: commit `805d5da`, 2026-11-12

## Why this matters

A Return order is closed at one moment only: when its last line is evaluated or its last unit is
declared missing. Nothing looks at it again. So two kinds of Return order stay open for good:

- one that never had a line. Staff or a customer admin inserted it by hand, or it was raised with
  no unit and the platform refused the save that closes it;
- one whose lines are all settled, but whose close the platform refused at that moment. The code
  logs *Return ... not closed, close it* once and never tries again.

Such a Return order sits in the staff lists and on the customer page as an open return, with
nothing to bring back. The customer page lists every active Return order, so the Customer is asked
for equipment nobody awaits.

This plan gives the daily overdue-returns job a second pass. It closes each open Return order,
created more than a day ago, that no line keeps open. It leaves a work note, logs the close, and
tries a refused close again on the next run.

## Current state

### Where a Return order is closed today

`src/server/platform/returns.ts` holds every write of a Return order and its lines. The close:

```ts
// src/server/platform/returns.ts:564-571 (the last function of the file)
function closeReturnIfDone(returnOrderId: string): void {
    if (exists(RETURN_LINE, `return_order=${returnOrderId}^statusIN${KEEPS_RETURN_OPEN.join(',')}`)) return
    const order = findById(RETURN, returnOrderId)
    if (!order || str(order, 'state') === String(TASK_STATE.closedComplete)) return
    order.setValue('state', TASK_STATE.closedComplete)
    // No later line calls this again, and an open Return still asks the Customer for its equipment.
    if (!order.update()) warnRefused(order, `Return ${str(order, 'number')} not closed, close it`)
}
```

`KEEPS_RETURN_OPEN` is `['awaiting', 'received']` (`src/server/domain/returns.ts:73`): a line that
is evaluated or missing does not keep its Return order open. `TASK_STATE.closedComplete` is `3`
(`src/server/domain/vocabulary.ts:26-33`). `closeReturnIfDone` has two callers, both at the moment
a line is settled: `evaluateReturnLine` (`closeReturnIfDone(str(line, 'return_order'))`) and
`declareMissing` (`if (declared.ran && declared.value) closeReturnIfDone(overdue.returnOrderId)`).

### Which Return orders are left open with nothing to wait for

Each was checked against the code at `805d5da`:

1. **Inserted by hand.** A form or the Table API saves a Return order and no code fills or closes
   it. Staff can do that. A customer admin can do it for their own Customer and one of its Sites:
   plan 032 keeps that open on purpose ("A residue is accepted"). No line is ever added unless
   someone adds one by hand.
2. **Raised with no unit, and the closing save refused.** `fillReturn` closes a Return order with
   no line at once, but in memory, and saves it with one `update()`:

   ```ts
   // src/server/platform/returns.ts:140-144 and 160-161
       if (lines === 0) {
           // Nothing installed, everything already on another Return order, or every unit refused: close straight away.
           order.setValue('state', TASK_STATE.closedComplete)
           const note = refused > 0 ? 'No unit could be added (see the system log).' : 'No equipment to bring back.'
           order.setValue('work_notes', note)
   ```

   ```ts
       // Its lines and moves are saved, but a Return without its due date is never chased: logged to set it by hand.
       if (!order.update()) warnRefused(order, `Return ${str(order, 'number')} due date, state and links not saved`)
   ```

   When that save is refused, the Return order stays as it was inserted: open, with no line.
   Measured on the fake.
3. **The record producer's Return order that is not raised, and whose removal is refused.**
   `requestProducedReturn` deletes it, and only logs when the delete is refused:
   `if (!outcome.raised && !order.deleteRecord()) warnRefused(order, ...)`.
4. **Lines deleted by hand** after the Return order was raised. No code runs on that delete.
5. **Every line settled, and the close refused.** The warning in `closeReturnIfDone` above.

Not a case: a Return order whose every line insert was refused. `fillReturn` then counts no line
and closes it at once (case 2 applies only if that save is refused too). And the customer page
refuses a request that names nothing before it saves anything
(`if (!produced && requested.length === 0) return notRaised('nothing', ...)`).

The customer page lists every active Return order, with or without a line:

```ts
// src/server/platform/customer-page.ts:84-89
export function openReturns(): CustomerReturn[] {
    const open: Array<{ id: string; listed: Omit<CustomerReturn, 'labelUrl' | 'trackingNumber'> }> = []
    const ret = new GlideRecord('x_daas_ham_return_order')
    ret.addQuery('active', true)
    ret.setLimit(200)
    ret.query()
```

A Return order extends `task` (`src/fluent/returns/tables.now.ts:18-21`). The platform turns a
task's `active` off when its state becomes a closed one. The app relies on that here, and this
plan relies on it in the same way.

### The daily job this plan extends

*NaaS - chase overdue returns* runs `chaseOverdue` daily at 05:20 UTC
(`src/fluent/returns/logic.now.ts:50-58`). It holds a run lock and makes one pass over the
awaiting lines with the chunked-job runner:

```ts
// src/server/platform/returns.ts:453-472
/**
 * Escalate overdue returns once, then declare the Assets missing and charge the lost-asset fee (the daily job). Two
 * runs at once (the scheduled job and an *Execute now*) would both read a Return order as not escalated and each notify
 * its Customer, and both advance the job's one cursor, so a run holds a job lock (ADR 0013) throughout; one that finds
 * it held chases nothing and logs so. Taking the lock throws only when an insert is refused with no lock row
 * (platform/locks): that error escapes.
 */
export function chaseOverdue(): void {
    const lockName = LOCK.overdueReturnsRun()
    if (withLock(lockName, chaseHolding).ran) return
    log.info(`Overdue returns not chased: another run holds the ${lockName} lock and chases them`)
}

function chaseHolding(): void {
    const today = todayIso()
    const grace = intProperty(PROPERTY.returnGraceDays)
    runTableJob({
        job: JOB.chaseOverdueReturns,
        table: RETURN_LINE,
        query: `status=${AWAITED}^return_order.due_back<${today}`,
```

`chaseHolding` ends like this. Step 4 adds one line after the `runTableJob({ ... })` call:

```ts
// src/server/platform/returns.ts:491-496
            } else if (step === 'declare_missing') {
                declareMissing({ lineId, assetId: line.assetId, returnOrderId: line.returnOrderId, number })
            }
        },
    })
}
```

`runTableJob` (`src/server/platform/chunked.ts:79`) is the runner of ADR 0007. It visits the
records of `table` that match `query` in sys_id order, calls `read` on each record and then
`handle(item, sysId)`. A run stops when the job time budget is spent
(`x_daas_ham.job.budget_seconds`, 120 as shipped) and saves the last sys_id in the job's row of
`x_daas_ham_job_cursor`. The next run goes on from there, and starts over after the last record.
The row is created by the code on first use. A record whose `handle` throws is counted as failed
and the pass moves on. Each `runTableJob` call has a budget of its own.

Every cursor row is named in `JOB`:

```ts
// src/server/domain/chunked-job.ts:8-12
export const JOB = {
    normalizeRawModels: 'normalize_raw_models',
    inServiceDetection: 'in_service_detection',
    chaseOverdueReturns: 'chase_overdue_returns',
    reconcileInstalledBase: 'reconcile_installed_base',
```

A test in `src/server/domain/chunked-job.test.ts` reads `JOB` by reflection and fails on a
duplicate name. It needs no edit.

The clock helpers are imported on this line, and `daysAgoGlide(days)`
(`src/server/platform/clock.ts:14-16`) gives the UTC date-time that many days ago as
`yyyy-MM-dd HH:mm:ss`:

```ts
// src/server/platform/returns.ts:42
import { nowGlide, todayIso } from './clock.ts'
```

A query that compares `sys_created_on` with such a value is already used by the job locks
(`src/server/platform/locks.ts:72`, `sys_created_on>=${abandonedBefore()}`).

### Why this design, and what was passed over

- **A second pass of the overdue-returns job, with `runTableJob` (chosen).** That job is the one
  that settles Return orders, `closeReturnIfDone` lives in the same module, and the job already
  holds a run lock that keeps two runs from advancing one cursor. The pass reads every open Return
  order created more than a day ago, in bounded chunks with a cursor of its own, and calls
  `closeReturnIfDone` on each. Checking one Return order costs one small query.
- **The scheduled-returns job (`scheduled-returns.ts`, plan 038's page of 50).** It would need
  `closeReturnIfDone` exported, it holds no run lock, and a page of 50 a day would take days to
  get round every open Return order. Passed over.
- **A query that finds only Return orders without a line.** An encoded query cannot ask for
  records that no row of another table points at, short of a related-list condition, which the
  fake does not evaluate and no code of the app uses. Passed over.
- **Closing a hand-made Return order as it is inserted.** Its lines can only be added after it is
  saved, so it has none then. Passed over.

**The grace period is one day from the Return order's creation** (`sys_created_on`). The app's own
Return orders get their lines in the transaction that inserts them: `raiseReturn` inserts the
header and `fillReturn` adds each line right after, each under the Asset's `return_asset_` lock,
and the customer page does all of it under the Customer's `return_request_` lock. That takes
seconds, or minutes for a large Site. A Return order inserted by hand gets its lines by hand, some
time later. One day covers both, and the job runs once a day anyway.

**No lock per Return order is taken.** A lock helps only if whoever adds a line takes it too. The
app adds lines only in the transaction that created the Return order, which the grace period
keeps the pass away from. A line added by hand takes no lock at all. The two existing callers of
`closeReturnIfDone` take none either. So no name is added to `src/server/domain/lock-names.ts`,
and the lock order of ADR 0013 is untouched. What can still go wrong is in "Maintenance notes".

**The pass closes on `closeReturnIfDone`'s own rule**, not on "has no line at all". That rule is
what "nothing to wait for" means in this app, and it makes the pass also close case 5 above, which
is the same defect: nothing closes the Return order later.

### The existing tests

`src/server/platform/returns.test.ts` has 9 tests at `805d5da`, and 13 once plan 032 landed. Its
helpers, which the new tests reuse:

```ts
// src/server/platform/returns.test.ts:11-16 (plan 032 moves them down one line)
const RETURNS = 'x_daas_ham_return_order'
const RETURN_LINES = 'x_daas_ham_return_order_line'
const FEES = 'x_daas_ham_fee_event'
const LOCKS = 'x_daas_ham_job_lock'

const rows = (table: string): Row[] => platform.tables[table] ?? []
```

It imports `chaseOverdue`, `withLock` and `LOCK` already. Its `beforeEach` resets the fake, sets
`platform.uniqueKeys = { [LOCKS]: 'name' }` and stores one Asset `a1`. Its describe
`the daily chase of overdue returns` shows how a test runs the job: set `platform.clock`, store
rows, call `chaseOverdue()`. Its Return order row has no `active` field, so the new pass does not
select it and those tests do not change.

The fake (`src/server/test-support/fake-glide.ts`) runs no business rule. It does not turn
`active` off when a state closes, so a test stores `active` as it wants it. `platform.refuses`
returns why a save is refused. `platform.logs` holds each log line as `<level> <message>`, with
the app's prefix in the message, and `platform.warnings` holds the warnings.

### Documentation to change

ADR 0007 lists the jobs that use the runner:

```md
<!-- docs/adr/0007-chunked-jobs-with-persistent-cursors.md:9-13 -->
- Scheduled, with the cursor in `x_daas_ham_job_cursor` (`runTableJob`): installed-base
  reconciliation (`reconcile_installed_base`), in-service detection (`in_service_detection`), raw
  model normalization (`normalize_raw_models`), overdue return chasing (`chase_overdue_returns`) and
  spare-pool top-up (`spare_pool_top_up`). A cursor save the platform refuses is logged, and the
  next run repeats from the last saved cursor.
```

ADR 0013 describes the job's run lock:

```md
<!-- docs/adr/0013-margin-recomputes-supersede-under-a-job-lock.md:168-174 -->
The daily chase of overdue returns holds `overdue_returns_run` for the whole run, so a run and an
*Execute now* at once never both read a Return order as not escalated and notify its Customer
twice, nor both advance the job's one cursor. It holds no other lock when it takes it, does not
retry, and chases nothing when it finds it held. Under it, it declares each unit missing under that
unit's `receive_asset_` lock, with what that takes under it, so it comes before `receive_asset`. A
run ends on the job time budget (`x_daas_ham.job.budget_seconds`), well short of
`ABANDONED_AFTER_MINUTES`, so it does not check for a lost lock.
```

The spec lists what the daily job does under `- **Overdue** (daily):`. The list ends with this
sub-bullet, and the next bullet starts directly after it:

```md
<!-- docs/spec/p2-aftersales.md:181-185 -->
  - a line whose unit is neither at nor on its way to the Site nor missing (for example received at
    the depot while its line could not be saved), is in a stage the lifecycle does not move to
    missing, or is not a fleet asset (a line raised before the Fleet flag), is not declared missing,
    and no move is tried. It is logged on each run, to settle by hand.
- Fees use the Agreement's lost / late / damage amounts. A zero amount records nothing. Each fee type
```

### Conventions that apply (README.md "Development", AGENTS.md)

- A test is a `*.test.ts` file beside the module it tests. A platform test runs against
  `src/server/test-support/fake-glide.ts`, which throws `fake Glide: ...` on anything it does not
  know and runs no business rule.
- A relative import in `src/server` names the `.ts` file (`./clock.ts`). ESLint enforces it.
- `src/server/domain/` is pure. `JOB` lives there. A job's cursor row is named in `JOB`, once
  (ADR 0007), and installed instances hold the rows, so a name is never changed later.
- `npx vitest run <path>` needs no build. `npm test` and `npm run check` do.
- `npm run build` rewrites the tracked file `src/fluent/generated/keys.ts`. This plan changes no
  Fluent file, so the build must leave it unchanged.
- Comments only for a non-obvious why. Use the words of `CONTEXT.md`: Return order, Asset,
  Customer, Site.
- When documented behaviour changes, the matching ADR and spec lines change in the same commit.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Lint | `npm run lint` | exit 0 |
| This plan's tests | `npx vitest run src/server/platform/returns.test.ts src/server/domain/chunked-job.test.ts` | all pass |
| Build | `npm run build` | exit 0; rewrites `dist/` |
| Full gate | `npm run check` | exit 0; all tests pass |

## Scope

**In scope** (the only files you should modify):

- `src/server/domain/chunked-job.ts` (one name added to `JOB`)
- `src/server/platform/returns.ts` (one import, `chaseOverdue`'s doc comment, one line in
  `chaseHolding`, one new function with its constant, and `closeReturnIfDone`)
- `src/server/platform/returns.test.ts` (one `describe` added at the end)
- `docs/adr/0007-chunked-jobs-with-persistent-cursors.md` (the *Scheduled* bullet only)
- `docs/adr/0013-margin-recomputes-supersede-under-a-job-lock.md` (the paragraph on the daily
  chase only)
- `docs/spec/p2-aftersales.md` (one sub-bullet added)

**Out of scope** (do NOT touch, even though they look related):

- `src/server/platform/scheduled-returns.ts` and its test. Plan 038 owns them, and this plan does
  not use its page helper.
- `src/server/domain/lock-names.ts`. No lock is added.
- `src/server/platform/customer-page.ts`. `openReturns` keeps listing every active Return order.
- `src/fluent/returns/logic.now.ts` and every other Fluent file. The scheduled script stays wired
  to `chaseOverdue` with no arguments, and the cursor row is created by the code on first use.
- `fillReturn`, `requestProducedReturn` and the create ACLs. The cases stay possible. This plan
  closes what they leave.
- The wording of the warning `Return ... not closed, close it`.
- `src/server/platform/job-cursor.ts`. Its doc comment lists only the cursor rows that are not a
  scheduled pass. The new row is a scheduled pass.
- `docs/verify-on-instance.md`. See "Maintenance notes" for the instance check that is deferred.

## Git workflow

- Branch: `advisor/045-close-empty-return-orders`, from `main`.
- One commit. Subject in the repo's style, an imperative sentence under 72 characters, for example
  `Close the open Return orders that no line keeps open`. The body says what was wrong and why (a
  Return order with no line, or one whose close was refused, stayed open for good and stayed on
  the customer page).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Branch and confirm the baseline

```sh
git checkout main && git checkout -b advisor/045-close-empty-return-orders
npx vitest run src/server/platform/returns.test.ts src/server/domain/chunked-job.test.ts
npm run check
```

**Verify**: the first run passes with 0 failed. Write down the number of tests of
`returns.test.ts` as N (13 once plan 032 landed, 9 at the planned-at commit). The tests of
`chunked-job.test.ts` are 47. `npm run check` exits 0. Write down the total on its `Tests` line as
BASE. `git status --short` prints nothing afterwards.

### Step 2: Name the job-cursor row

In `src/server/domain/chunked-job.ts`, insert this line in `JOB`, directly after the
`chaseOverdueReturns` line:

```ts
    closeDoneReturns: 'close_done_returns',
```

**Verify**: `npx vitest run src/server/domain/chunked-job.test.ts` → 47 passed.

### Step 3: Write the failing tests

Append this block to the end of `src/server/platform/returns.test.ts`, after one blank line. Add
no import: everything it uses is imported or declared at the top of the file already.

```ts
describe('a Return order left open that no line keeps open', () => {
    const CLOSED = '3'
    const leftOpen = (fields: Row = {}): Row => ({ sys_id: 'retB', number: 'RET0009', customer: 'acme', site: 'site1', active: 'true', state: '1', sys_created_on: '2026-11-09 08:00:00', ...fields })
    const line = (sysId: string, status: string): Row => ({ sys_id: sysId, return_order: 'retB', asset: 'a1', status })
    const stateOf = (sysId: string) => rows(RETURNS).find((stored) => stored.sys_id === sysId)?.state

    beforeEach(() => {
        platform.references = { [`${RETURN_LINES}.return_order`]: RETURNS, [`${RETURNS}.agreement`]: 'x_daas_ham_agreement' }
        platform.clock = Date.parse('2026-11-11T05:20:00Z')
        platform.tables[RETURNS] = [leftOpen()]
        platform.tables[RETURN_LINES] = []
    })

    it('is closed by the daily job when it has no line, with a work note, and logged', () => {
        chaseOverdue()

        expect(rows(RETURNS)[0]).toMatchObject({ state: CLOSED, work_notes: 'Closed by the daily job: no unit on it is awaited or being evaluated.' })
        expect(platform.logs).toEqual([expect.stringContaining('Return RET0009 closed by the daily job: no line keeps it open')])
        expect(rows(LOCKS)).toEqual([])
    })

    it('is closed when its lines are all evaluated or missing: a close refused as the last one was settled', () => {
        platform.tables[RETURN_LINES] = [line('line1', 'evaluated'), line('line2', 'missing')]

        chaseOverdue()

        expect(stateOf('retB')).toBe(CLOSED)
    })

    it.each(['awaiting', 'received'])('stays open while a line of it is %s', (status) => {
        platform.tables[RETURNS] = [leftOpen({ due_back: '2026-12-01' })]
        platform.tables[RETURN_LINES] = [line('line1', 'evaluated'), line('line2', status)]

        chaseOverdue()

        expect(stateOf('retB')).toBe('1')
        expect(platform.logs).toEqual([])
    })

    it('stays open for a day after it was created: its lines may still be added by hand', () => {
        platform.tables[RETURNS] = [leftOpen({ sys_created_on: '2026-11-10 05:20:00' })]

        chaseOverdue()

        expect(stateOf('retB')).toBe('1')

        platform.clock += 1000
        chaseOverdue()

        expect(stateOf('retB')).toBe(CLOSED)
    })

    it('is left as it is once closed by hand', () => {
        platform.tables[RETURNS] = [leftOpen({ active: 'false', state: '4' })]

        chaseOverdue()

        expect(stateOf('retB')).toBe('4')
        expect(platform.logs).toEqual([])
    })

    it('is warned about when the platform refuses the close, and closed by a later run', () => {
        platform.refuses = (table) => (table === RETURNS ? 'closing needs close notes' : '')

        chaseOverdue()

        expect(stateOf('retB')).toBe('1')
        expect(platform.warnings).toEqual([expect.stringContaining('Return RET0009 not closed, close it: closing needs close notes')])

        platform.refuses = () => ''
        chaseOverdue()

        expect(stateOf('retB')).toBe(CLOSED)
    })

    it('closes nothing while another run holds the run lock', () => {
        const other = withLock(LOCK.overdueReturnsRun(), () => chaseOverdue())

        expect(other.ran).toBe(true)
        expect(stateOf('retB')).toBe('1')
    })
})
```

What the block sets up. One Return order `RET0009`, active, in state 1 (open), created on
2026-11-09 08:00 UTC. The clock is at 2026-11-11 05:20 UTC, the job's hour two days later. Each
test changes the lines, the creation time or the state, runs the job with `chaseOverdue()` and
reads the state back. State `'3'` is closed complete.

**Verify**: `npx vitest run src/server/platform/returns.test.ts` → `4 failed | N+4 passed`
(`4 failed | 17 passed (21)` once plan 032 landed). The four failures are exactly these new tests,
each because the Return order is still in state `'1'` or no warning was logged:

- `is closed by the daily job when it has no line, with a work note, and logged`
- `is closed when its lines are all evaluated or missing: a close refused as the last one was settled`
- `stays open for a day after it was created: its lines may still be added by hand`
- `is warned about when the platform refuses the close, and closed by a later run`

The other four new tests pass already: they hold what the pass must leave alone. If the set of
failures differs, STOP.

### Step 4: Add the pass to the job

Edit `src/server/platform/returns.ts`. Five changes, each found by its text.

**4a.** Change the clock import to:

```ts
import { daysAgoGlide, nowGlide, todayIso } from './clock.ts'
```

**4b.** In the doc comment of `chaseOverdue`, replace its last two lines:

```ts
 * it held chases nothing and logs so. Taking the lock throws only when an insert is refused with no lock row
 * (platform/locks): that error escapes.
 */
```

with:

```ts
 * it held chases nothing and logs so. Taking the lock throws only when an insert is refused with no lock row
 * (platform/locks): that error escapes. Under the same lock the run then closes the Return orders that no line keeps
 * open (`closeDoneReturns`).
 */
```

**4c.** At the end of `chaseHolding`, call the new pass after the `runTableJob({ ... })` call, and
add the new function and its constant directly after `chaseHolding`. These lines:

```ts
            } else if (step === 'declare_missing') {
                declareMissing({ lineId, assetId: line.assetId, returnOrderId: line.returnOrderId, number })
            }
        },
    })
}
```

become:

```ts
            } else if (step === 'declare_missing') {
                declareMissing({ lineId, assetId: line.assetId, returnOrderId: line.returnOrderId, number })
            }
        },
    })
    closeDoneReturns()
}

/** A Return order this new is not closed for having no line: one inserted by hand may still get its lines. */
const DONE_RETURN_GRACE_DAYS = 1

/**
 * Close the open Return orders that no line keeps open (the daily job, after its chase and under its run lock). A
 * Return is closed as its last line is evaluated or declared missing (`closeReturnIfDone`) and nothing looks at it
 * again, so two kinds would stay open for good, asking the Customer for equipment they do not await: one whose close
 * the platform refused then, and one that never had a line (inserted by hand, or raised with no unit when its close
 * or its removal was refused). A second pass of the job (ADR 0007), with a cursor of its own: it reads every open
 * Return order, as no query can ask for those without a line.
 */
function closeDoneReturns(): void {
    runTableJob({
        job: JOB.closeDoneReturns,
        table: RETURN,
        query: `active=true^sys_created_on<${daysAgoGlide(DONE_RETURN_GRACE_DAYS)}`,
        read: (returnOrder) => str(returnOrder, 'number'),
        handle: (number, returnOrderId) => {
            const note = 'Closed by the daily job: no unit on it is awaited or being evaluated.'
            if (closeReturnIfDone(returnOrderId, note)) log.info(`Return ${number} closed by the daily job: no line keeps it open`)
        },
    })
}
```

**4d.** Replace the whole of `closeReturnIfDone` (quoted under "Where a Return order is closed
today") with:

```ts
/** Close the Return order once no line keeps it open, with `note` as its work note when given. True when this call closed it. */
function closeReturnIfDone(returnOrderId: string, note = ''): boolean {
    if (exists(RETURN_LINE, `return_order=${returnOrderId}^statusIN${KEEPS_RETURN_OPEN.join(',')}`)) return false
    const order = findById(RETURN, returnOrderId)
    if (!order || str(order, 'state') === String(TASK_STATE.closedComplete)) return false
    order.setValue('state', TASK_STATE.closedComplete)
    if (note) order.setValue('work_notes', note)
    if (order.update()) return true
    // No later line calls this again: the daily job closes it (`closeDoneReturns`), and warns again while it is refused.
    warnRefused(order, `Return ${str(order, 'number')} not closed, close it`)
    return false
}
```

**4e.** Change nothing at the two existing calls of `closeReturnIfDone` (in `evaluateReturnLine`
and `declareMissing`). They pass no note and ignore the result, as before.

Notes for your own check of the result:

- `JOB`, `RETURN`, `runTableJob`, `str`, `log`, `exists`, `findById`, `warnRefused` and
  `TASK_STATE` are all imported or declared in `returns.ts` already. Only `daysAgoGlide` is new.
- The pass runs inside `chaseHolding`, so it runs only while the run holds `overdue_returns_run`.
- The query selects on `active` and the creation time only. Whether a line keeps the Return order
  open is decided by `closeReturnIfDone`, for each one.

**Verify**:

- `npx vitest run src/server/platform/returns.test.ts src/server/domain/chunked-job.test.ts`
  → N+8 and 47 passed, 0 failed (`Tests  68 passed (68)` once plan 032 landed).
- `grep -c "closeDoneReturns" src/server/platform/returns.ts` → `5`.
- `grep -c "closeReturnIfDone(" src/server/platform/returns.ts` → `4` (its definition and three
  calls).
- `npm run typecheck` → exit 0. `npm run lint` → exit 0.

### Step 5: Document the pass

In `docs/adr/0007-chunked-jobs-with-persistent-cursors.md`, replace the five lines of the
*Scheduled* bullet (quoted under "Documentation to change") with:

```md
- Scheduled, with the cursor in `x_daas_ham_job_cursor` (`runTableJob`): installed-base
  reconciliation (`reconcile_installed_base`), in-service detection (`in_service_detection`), raw
  model normalization (`normalize_raw_models`), overdue return chasing (`chase_overdue_returns`),
  the close of the Return orders no line keeps open (`close_done_returns`, a second pass of the
  same daily job) and spare-pool top-up (`spare_pool_top_up`). A cursor save the platform refuses
  is logged, and the next run repeats from the last saved cursor.
```

In `docs/adr/0013-margin-recomputes-supersede-under-a-job-lock.md`, replace the last five of the
seven lines quoted under "Documentation to change" (from `twice, nor both advance the job's one
cursor.` to `` `ABANDONED_AFTER_MINUTES`, so it does not check for a lost lock. ``) with:

```md
twice, nor both advance the job's cursors. It holds no other lock when it takes it, does not
retry, and chases nothing when it finds it held. Under it, it declares each unit missing under that
unit's `receive_asset_` lock, with what that takes under it, so it comes before `receive_asset`. A
run makes two passes under it: the chase, then the close of the Return orders no line keeps open,
which takes no other lock. Each pass ends on the job time budget
(`x_daas_ham.job.budget_seconds`), so a run takes at most twice that, well short of
`ABANDONED_AFTER_MINUTES` as shipped, and does not check for a lost lock.
```

In `docs/spec/p2-aftersales.md`, insert this sub-bullet directly after the line
`    and no move is tried. It is logged on each run, to settle by hand.` and before the bullet that
starts `- Fees use the Agreement's lost / late / damage amounts.`:

```md
  - after the chase, the same run closes each open Return order, created more than a day ago, that
    no line keeps open (`platform/returns.ts` `closeDoneReturns`): one with no line at all
    (inserted by hand, or raised with no unit when its close or its removal was refused), and one
    whose lines are all evaluated or missing but whose close was refused then. It gets a work
    note, and the close is logged. One created within the last day is left, as its lines may still
    be added by hand. A close the platform refuses is logged as a warning and tried again by the
    next run. The pass keeps a job cursor of its own (`close_done_returns`, ADR 0007).
```

**Verify**:

- `grep -c "close_done_returns" docs/adr/0007-chunked-jobs-with-persistent-cursors.md docs/spec/p2-aftersales.md`
  prints `1` for each file.
- `grep -c "the job's one cursor" docs/adr/0013-margin-recomputes-supersede-under-a-job-lock.md` → `0`.
- `grep -c "run makes two passes under it" docs/adr/0013-margin-recomputes-supersede-under-a-job-lock.md` → `1`.

### Step 6: Run the full gate and commit

```sh
npm run check
git status --short
```

**Verify**: `npm run check` exits 0 and its `Tests` line reads BASE plus 8. `git status --short`
lists only the six in-scope files. If `src/fluent/generated/keys.ts` shows as modified, see the
STOP conditions.

Commit the six files in one commit, with the subject from "Git workflow" and a body that says what
was wrong and why.

## Test plan

- `src/server/platform/returns.test.ts`, one `describe` with 8 tests, in the style of that file's
  `the daily chase of overdue returns` and on its helpers:
  - an open Return order with no line, two days old: closed, with the work note, one info line
    logged, the run lock released. This is the regression test for the finding;
  - one whose lines are all evaluated or missing: closed;
  - one with a line still awaiting, and one with a line received (two cases): left open, nothing
    logged;
  - one created exactly a day ago: left open. A second later it is closed;
  - one closed by hand (inactive, closed incomplete): left as it is;
  - a close the platform refuses: left open with the warning
    `Return RET0009 not closed, close it: closing needs close notes`, and closed by the next run
    once the refusal is lifted;
  - another run holds `overdue_returns_run`: nothing is closed.
- The existing tests of the file stay unchanged and must pass.
- `src/server/domain/chunked-job.test.ts` is unchanged. Its `JOB` test holds that the new name is
  no duplicate.
- Verification: `npx vitest run src/server/platform/returns.test.ts src/server/domain/chunked-job.test.ts`
  → N+8 and 47 passed, 0 failed.

What the tests cannot show. The fake runs no business rule, so it does not turn `active` off when
a Return order closes: the tests store `active` by hand. On an instance the platform does that for
every task, and the customer page already depends on it. The fake compares `sys_created_on` with
the cutoff as text, which orders UTC date-times correctly. The job locks use the same kind of
query on an instance.

ATF and instance checks: ATF runs on an instance only, and no ATF test covers this pass (a test
record cannot be made a day old). The instance check is in "Maintenance notes". It is optional for
handing the work back. Say in your report that it was not run.

## Done criteria

ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm run lint` exits 0
- [ ] The test command in the test plan reports N+8 and 47 passed, 0 failed
- [ ] `npm run check` exits 0 with BASE plus 8 tests passed
- [ ] `grep -c "closeDoneReturns: 'close_done_returns'" src/server/domain/chunked-job.ts` prints `1`
- [ ] `grep -c "closeDoneReturns" src/server/platform/returns.ts` prints `5`
- [ ] `grep -c "close_done_returns" docs/adr/0007-chunked-jobs-with-persistent-cursors.md` prints `1`
- [ ] `git diff --stat main..HEAD -- src/fluent src/server/domain/lock-names.ts src/server/platform/scheduled-returns.ts src/server/platform/customer-page.ts src/server/test-support` prints nothing
- [ ] `git status --short` is empty and only the six in-scope files differ from `main`
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `closeReturnIfDone`, the end of `chaseHolding` or the clock import in `returns.ts` does not
  match the excerpts under "Current state" (line numbers aside).
- `JOB` already has a row for closing Return orders, or something already closes a Return order
  outside `fillReturn` and `closeReturnIfDone`
  (`grep -n "TASK_STATE.closedComplete" src/server/platform/returns.ts` shows more than the three
  lines in those two functions).
- `chaseOverdue` no longer holds `LOCK.overdueReturnsRun()` around `chaseHolding`. The new pass
  relies on that lock for its cursor.
- Step 3 gives a different set of failing tests than the four listed.
- After step 4, an existing test of `returns.test.ts` fails. The chase itself must not have
  changed.
- A test fails with a message that starts with `fake Glide:`. Report the message. Do not extend
  `fake-glide.ts` under this plan.
- The change seems to need a new lock, an export from `returns.ts`, or a change in `src/fluent`.
- `npm run build` leaves `src/fluent/generated/keys.ts` modified. Report the diff.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- The pass reads every open Return order older than a day on each cycle, and makes one small query
  for each. It stops on the job time budget and goes on the next day, so with very many open
  Return orders a cycle can take more than one run. *Job cursor* shows the row
  `close_done_returns` like any scheduled pass.
- A run now makes two passes under `overdue_returns_run`, each with the full job time budget. With
  the budget as shipped (120 seconds) a run takes at most four minutes, under the ten after which
  a lock is taken as abandoned. If `x_daas_ham.job.budget_seconds` is raised to 300 or more, the
  two passes together can outlast the lock, and the run does not check for that.
- The grace period counts from the Return order's creation. Staff who insert a Return order by
  hand and add its first line more than a day later find it closed, with the work note that says
  why, and reopen it. Raise `DONE_RETURN_GRACE_DAYS` if that happens in practice.
- No lock ties the close to a line added at the same moment. A line inserted by hand in the
  instant between the pass's check and its save lands on a Return order that is then closed. The
  line is still chased when overdue, as the chase reads lines, not the Return order's state.
  Likewise a missing unit that is scanned in at that instant reopens the Return order just before
  the pass closes it. Both need a Return order that was already left open wrongly and a write in
  the same moment, and both are put right by reopening the Return order.
- The query selects on `active`. A Return order closed by hand as incomplete or skipped is
  inactive and is left alone, which a test holds. If a change ever leaves closed Return orders
  active, the pass would set those closed by hand to closed complete: `closeReturnIfDone` only
  skips the ones that are closed complete already.
- A close refused every day logs `Return ... not closed, close it` every day. That is on purpose:
  the Return order still shows as open to the Customer.
- Plan 032's maintenance note says a customer admin's hand-made Return order with no line stays
  saved. It still does, for a day, and is then closed by this pass.
- A reviewer should check three things: the pass is called inside `chaseHolding` (under the run
  lock), the two existing calls of `closeReturnIfDone` are unchanged, and the query's cutoff is
  `daysAgoGlide(DONE_RETURN_GRACE_DAYS)`.
- Deferred: an instance check, with a line for it in `docs/verify-on-instance.md`. Insert a Return
  order by hand, set its *Created* back two days with a background script, run *NaaS - chase
  overdue returns* with *Execute now*, and see the Return order closed with the work note, gone
  from the customer page, and a row `close_done_returns` in *Job cursor*. It is deferred because
  several other open plans edit that file.
- Deferred: ADR 0007 could list this pass under the jobs' time budgets in more detail. The one
  clause added here is enough for now.
